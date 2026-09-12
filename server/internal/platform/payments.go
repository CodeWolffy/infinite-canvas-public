package platform

import (
	"context"
	"encoding/json"
	"errors"
	"net/url"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/redis/go-redis/v9"
	"github.com/shopspring/decimal"
)

type PaymentConfig struct {
	BaseURL     string `json:"baseUrl"`
	PartnerID   string `json:"partnerId"`
	Key         string `json:"key"`
	AppID       string `json:"appId"`
	SellerID    string `json:"sellerId"`
	PrivateKey  string `json:"privateKey"`
	PublicKey   string `json:"publicKey"`
	MchID       string `json:"mchId"`
	SerialNo    string `json:"serialNo"`
	PublicKeyID string `json:"publicKeyId"`
	APIV3Key    string `json:"apiV3Key"`
}
type PaymentResult struct {
	Paid, Closed                   bool
	TradeNo, MerchantOrder, Method string
	AmountCents                    int64
}

var paymentSecrets = map[string]bool{"key": true, "privateKey": true, "apiV3Key": true}
var releaseRedisLock = redis.NewScript(`if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) end return 0`)

func merchantOrder(id string) string { return strings.ReplaceAll(id, "-", "") }
func orderAmount(row Row) string {
	return decimal.NewFromInt(integer(row["amountCents"])).Div(decimal.NewFromInt(100)).StringFixed(2)
}
func publicOrder(row Row) Row {
	return Row{"id": row["id"], "channelId": row["channelId"], "provider": row["provider"], "method": row["method"], "amount": orderAmount(row), "status": row["status"], "paymentUrl": row["paymentUrl"], "expiresAt": row["expiresAt"], "paidAt": row["paidAt"], "createdAt": row["createdAt"]}
}
func (a *App) paymentConfig(ciphertext string) (PaymentConfig, error) {
	var config PaymentConfig
	raw, err := a.unseal(ciphertext)
	if err != nil {
		return config, err
	}
	err = json.Unmarshal([]byte(raw), &config)
	return config, err
}

func (a *App) createPaymentOrder(c *gin.Context) (any, error) {
	input, err := body[struct {
		ChannelID string `json:"channelId" binding:"required,uuid"`
		Method    string `json:"method" binding:"required,oneof=alipay wxpay"`
		Amount    string `json:"amount" binding:"required"`
		RequestID string `json:"requestId" binding:"required,uuid"`
	}](c)
	if err != nil {
		return nil, err
	}
	cents, err := amountUnits(input.Amount, 100)
	if err != nil {
		return nil, err
	}
	if cents <= 0 || cents > (1<<63-1)/10000 {
		return nil, problem(400, "invalid_amount", "请输入有效的充值金额，精确到分")
	}
	ctx := c.Request.Context()
	u := currentUser(c)
	requestKey := uuid.MustParse(input.RequestID).String()
	channelID := uuid.MustParse(input.ChannelID).String()
	digest := hash(channelID + ":" + input.Method + ":" + str(cents))
	var order Row
	err = pgx.BeginFunc(ctx, a.DB, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, "SELECT pg_advisory_xact_lock(hashtextextended($1,0))", "order:"+u.ID+":"+requestKey); err != nil {
			return err
		}
		existing, err := one(ctx, tx, "SELECT * FROM payment_orders WHERE user_id=$1 AND request_key=$2", u.ID, requestKey)
		if err == nil {
			if existing["requestHash"] != digest {
				return problem(409, "idempotency_conflict", "同一请求编号不能创建不同的充值订单")
			}
			order = existing
			return nil
		}
		if !errors.Is(err, notFound) {
			return err
		}
		channel, err := one(ctx, tx, "SELECT * FROM payment_channels WHERE id=$1 AND enabled AND $2=ANY(methods)", channelID, input.Method)
		if err != nil {
			return problem(400, "payment_unavailable", "该充值渠道暂不可用")
		}
		settings, err := a.settings(ctx, tx)
		if err != nil {
			return err
		}
		expires := time.Now().Add(time.Duration(settings.PaymentOrderMinutes) * time.Minute)
		order, err = one(ctx, tx, "INSERT INTO payment_orders(user_id,channel_id,method,amount_cents,encrypted_config,provider,request_key,request_hash,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *", u.ID, channelID, input.Method, cents, channel["encryptedConfig"], channel["provider"], requestKey, digest, expires)
		return err
	})
	if err != nil {
		return nil, err
	}
	if order["status"] != "pending" || str(order["paymentUrl"]) != "" {
		return gin.H{"order": publicOrder(order)}, nil
	}
	expires := order["expiresAt"].(time.Time)
	if !expires.After(time.Now()) {
		return nil, problem(409, "order_expired", "订单已过期，请刷新订单状态")
	}
	lockKey, token := "ic:payment:create:"+str(order["id"]), uuid.NewString()
	locked, err := a.Redis.SetNX(ctx, lockKey, token, time.Until(expires)).Result()
	if err != nil {
		return nil, problem(503, "payment_unavailable", "充值服务暂时不可用")
	}
	if !locked {
		return nil, problem(409, "order_processing", "订单正在创建，请稍后查看订单")
	}
	defer releaseRedisLock.Run(context.Background(), a.Redis, []string{lockKey}, token)
	config, err := a.paymentConfig(str(order["encryptedConfig"]))
	if err != nil {
		return nil, err
	}
	paymentURL, err := a.startPayment(ctx, order, config)
	if err != nil {
		return nil, problem(502, "payment_pending", "支付平台未确认创建结果，请保留此订单并刷新状态")
	}
	if _, err = a.DB.Exec(ctx, "UPDATE payment_orders SET payment_url=$2 WHERE id=$1 AND status='pending'", order["id"], paymentURL); err != nil {
		return nil, err
	}
	order["paymentUrl"] = paymentURL
	return gin.H{"order": publicOrder(order)}, nil
}
func (a *App) getPaymentOrder(c *gin.Context) (any, error) {
	id, err := idParam(c, "id")
	if err != nil {
		return nil, err
	}
	order, err := one(c.Request.Context(), a.DB, "SELECT * FROM payment_orders WHERE id=$1 AND user_id=$2", id, currentUser(c).ID)
	if err != nil {
		return nil, err
	}
	return gin.H{"order": publicOrder(order)}, nil
}
func (a *App) refreshPaymentOrder(c *gin.Context) (any, error) {
	id, err := idParam(c, "id")
	if err != nil {
		return nil, err
	}
	ctx := c.Request.Context()
	order, err := one(ctx, a.DB, "SELECT * FROM payment_orders WHERE id=$1 AND user_id=$2", id, currentUser(c).ID)
	if err != nil {
		return nil, err
	}
	if order["status"] == "pending" {
		if err := a.reconcilePayment(ctx, order); err != nil {
			return nil, problem(502, "payment_query_failed", "暂时无法确认支付状态，订单会保留，请稍后刷新")
		}
	}
	return a.getPaymentOrder(c)
}

func (a *App) creditPayment(ctx context.Context, id string, result PaymentResult) error {
	if !result.Paid || result.TradeNo == "" {
		return problem(400, "invalid_payment", "支付结果未确认")
	}
	return pgx.BeginFunc(ctx, a.DB, func(tx pgx.Tx) error {
		order, err := one(ctx, tx, "SELECT * FROM payment_orders WHERE id=$1 FOR UPDATE", id)
		if err != nil {
			return err
		}
		if result.MerchantOrder != merchantOrder(id) || result.AmountCents != integer(order["amountCents"]) || result.Method != str(order["method"]) {
			return problem(400, "payment_mismatch", "支付通知与订单不匹配")
		}
		if order["status"] == "paid" {
			if order["tradeNo"] != result.TradeNo {
				return problem(409, "payment_mismatch", "支付交易号不匹配")
			}
			return nil
		}
		// 已本地关闭的易支付订单仍可能收到真实支付；验签确认后照常入账，绝不吞掉迟到款项。
		credited, err := changeWallet(ctx, tx, str(order["userId"]), "recharge", id, result.AmountCents*10000, 0, "余额充值")
		if err != nil {
			return err
		}
		if _, err = tx.Exec(ctx, "UPDATE payment_orders SET status='paid',trade_no=$2,paid_at=now() WHERE id=$1", id, result.TradeNo); err != nil {
			return err
		}
		if !credited {
			return nil
		}
		if err = a.creditReferral(ctx, tx, str(order["userId"]), id, result.AmountCents*10000); err != nil {
			return err
		}
		return a.notifyCredit(ctx, tx, str(order["userId"]), "recharge", result.AmountCents*10000)
	})
}
func (a *App) reconcilePayment(ctx context.Context, order Row) error {
	config, err := a.paymentConfig(str(order["encryptedConfig"]))
	if err != nil {
		return err
	}
	result, err := a.queryPayment(ctx, order, config)
	if err != nil {
		return err
	}
	if result.Paid {
		return a.creditPayment(ctx, str(order["id"]), result)
	}
	if result.Closed || !order["expiresAt"].(time.Time).After(time.Now()) {
		if !result.Closed {
			if err = a.closePayment(ctx, order, config); err != nil {
				return err
			}
		}
		_, err = a.DB.Exec(ctx, "UPDATE payment_orders SET status='closed' WHERE id=$1 AND status='pending'", order["id"])
		return err
	}
	return nil
}

func (a *App) paymentCallbacks(r *gin.Engine) {
	handler := func(c *gin.Context) {
		id, err := idParam(c, "id")
		if err != nil {
			fail(c, err)
			return
		}
		ctx := c.Request.Context()
		order, err := one(ctx, a.DB, "SELECT * FROM payment_orders WHERE id=$1", id)
		if err != nil {
			fail(c, err)
			return
		}
		config, err := a.paymentConfig(str(order["encryptedConfig"]))
		if err != nil {
			fail(c, err)
			return
		}
		result, err := a.verifyPayment(c, order, config)
		if err != nil {
			c.String(400, "failure")
			return
		}
		if result.Paid {
			if err = a.creditPayment(ctx, id, result); err != nil {
				c.String(500, "failure")
				return
			}
		}
		if order["provider"] == "wechat" {
			c.JSON(200, gin.H{"code": "SUCCESS", "message": "成功"})
			return
		}
		c.String(200, "success")
	}
	r.GET("/api/payments/notify/:id", handler)
	r.POST("/api/payments/notify/:id", handler)
}

func (a *App) paymentAdminRoutes(admin *gin.RouterGroup) {
	admin.GET("/payment-channels", respond(func(c *gin.Context) (any, error) {
		items, err := rows(c.Request.Context(), a.DB, "SELECT * FROM payment_channels ORDER BY created_at")
		if err != nil {
			return nil, err
		}
		for _, row := range items {
			config, err := a.paymentConfig(str(row["encryptedConfig"]))
			if err != nil {
				return nil, err
			}
			var fields Row
			_ = json.Unmarshal(jsonBytes(config), &fields)
			configured := []string{}
			for key := range paymentSecrets {
				if str(fields[key]) != "" {
					configured = append(configured, key)
				}
				delete(fields, key)
			}
			delete(row, "encryptedConfig")
			row["config"] = fields
			row["configuredSecrets"] = configured
		}
		return gin.H{"channels": items}, nil
	}))
	save := respond(func(c *gin.Context) (any, error) {
		input, err := body[struct {
			Name     string            `json:"name" binding:"required"`
			Provider string            `json:"provider" binding:"required,oneof=epay alipay wechat"`
			Methods  []string          `json:"methods" binding:"required,min=1,dive,oneof=alipay wxpay"`
			Enabled  bool              `json:"enabled"`
			Config   map[string]string `json:"config"`
		}](c)
		if err != nil {
			return nil, err
		}
		ctx := c.Request.Context()
		id := c.Param("id")
		if id == "" {
			id = uuid.NewString()
		} else {
			if !validID(id) {
				return nil, problem(400, "invalid_id", "渠道编号不正确")
			}
		}
		for _, method := range input.Methods {
			if input.Provider == "alipay" && method != "alipay" || input.Provider == "wechat" && method != "wxpay" {
				return nil, problem(400, "invalid_method", "支付方式与渠道不匹配")
			}
		}
		err = pgx.BeginFunc(ctx, a.DB, func(tx pgx.Tx) error {
			merged := map[string]string{}
			if c.Param("id") != "" {
				existing, err := one(ctx, tx, "SELECT * FROM payment_channels WHERE id=$1 FOR UPDATE", id)
				if err != nil {
					return err
				}
				if existing["provider"] != input.Provider {
					return problem(400, "provider_immutable", "修改支付平台类型请新建渠道")
				}
				config, err := a.paymentConfig(str(existing["encryptedConfig"]))
				if err != nil {
					return err
				}
				_ = json.Unmarshal(jsonBytes(config), &merged)
			}
			for key, value := range input.Config {
				if value != "" || !paymentSecrets[key] {
					merged[key] = value
				}
			}
			var config PaymentConfig
			if err := json.Unmarshal(jsonBytes(merged), &config); err != nil {
				return err
			}
			if err := a.validatePaymentConfig(input.Provider, config); err != nil {
				return err
			}
			if input.Enabled && !strings.HasPrefix(a.Config.PublicURL, "https://") {
				return problem(400, "https_required", "启用真实支付前请配置公网 HTTPS 站点地址")
			}
			sealed, err := a.seal(string(jsonBytes(config)))
			if err != nil {
				return err
			}
			_, err = tx.Exec(ctx, "INSERT INTO payment_channels(id,name,provider,methods,enabled,encrypted_config) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(id) DO UPDATE SET name=excluded.name,methods=excluded.methods,enabled=excluded.enabled,encrypted_config=excluded.encrypted_config,updated_at=now()", id, input.Name, input.Provider, input.Methods, input.Enabled, sealed)
			if err != nil {
				return err
			}
			return a.audit(ctx, tx, currentUser(c).ID, "payment-channel.save", id, gin.H{"name": input.Name, "provider": input.Provider, "enabled": input.Enabled})
		})
		return gin.H{"id": id}, err
	})
	admin.POST("/payment-channels", save)
	admin.PUT("/payment-channels/:id", save)
	admin.GET("/payment-orders", respond(func(c *gin.Context) (any, error) {
		limit, offset := pagination(c)
		status := c.Query("status")
		items, err := rows(c.Request.Context(), a.DB, "SELECT p.id,p.channel_id,p.provider,p.method,p.amount_cents,p.status,p.trade_no,p.expires_at,p.paid_at,p.created_at,u.username,u.display_name FROM payment_orders p JOIN users u ON u.id=p.user_id WHERE ($1='' OR p.status=$1) ORDER BY p.created_at DESC LIMIT $2 OFFSET $3", status, limit, offset)
		for _, row := range items {
			row["amount"] = orderAmount(row)
			delete(row, "amountCents")
		}
		return gin.H{"orders": items}, err
	}))
	admin.POST("/payment-orders/:id/reconcile", respond(func(c *gin.Context) (any, error) {
		id, err := idParam(c, "id")
		if err != nil {
			return nil, err
		}
		ctx := c.Request.Context()
		order, err := one(ctx, a.DB, "SELECT * FROM payment_orders WHERE id=$1", id)
		if err != nil {
			return nil, err
		}
		if order["status"] != "paid" {
			if err = a.reconcilePayment(ctx, order); err != nil {
				return nil, problem(502, "payment_query_failed", "支付平台暂时无法确认订单，未修改余额")
			}
		}
		err = a.audit(ctx, a.DB, currentUser(c).ID, "payment.reconcile", id, gin.H{})
		return nil, err
	}))
}

func validateGateway(raw string) error {
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || u.Scheme != "https" {
		return problem(400, "invalid_gateway", "支付网关必须使用不含用户信息和查询参数的 HTTPS 地址")
	}
	return nil
}

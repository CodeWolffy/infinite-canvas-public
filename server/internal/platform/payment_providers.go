package platform

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/Calcium-Ion/go-epay/epay"
	"github.com/gin-gonic/gin"
	"github.com/smartwalle/alipay/v3"
	"github.com/wechatpay-apiv3/wechatpay-go/core"
	"github.com/wechatpay-apiv3/wechatpay-go/core/auth/verifiers"
	"github.com/wechatpay-apiv3/wechatpay-go/core/notify"
	"github.com/wechatpay-apiv3/wechatpay-go/core/option"
	"github.com/wechatpay-apiv3/wechatpay-go/services/payments"
	"github.com/wechatpay-apiv3/wechatpay-go/services/payments/native"
	"github.com/wechatpay-apiv3/wechatpay-go/utils"
)

func (a *App) alipayClient(config PaymentConfig) (*alipay.Client, error) {
	client, err := alipay.New(config.AppID, config.PrivateKey, true, alipay.WithHTTPClient(safeClient(false)))
	if err != nil {
		return nil, err
	}
	if err = client.LoadAliPayPublicKey(config.PublicKey); err != nil {
		return nil, err
	}
	return client, nil
}
func (a *App) wechatClient(ctx context.Context, config PaymentConfig) (*core.Client, *notify.Handler, error) {
	privateKey, err := utils.LoadPrivateKey(config.PrivateKey)
	if err != nil {
		return nil, nil, err
	}
	publicKey, err := utils.LoadPublicKey(config.PublicKey)
	if err != nil {
		return nil, nil, err
	}
	client, err := core.NewClient(ctx, option.WithWechatPayPublicKeyAuthCipher(config.MchID, config.SerialNo, privateKey, config.PublicKeyID, publicKey), option.WithHTTPClient(safeClient(false)))
	if err != nil {
		return nil, nil, err
	}
	handler, err := notify.NewRSANotifyHandler(config.APIV3Key, verifiers.NewSHA256WithRSAPubkeyVerifier(config.PublicKeyID, *publicKey))
	return client, handler, err
}
func (a *App) validatePaymentConfig(provider string, c PaymentConfig) error {
	bad := problem(400, "invalid_payment_config", "支付配置不完整或密钥格式不正确")
	switch provider {
	case "epay":
		if err := validateGateway(c.BaseURL); err != nil {
			return err
		}
		if c.PartnerID == "" || c.Key == "" {
			return bad
		}
	case "alipay":
		if c.AppID == "" || c.SellerID == "" {
			return bad
		}
		if _, err := a.alipayClient(c); err != nil {
			return bad
		}
	case "wechat":
		if c.AppID == "" || c.MchID == "" || c.SerialNo == "" || !strings.HasPrefix(c.PublicKeyID, "PUB_KEY_ID_") || len(c.APIV3Key) != 32 {
			return bad
		}
		if _, _, err := a.wechatClient(context.Background(), c); err != nil {
			return bad
		}
	default:
		return bad
	}
	return nil
}
func (a *App) startPayment(ctx context.Context, order Row, config PaymentConfig) (string, error) {
	id := str(order["id"])
	number := merchantOrder(id)
	callback := a.Config.PublicURL + "/api/payments/notify/" + id
	expires := order["expiresAt"].(time.Time)
	ctx, cancel := context.WithDeadline(ctx, expires)
	defer cancel()
	switch order["provider"] {
	case "epay":
		client, err := epay.NewClient(&epay.Config{PartnerID: config.PartnerID, Key: config.Key}, config.BaseURL)
		if err != nil {
			return "", err
		}
		notifyURL, _ := url.Parse(callback)
		returnURL, _ := url.Parse(a.Config.PublicURL + "/user/wallet?order=" + id)
		endpoint, params, err := client.Purchase(&epay.PurchaseArgs{Type: str(order["method"]), ServiceTradeNo: number, Name: "创作平台余额充值", Money: orderAmount(order), Device: epay.PC, NotifyUrl: notifyURL, ReturnUrl: returnURL})
		if err != nil {
			return "", err
		}
		values := url.Values{}
		for k, v := range params {
			values.Set(k, v)
		}
		return endpoint + "?" + values.Encode(), nil
	case "alipay":
		client, err := a.alipayClient(config)
		if err != nil {
			return "", err
		}
		zone, err := time.LoadLocation("Asia/Shanghai")
		if err != nil {
			return "", err
		}
		result, err := client.TradePreCreate(ctx, alipay.TradePreCreate{Trade: alipay.Trade{Subject: "创作平台余额充值", OutTradeNo: number, TotalAmount: orderAmount(order), ProductCode: "FACE_TO_FACE_PAYMENT", NotifyURL: callback, SellerId: config.SellerID, TimeExpire: expires.In(zone).Format("2006-01-02 15:04:05")}})
		if err != nil {
			return "", err
		}
		if !result.IsSuccess() || result.OutTradeNo != number || result.QRCode == "" {
			return "", errors.New("支付平台未确认预下单")
		}
		return result.QRCode, nil
	case "wechat":
		client, _, err := a.wechatClient(ctx, config)
		if err != nil {
			return "", err
		}
		service := native.NativeApiService{Client: client}
		result, _, err := service.Prepay(ctx, native.PrepayRequest{Appid: core.String(config.AppID), Mchid: core.String(config.MchID), Description: core.String("创作平台余额充值"), OutTradeNo: core.String(number), NotifyUrl: core.String(callback), TimeExpire: &expires, Amount: &native.Amount{Total: core.Int64(integer(order["amountCents"])), Currency: core.String("CNY")}})
		if err != nil {
			return "", err
		}
		if result.CodeUrl == nil || *result.CodeUrl == "" {
			return "", errors.New("缺少支付二维码")
		}
		return *result.CodeUrl, nil
	}
	return "", errors.New("不支持的支付平台")
}

func (a *App) queryPayment(ctx context.Context, order Row, config PaymentConfig) (PaymentResult, error) {
	number := merchantOrder(str(order["id"]))
	result := PaymentResult{MerchantOrder: number, Method: str(order["method"])}
	switch order["provider"] {
	case "epay":
		u, err := url.Parse(strings.TrimRight(config.BaseURL, "/") + "/api.php")
		if err != nil {
			return result, err
		}
		q := url.Values{"act": {"order"}, "pid": {config.PartnerID}, "key": {config.Key}, "out_trade_no": {number}}
		u.RawQuery = q.Encode()
		req, err := http.NewRequestWithContext(ctx, "GET", u.String(), nil)
		if err != nil {
			return result, err
		}
		response, err := safeClient(false).Do(req)
		if err != nil {
			return result, err
		}
		defer response.Body.Close()
		if response.StatusCode != 200 {
			return result, errors.New("易支付查单失败")
		}
		var data map[string]json.RawMessage
		raw, err := io.ReadAll(io.LimitReader(response.Body, a.Config.MaxGenerated+1))
		if err != nil {
			return result, err
		}
		if int64(len(raw)) > a.Config.MaxGenerated {
			return result, errors.New("支付响应过大")
		}
		if err = json.Unmarshal(raw, &data); err != nil {
			return result, err
		}
		read := func(key string) string {
			var text string
			if json.Unmarshal(data[key], &text) == nil {
				return text
			}
			return string(data[key])
		}
		if read("code") != "1" || read("out_trade_no") != number {
			return result, errors.New("易支付尚未确认此订单")
		}
		if read("pid") != "" && read("pid") != config.PartnerID {
			return result, errors.New("商户不匹配")
		}
		if read("type") != result.Method {
			return result, errors.New("支付方式不匹配")
		}
		result.AmountCents, err = amountUnits(read("money"), 100)
		if err != nil {
			return result, err
		}
		if result.AmountCents != integer(order["amountCents"]) {
			return result, errors.New("订单金额不匹配")
		}
		result.Paid = read("status") == "1"
		result.TradeNo = read("trade_no")
		return result, nil
	case "alipay":
		client, err := a.alipayClient(config)
		if err != nil {
			return result, err
		}
		data, err := client.TradeQuery(ctx, alipay.TradeQuery{OutTradeNo: number})
		if err != nil {
			return result, err
		}
		if !data.IsSuccess() {
			return result, errors.New("支付宝尚未确认此订单")
		}
		if data.OutTradeNo != number || data.TransCurrency != "" && data.TransCurrency != "CNY" {
			return result, errors.New("订单不匹配")
		}
		result.AmountCents, err = amountUnits(data.TotalAmount, 100)
		if err != nil {
			return result, err
		}
		result.TradeNo = data.TradeNo
		result.Paid = data.TradeStatus == alipay.TradeStatusSuccess || data.TradeStatus == alipay.TradeStatusFinished
		result.Closed = data.TradeStatus == alipay.TradeStatusClosed
		return result, nil
	case "wechat":
		client, _, err := a.wechatClient(ctx, config)
		if err != nil {
			return result, err
		}
		service := native.NativeApiService{Client: client}
		data, _, err := service.QueryOrderByOutTradeNo(ctx, native.QueryOrderByOutTradeNoRequest{Mchid: core.String(config.MchID), OutTradeNo: core.String(number)})
		if err != nil {
			return result, err
		}
		return wechatResult(data, config)
	}
	return result, errors.New("不支持的支付平台")
}
func (a *App) closePayment(ctx context.Context, order Row, config PaymentConfig) error {
	number := merchantOrder(str(order["id"]))
	switch order["provider"] {
	case "epay":
		return nil // 经典易支付无统一关单接口：查单后仅关闭本地支付入口，迟到支付仍验签入账。
	case "alipay":
		client, err := a.alipayClient(config)
		if err != nil {
			return err
		}
		result, err := client.TradeClose(ctx, alipay.TradeClose{OutTradeNo: number})
		if err != nil {
			return err
		}
		if !result.IsSuccess() {
			return errors.New("支付宝未确认关闭订单")
		}
		return nil
	case "wechat":
		client, _, err := a.wechatClient(ctx, config)
		if err != nil {
			return err
		}
		service := native.NativeApiService{Client: client}
		_, err = service.CloseOrder(ctx, native.CloseOrderRequest{Mchid: core.String(config.MchID), OutTradeNo: core.String(number)})
		return err
	}
	return errors.New("不支持的支付平台")
}

func (a *App) verifyPayment(c *gin.Context, order Row, config PaymentConfig) (PaymentResult, error) {
	result := PaymentResult{}
	ctx := c.Request.Context()
	if order["provider"] == "wechat" {
		_, handler, err := a.wechatClient(ctx, config)
		if err != nil {
			return result, err
		}
		var transaction payments.Transaction
		event, err := handler.ParseNotifyRequest(ctx, c.Request, &transaction)
		if err != nil {
			return result, err
		}
		if event.EventType != "TRANSACTION.SUCCESS" {
			return result, errors.New("不支持的支付通知")
		}
		return wechatResult(&transaction, config)
	}
	if err := c.Request.ParseForm(); err != nil {
		return result, err
	}
	params := c.Request.Form
	for _, values := range params {
		if len(values) != 1 {
			return result, errors.New("重复的通知参数")
		}
	}
	switch order["provider"] {
	case "epay":
		client, err := epay.NewClient(&epay.Config{PartnerID: config.PartnerID, Key: config.Key}, config.BaseURL)
		if err != nil {
			return result, err
		}
		fields := map[string]string{}
		for k := range params {
			fields[k] = params.Get(k)
		}
		verified, err := client.Verify(fields)
		if err != nil || !verified.VerifyStatus || params.Get("pid") != config.PartnerID {
			return result, errors.New("通知验签失败")
		}
		result = PaymentResult{Paid: verified.TradeStatus == epay.StatusTradeSuccess, TradeNo: verified.TradeNo, MerchantOrder: verified.ServiceTradeNo, Method: verified.Type}
		result.AmountCents, err = amountUnits(verified.Money, 100)
		return result, err
	case "alipay":
		client, err := a.alipayClient(config)
		if err != nil {
			return result, err
		}
		verified, err := client.DecodeNotification(ctx, params)
		if err != nil {
			return result, err
		}
		if verified.AppId != config.AppID || verified.SellerId != config.SellerID {
			return result, errors.New("支付商户不匹配")
		}
		result = PaymentResult{Paid: verified.TradeStatus == alipay.TradeStatusSuccess || verified.TradeStatus == alipay.TradeStatusFinished, TradeNo: verified.TradeNo, MerchantOrder: verified.OutTradeNo, Method: "alipay"}
		result.AmountCents, err = amountUnits(verified.TotalAmount, 100)
		return result, err
	}
	return result, errors.New("不支持的支付平台")
}
func value[T any](p *T) (zero T) {
	if p != nil {
		return *p
	}
	return zero
}
func wechatResult(t *payments.Transaction, c PaymentConfig) (PaymentResult, error) {
	result := PaymentResult{}
	if t == nil || value(t.Appid) != c.AppID || value(t.Mchid) != c.MchID || t.Amount == nil || value(t.Amount.Currency) != "CNY" {
		return result, errors.New("微信通知商户或币种不匹配")
	}
	return PaymentResult{Paid: value(t.TradeState) == "SUCCESS", Closed: value(t.TradeState) == "CLOSED", TradeNo: value(t.TransactionId), MerchantOrder: value(t.OutTradeNo), Method: "wxpay", AmountCents: value(t.Amount.Total)}, nil
}

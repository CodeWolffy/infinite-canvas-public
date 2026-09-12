package platform

import (
	"context"
	"crypto/subtle"
	"errors"
	"fmt"
	"net/url"
	"strings"
	"time"

	"github.com/alexedwards/argon2id"
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/pquerna/otp"
	"github.com/pquerna/otp/totp"
)

// 邮箱链接及 MFA 凭证有效期已由用户确认。
const emailTokenLifetime = 30 * time.Minute
const mfaTokenLifetime = 5 * time.Minute

type securityProof struct {
	Password string `json:"password" binding:"required,max=128"`
	Code     string `json:"code" binding:"max=128"`
}

func (a *App) issueAuthToken(ctx context.Context, q querier, userID, purpose, value, passwordHash string, lifetime time.Duration) (string, error) {
	token, err := randomToken()
	if err != nil {
		return "", err
	}
	if _, err = q.Exec(ctx, "DELETE FROM auth_tokens WHERE user_id=$1 AND purpose=$2", userID, purpose); err != nil {
		return "", err
	}
	_, err = q.Exec(ctx, "INSERT INTO auth_tokens(token_hash,user_id,purpose,value,password_hash,expires_at) VALUES($1,$2,$3,$4,$5,$6)", hash(token), userID, purpose, value, passwordHash, time.Now().Add(lifetime))
	return token, err
}

func (a *App) consumeAuthToken(ctx context.Context, tx pgx.Tx, token, purpose string) (Row, error) {
	entry, err := one(ctx, tx, "SELECT * FROM auth_tokens WHERE token_hash=$1 AND purpose=$2 AND expires_at>now()", hash(token), purpose)
	if err != nil {
		if errors.Is(err, notFound) {
			return nil, problem(400, "invalid_token", "链接或验证凭证已失效，请重新发起")
		}
		return nil, err
	}
	// 与登录、改密锁定顺序一致，避免先锁令牌再锁用户的死锁。
	var password, status string
	if err = tx.QueryRow(ctx, "SELECT password_hash,status FROM users WHERE id=$1 FOR UPDATE", entry["userId"]).Scan(&password, &status); err != nil {
		return nil, err
	}
	if password != str(entry["passwordHash"]) || status != "active" {
		return nil, problem(400, "invalid_token", "账号已变更，请重新发起")
	}
	deleted, err := tx.Exec(ctx, "DELETE FROM auth_tokens WHERE token_hash=$1 AND expires_at>now()", hash(token))
	if err != nil {
		return nil, err
	}
	if deleted.RowsAffected() != 1 {
		return nil, problem(400, "invalid_token", "验证凭证已使用")
	}
	return entry, nil
}

func totpStep(secret, code string, last int64) (int64, error) {
	now := time.Now().Unix() / 30
	for _, step := range []int64{now, now - 1, now + 1} {
		if step <= last {
			continue
		}
		valid, err := totp.ValidateCustom(code, secret, time.Unix(step*30, 0), totp.ValidateOpts{Period: 30, Digits: otp.DigitsSix, Algorithm: otp.AlgorithmSHA1})
		if err == nil && valid {
			return step, nil
		}
	}
	return 0, problem(400, "invalid_mfa", "验证码错误或已使用，请输入最新验证码")
}

func (a *App) secondFactor(ctx context.Context, tx pgx.Tx, userID, code string, recovery bool) error {
	row, err := one(ctx, tx, "SELECT encrypted_totp_secret,totp_last_step,mfa_recovery_hash FROM users WHERE id=$1 FOR UPDATE", userID)
	if err != nil || row["encryptedTotpSecret"] == nil {
		return err
	}
	if recovery && str(row["mfaRecoveryHash"]) != "" && subtle.ConstantTimeCompare([]byte(hash(strings.TrimSpace(code))), []byte(str(row["mfaRecoveryHash"]))) == 1 {
		if _, err = tx.Exec(ctx, "UPDATE users SET encrypted_totp_secret=NULL,mfa_recovery_hash=NULL,totp_last_step=-1 WHERE id=$1", userID); err != nil {
			return err
		}
		if _, err = tx.Exec(ctx, "UPDATE sessions SET revoked_at=now() WHERE user_id=$1", userID); err != nil {
			return err
		}
		if err = a.audit(ctx, tx, userID, "auth.mfa_recovery", userID, Row{}); err != nil {
			return err
		}
		return a.notifySecurity(ctx, tx, userID, uuid.NewString(), "恢复码已使用，两步验证已关闭", "账号已通过恢复码登录，其他设备会话已撤销。请前往账号安全重新绑定验证器；如果不是本人操作，请立即修改密码。")
	}
	secret, err := a.unseal(str(row["encryptedTotpSecret"]))
	if err != nil {
		return err
	}
	step, err := totpStep(secret, strings.TrimSpace(code), integer(row["totpLastStep"]))
	if err != nil {
		return err
	}
	_, err = tx.Exec(ctx, "UPDATE users SET totp_last_step=$2 WHERE id=$1", userID, step)
	return err
}

func (a *App) verifySecurityProof(c *gin.Context, tx pgx.Tx, proof securityProof) error {
	u := currentUser(c)
	var encoded string
	if err := tx.QueryRow(c.Request.Context(), "SELECT password_hash FROM users WHERE id=$1 FOR UPDATE", u.ID).Scan(&encoded); err != nil {
		return err
	}
	valid, err := argon2id.ComparePasswordAndHash(proof.Password, encoded)
	if err != nil || !valid {
		return problem(400, "invalid_password", "当前密码错误")
	}
	return a.secondFactor(c.Request.Context(), tx, u.ID, proof.Code, false)
}

func (a *App) sessionWithClient(ctx context.Context, q querier, userID string, c *gin.Context) (string, error) {
	token, err := a.session(ctx, q, userID)
	if err != nil {
		return "", err
	}
	_, err = q.Exec(ctx, "UPDATE sessions SET ip=$2,user_agent=$3 WHERE token_hash=$1", hash(token), a.clientIP(c), c.GetHeader("User-Agent"))
	return token, err
}

func (a *App) authSecurityRoutes(r *gin.Engine) {
	r.GET("/api/auth/security-options", respond(func(c *gin.Context) (any, error) {
		config, err := a.mailConfig(c.Request.Context(), a.DB)
		return gin.H{"emailEnabled": config.Enabled}, err
	}))
	r.POST("/api/auth/mfa", respond(func(c *gin.Context) (any, error) {
		input, err := body[struct {
			Challenge string `json:"challenge" binding:"required,max=128"`
			Code      string `json:"code" binding:"required,max=128"`
		}](c)
		if err != nil {
			return nil, err
		}
		refund, err := a.loginQuota(c, "mfa:"+hash(input.Challenge), a.clientIP(c))
		if err != nil {
			return nil, err
		}
		ctx := c.Request.Context()
		var token string
		var u User
		err = pgx.BeginFunc(ctx, a.DB, func(tx pgx.Tx) error {
			entry, err := a.consumeAuthToken(ctx, tx, input.Challenge, "mfa")
			if err != nil {
				return err
			}
			if err = a.rate(c, "mfa-user:"+str(entry["userId"]), 5, time.Minute); err != nil {
				return err
			}
			if err = a.secondFactor(ctx, tx, str(entry["userId"]), input.Code, true); err != nil {
				return err
			}
			u, err = scanUser(tx.QueryRow(ctx, "SELECT "+userColumns+" FROM users u LEFT JOIN user_groups g ON g.id=u.group_id WHERE u.id=$1", entry["userId"]))
			if err != nil {
				return err
			}
			token, err = a.sessionWithClient(ctx, tx, u.ID, c)
			if err != nil {
				return err
			}
			if _, err = tx.Exec(ctx, "UPDATE users SET last_login_at=now() WHERE id=$1", u.ID); err != nil {
				return err
			}
			return a.notifyLogin(ctx, tx, u.ID, token, a.clientIP(c), c.GetHeader("User-Agent"))
		})
		if err != nil {
			return nil, err
		}
		refund()
		a.setCookie(c, token)
		return gin.H{"user": u}, nil
	}))
	r.POST("/api/auth/password-reset", respond(func(c *gin.Context) (any, error) {
		input, err := body[struct {
			Email string `json:"email" binding:"required,max=254"`
		}](c)
		if err != nil {
			return nil, err
		}
		email, err := emailAddress(input.Email)
		if err != nil {
			return nil, err
		}
		if err = a.rate(c, "password-reset:ip:"+hash(a.clientIP(c)), 30, 5*time.Minute); err != nil {
			return nil, err
		}
		if err = a.rate(c, "password-reset:email:"+hash(email), 5, time.Minute); err != nil {
			return nil, err
		}
		ctx := c.Request.Context()
		config, err := a.mailConfig(ctx, a.DB)
		if err != nil {
			return nil, err
		}
		if !config.Enabled {
			return nil, problem(503, "mail_unavailable", "管理员尚未开启邮件服务")
		}
		err = pgx.BeginFunc(ctx, a.DB, func(tx pgx.Tx) error {
			user, err := one(ctx, tx, "SELECT id,password_hash FROM users WHERE email=$1 AND email_verified_at IS NOT NULL AND status='active' FOR UPDATE", email)
			if errors.Is(err, notFound) {
				return nil
			}
			if err != nil {
				return err
			}
			token, err := a.issueAuthToken(ctx, tx, str(user["id"]), "password", email, str(user["passwordHash"]), emailTokenLifetime)
			if err != nil {
				return err
			}
			return a.queueMail(ctx, tx, email, "重置无限画布密码", "请在 30 分钟内打开链接设置新密码。链接仅可使用一次；若非本人操作请忽略。\n\n"+a.Config.PublicURL+"/reset-password?token="+url.QueryEscape(token))
		})
		return gin.H{"message": "如果该邮箱已绑定并验证，你将收到重置链接。"}, err
	}))
	r.POST("/api/auth/password-reset/complete", respond(func(c *gin.Context) (any, error) {
		input, err := body[struct {
			Token    string `json:"token" binding:"required,max=128"`
			Password string `json:"password" binding:"required,min=10,max=128"`
		}](c)
		if err != nil {
			return nil, err
		}
		refund, err := a.loginQuota(c, "reset:"+hash(input.Token), a.clientIP(c))
		if err != nil {
			return nil, err
		}
		encoded, err := argon2id.CreateHash(input.Password, argon2id.DefaultParams)
		if err != nil {
			return nil, err
		}
		ctx := c.Request.Context()
		err = pgx.BeginFunc(ctx, a.DB, func(tx pgx.Tx) error {
			entry, err := a.consumeAuthToken(ctx, tx, input.Token, "password")
			if err != nil {
				return err
			}
			result, err := tx.Exec(ctx, "UPDATE users SET password_hash=$2,must_change_password=false,updated_at=now() WHERE id=$1 AND email=$3 AND email_verified_at IS NOT NULL", entry["userId"], encoded, entry["value"])
			if err != nil {
				return err
			}
			if result.RowsAffected() != 1 {
				return problem(400, "invalid_token", "邮箱已变更，请重新发起")
			}
			if _, err = tx.Exec(ctx, "UPDATE sessions SET revoked_at=now() WHERE user_id=$1", entry["userId"]); err != nil {
				return err
			}
			if _, err = tx.Exec(ctx, "DELETE FROM auth_tokens WHERE user_id=$1", entry["userId"]); err != nil {
				return err
			}
			if err = a.audit(ctx, tx, str(entry["userId"]), "auth.password_reset", str(entry["userId"]), Row{}); err != nil {
				return err
			}
			return a.notifySecurity(ctx, tx, str(entry["userId"]), "password-reset:"+str(entry["userId"])+":"+fmt.Sprint(time.Now().UnixNano()), "密码已通过邮箱重置", "如果不是你本人操作，请立即联系管理员。两步验证设置保持有效。")
		})
		if err == nil {
			refund()
		}
		return gin.H{"message": "密码已更新，请重新登录。两步验证设置保持有效。"}, err
	}))
	r.POST("/api/auth/email/verify", respond(func(c *gin.Context) (any, error) {
		input, err := body[struct {
			Token string `json:"token" binding:"required,max=128"`
		}](c)
		if err != nil {
			return nil, err
		}
		refund, err := a.loginQuota(c, "email:"+hash(input.Token), a.clientIP(c))
		if err != nil {
			return nil, err
		}
		ctx := c.Request.Context()
		err = pgx.BeginFunc(ctx, a.DB, func(tx pgx.Tx) error {
			entry, err := a.consumeAuthToken(ctx, tx, input.Token, "email")
			if err != nil {
				return err
			}
			if _, err = tx.Exec(ctx, "UPDATE users SET email=$2,email_verified_at=now(),updated_at=now() WHERE id=$1", entry["userId"], entry["value"]); err != nil {
				return err
			}
			if err = a.audit(ctx, tx, str(entry["userId"]), "auth.email_verified", str(entry["userId"]), Row{}); err != nil {
				return err
			}
			return a.notifySecurity(ctx, tx, str(entry["userId"]), "email:"+str(entry["userId"])+":"+fmt.Sprint(time.Now().UnixNano()), "验证邮箱已更新", "当前验证邮箱为 "+str(entry["value"])+"。")
		})
		if err == nil {
			refund()
		}
		return gin.H{"message": "邮箱验证成功"}, err
	}))
}

func (a *App) userSecurityRoutes(api *gin.RouterGroup) {
	api.GET("/user/security", respond(func(c *gin.Context) (any, error) {
		row, err := one(c.Request.Context(), a.DB, "SELECT email,email_verified_at,encrypted_totp_secret IS NOT NULL AS mfa_enabled,mfa_recovery_hash IS NOT NULL AS recovery_available FROM users WHERE id=$1", currentUser(c).ID)
		return gin.H{"security": row}, err
	}))
	api.POST("/user/security/email", respond(func(c *gin.Context) (any, error) {
		input, err := body[struct {
			securityProof
			Email string `json:"email" binding:"required,max=254"`
		}](c)
		if err != nil {
			return nil, err
		}
		email, err := emailAddress(input.Email)
		if err != nil {
			return nil, err
		}
		ctx, u := c.Request.Context(), currentUser(c)
		if err = a.rate(c, "security:"+u.ID, 5, time.Minute); err != nil {
			return nil, err
		}
		config, err := a.mailConfig(ctx, a.DB)
		if err != nil {
			return nil, err
		}
		if !config.Enabled {
			return nil, problem(503, "mail_unavailable", "管理员尚未开启邮件服务")
		}
		err = pgx.BeginFunc(ctx, a.DB, func(tx pgx.Tx) error {
			if err := a.verifySecurityProof(c, tx, input.securityProof); err != nil {
				return err
			}
			var password string
			if err := tx.QueryRow(ctx, "SELECT password_hash FROM users WHERE id=$1", u.ID).Scan(&password); err != nil {
				return err
			}
			token, err := a.issueAuthToken(ctx, tx, u.ID, "email", email, password, emailTokenLifetime)
			if err != nil {
				return err
			}
			return a.queueMail(ctx, tx, email, "验证无限画布邮箱", "请在 30 分钟内打开链接完成邮箱绑定。链接仅可使用一次。\n\n"+a.Config.PublicURL+"/verify-email?token="+url.QueryEscape(token))
		})
		return gin.H{"message": "验证邮件已提交发送，请检查邮箱。"}, err
	}))
	api.POST("/user/security/mfa/setup", respond(func(c *gin.Context) (any, error) {
		input, err := body[securityProof](c)
		if err != nil {
			return nil, err
		}
		ctx, u := c.Request.Context(), currentUser(c)
		if err = a.rate(c, "security:"+u.ID, 5, time.Minute); err != nil {
			return nil, err
		}
		key, err := totp.Generate(totp.GenerateOpts{Issuer: "Infinite Canvas", AccountName: u.Username})
		if err != nil {
			return nil, err
		}
		sealed, err := a.seal(key.Secret())
		if err != nil {
			return nil, err
		}
		err = pgx.BeginFunc(ctx, a.DB, func(tx pgx.Tx) error {
			if err := a.verifySecurityProof(c, tx, input); err != nil {
				return err
			}
			result, err := tx.Exec(ctx, "UPDATE users SET encrypted_totp_pending=$2,totp_pending_at=now() WHERE id=$1 AND encrypted_totp_secret IS NULL", u.ID, sealed)
			if err != nil {
				return err
			}
			if result.RowsAffected() != 1 {
				return problem(409, "mfa_enabled", "请先关闭已启用的两步验证")
			}
			return nil
		})
		if err != nil {
			return nil, err
		}
		return gin.H{"secret": key.Secret(), "uri": key.URL()}, nil
	}))
	api.POST("/user/security/mfa/enable", respond(func(c *gin.Context) (any, error) {
		input, err := body[struct {
			Code string `json:"code" binding:"required,max=128"`
		}](c)
		if err != nil {
			return nil, err
		}
		ctx, u := c.Request.Context(), currentUser(c)
		if err = a.rate(c, "security:"+u.ID, 5, time.Minute); err != nil {
			return nil, err
		}
		recovery, err := randomToken()
		if err != nil {
			return nil, err
		}
		err = pgx.BeginFunc(ctx, a.DB, func(tx pgx.Tx) error {
			row, err := one(ctx, tx, "SELECT encrypted_totp_pending FROM users WHERE id=$1 AND encrypted_totp_secret IS NULL AND totp_pending_at>now()-interval '5 minutes' FOR UPDATE", u.ID)
			if err != nil {
				return problem(400, "setup_expired", "请重新开始绑定")
			}
			secret, err := a.unseal(str(row["encryptedTotpPending"]))
			if err != nil {
				return err
			}
			step, err := totpStep(secret, input.Code, -1)
			if err != nil {
				return err
			}
			if _, err = tx.Exec(ctx, "UPDATE users SET encrypted_totp_secret=encrypted_totp_pending,encrypted_totp_pending=NULL,totp_pending_at=NULL,totp_last_step=$2,mfa_recovery_hash=$3 WHERE id=$1", u.ID, step, hash(recovery)); err != nil {
				return err
			}
			cookie, _ := c.Cookie(a.Config.CookieName)
			if _, err = tx.Exec(ctx, "UPDATE sessions SET revoked_at=now() WHERE user_id=$1 AND token_hash<>$2", u.ID, hash(cookie)); err != nil {
				return err
			}
			if _, err = tx.Exec(ctx, "DELETE FROM auth_tokens WHERE user_id=$1", u.ID); err != nil {
				return err
			}
			if err = a.audit(ctx, tx, u.ID, "auth.mfa_enabled", u.ID, Row{}); err != nil {
				return err
			}
			return a.notifySecurity(ctx, tx, u.ID, "mfa-on:"+u.ID+":"+fmt.Sprint(time.Now().UnixNano()), "两步验证已启用", "其他登录设备已退出。请妥善保存一次性恢复码。")
		})
		if err != nil {
			return nil, err
		}
		return gin.H{"recoveryCode": recovery}, nil
	}))
	api.POST("/user/security/mfa/disable", respond(func(c *gin.Context) (any, error) {
		input, err := body[securityProof](c)
		if err != nil {
			return nil, err
		}
		ctx, u := c.Request.Context(), currentUser(c)
		if err = a.rate(c, "security:"+u.ID, 5, time.Minute); err != nil {
			return nil, err
		}
		err = pgx.BeginFunc(ctx, a.DB, func(tx pgx.Tx) error {
			if err := a.verifySecurityProof(c, tx, input); err != nil {
				return err
			}
			if _, err := tx.Exec(ctx, "UPDATE users SET encrypted_totp_secret=NULL,encrypted_totp_pending=NULL,mfa_recovery_hash=NULL,totp_last_step=-1 WHERE id=$1", u.ID); err != nil {
				return err
			}
			if _, err := tx.Exec(ctx, "DELETE FROM auth_tokens WHERE user_id=$1", u.ID); err != nil {
				return err
			}
			if err := a.audit(ctx, tx, u.ID, "auth.mfa_disabled", u.ID, Row{}); err != nil {
				return err
			}
			return a.notifySecurity(ctx, tx, u.ID, "mfa-off:"+u.ID+":"+fmt.Sprint(time.Now().UnixNano()), "两步验证已关闭", "如果不是你本人操作，请立即重新绑定验证器。")
		})
		return nil, err
	}))
	api.GET("/user/security/sessions", respond(func(c *gin.Context) (any, error) {
		cookie, _ := c.Cookie(a.Config.CookieName)
		items, err := rows(c.Request.Context(), a.DB, "SELECT id,ip,user_agent,created_at,expires_at,token_hash=$2 AS current FROM sessions WHERE user_id=$1 AND revoked_at IS NULL AND expires_at>now() ORDER BY created_at DESC", currentUser(c).ID, hash(cookie))
		return gin.H{"sessions": items}, err
	}))
	api.DELETE("/user/security/sessions/:id", respond(func(c *gin.Context) (any, error) {
		id, err := idParam(c, "id")
		if err != nil {
			return nil, err
		}
		cookie, _ := c.Cookie(a.Config.CookieName)
		ctx, u := c.Request.Context(), currentUser(c)
		var current bool
		err = pgx.BeginFunc(ctx, a.DB, func(tx pgx.Tx) error {
			if err := tx.QueryRow(ctx, "UPDATE sessions SET revoked_at=now() WHERE id=$1 AND user_id=$2 RETURNING token_hash=$3", id, u.ID, hash(cookie)).Scan(&current); err != nil {
				return err
			}
			return a.audit(ctx, tx, u.ID, "auth.session_revoked", id, Row{})
		})
		if current {
			a.clearCookie(c)
		}
		return gin.H{"current": current}, err
	}))
	api.POST("/user/security/sessions/revoke-others", respond(func(c *gin.Context) (any, error) {
		cookie, _ := c.Cookie(a.Config.CookieName)
		ctx, u := c.Request.Context(), currentUser(c)
		err := pgx.BeginFunc(ctx, a.DB, func(tx pgx.Tx) error {
			if _, err := tx.Exec(ctx, "UPDATE sessions SET revoked_at=now() WHERE user_id=$1 AND token_hash<>$2", u.ID, hash(cookie)); err != nil {
				return err
			}
			return a.audit(ctx, tx, u.ID, "auth.other_sessions_revoked", u.ID, Row{})
		})
		return nil, err
	}))
}

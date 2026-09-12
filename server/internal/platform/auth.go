package platform

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"fmt"
	"net"
	"net/http"
	"os"
	"regexp"
	"strings"
	"time"

	"github.com/alexedwards/argon2id"
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/redis/go-redis/v9"
)

type User struct {
	ID                 string     `json:"id"`
	Username           string     `json:"username"`
	DisplayName        string     `json:"displayName"`
	Role               string     `json:"role"`
	Status             string     `json:"status"`
	MustChangePassword bool       `json:"mustChangePassword"`
	LastLoginAt        *time.Time `json:"lastLoginAt"`
	CreatedAt          time.Time  `json:"createdAt"`
	GroupID            *string    `json:"groupId"`
	GroupName          *string    `json:"groupName"`
	PasswordHash       string     `json:"-"`
}

var usernamePattern = regexp.MustCompile(`^[a-z0-9][a-z0-9_.-]{2,63}$`)

const userColumns = "u.id,u.username,u.display_name,u.role,u.status,u.must_change_password,u.last_login_at,u.created_at,u.password_hash,u.group_id,g.name AS group_name"

func scanUser(row pgx.Row) (User, error) {
	var u User
	err := row.Scan(&u.ID, &u.Username, &u.DisplayName, &u.Role, &u.Status, &u.MustChangePassword, &u.LastLoginAt, &u.CreatedAt, &u.PasswordHash, &u.GroupID, &u.GroupName)
	return u, err
}
func currentUser(c *gin.Context) User { return c.MustGet("user").(User) }

func (a *App) bootstrap(ctx context.Context) error {
	var err error
	a.dummyHash, err = argon2id.CreateHash(uuid.NewString(), argon2id.DefaultParams)
	if err != nil {
		return err
	}
	username, password := strings.ToLower(strings.TrimSpace(os.Getenv("BOOTSTRAP_ADMIN_USERNAME"))), os.Getenv("BOOTSTRAP_ADMIN_PASSWORD")
	if username == "" && password == "" {
		return nil
	}
	if !usernamePattern.MatchString(username) || len(password) < 10 || len(password) > 128 || strings.HasPrefix(password, "change-me") {
		return errors.New("请配置有效的初始化管理员账号和密码")
	}
	return pgx.BeginFunc(ctx, a.DB, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, "SELECT pg_advisory_xact_lock(hashtextextended('bootstrap-admin',0))"); err != nil {
			return err
		}
		var role string
		err := tx.QueryRow(ctx, "SELECT role FROM users WHERE username=$1", username).Scan(&role)
		if err == nil {
			if role != "admin" {
				return errors.New("初始化用户名已被普通用户使用")
			}
			return nil
		}
		if !errors.Is(err, pgx.ErrNoRows) {
			return err
		}
		passwordHash, err := argon2id.CreateHash(password, argon2id.DefaultParams)
		if err != nil {
			return err
		}
		id := uuid.NewString()
		if _, err = tx.Exec(ctx, "INSERT INTO users(id,username,password_hash,display_name,role,must_change_password) VALUES($1,$2,$3,$4,'admin',true)", id, username, passwordHash, env("BOOTSTRAP_ADMIN_DISPLAY_NAME", "管理员")); err != nil {
			return err
		}
		_, err = tx.Exec(ctx, "INSERT INTO wallets(user_id) VALUES($1)", id)
		return err
	})
}

func (a *App) setCookie(c *gin.Context, token string) {
	http.SetCookie(c.Writer, &http.Cookie{Name: a.Config.CookieName, Value: token, Path: "/", HttpOnly: true, Secure: a.Config.SecureCookie, SameSite: http.SameSiteLaxMode, MaxAge: a.Config.SessionDays * 86400})
}
func (a *App) clearCookie(c *gin.Context) {
	http.SetCookie(c.Writer, &http.Cookie{Name: a.Config.CookieName, Value: "", Path: "/", HttpOnly: true, Secure: a.Config.SecureCookie, SameSite: http.SameSiteLaxMode, MaxAge: -1})
}
func (a *App) session(ctx context.Context, q querier, userID string) (string, error) {
	data := make([]byte, 32)
	if _, err := rand.Read(data); err != nil {
		return "", err
	}
	token := base64.RawURLEncoding.EncodeToString(data)
	_, err := q.Exec(ctx, "INSERT INTO sessions(user_id,token_hash,expires_at) VALUES($1,$2,$3)", userID, hash(token), time.Now().AddDate(0, 0, a.Config.SessionDays))
	return token, err
}
func (a *App) loadUser(c *gin.Context) (User, error) {
	token, err := c.Cookie(a.Config.CookieName)
	if err != nil || token == "" {
		return User{}, problem(401, "unauthorized", "请先登录")
	}
	u, err := scanUser(a.DB.QueryRow(c.Request.Context(), "SELECT u.id,u.username,u.display_name,u.role,u.status,u.must_change_password,u.last_login_at,u.created_at,u.password_hash,u.group_id,g.name AS group_name FROM sessions s JOIN users u ON u.id=s.user_id LEFT JOIN user_groups g ON g.id=u.group_id WHERE s.token_hash=$1 AND s.expires_at>now() AND s.revoked_at IS NULL AND u.status='active'", hash(token)))
	if errors.Is(err, pgx.ErrNoRows) {
		a.clearCookie(c)
		return User{}, problem(401, "unauthorized", "登录已失效")
	}
	return u, err
}
func (a *App) authenticate() gin.HandlerFunc {
	return func(c *gin.Context) {
		u, err := a.loadUser(c)
		if err != nil {
			fail(c, err)
			return
		}
		if u.MustChangePassword {
			fail(c, problem(403, "password_change_required", "请先修改初始密码"))
			return
		}
		c.Set("user", u)
		c.Next()
	}
}

func (a *App) clientIP(c *gin.Context) string {
	ip, _, err := net.SplitHostPort(c.Request.RemoteAddr)
	if err != nil {
		ip = c.Request.RemoteAddr
	}
	if a.Config.TrustProxy {
		// 部署约定：1Panel -> Web Nginx -> API；只取距 API 最近的两层，不相信任意前缀。
		parts := strings.Split(c.GetHeader("X-Forwarded-For"), ",")
		if len(parts) >= 2 {
			candidate := strings.TrimSpace(parts[len(parts)-2])
			if parsed := net.ParseIP(candidate); parsed != nil {
				return parsed.String()
			}
		}
	}
	return ip
}

var rateScript = redis.NewScript(`
local current=redis.call('INCR',KEYS[1])
if current==1 then redis.call('PEXPIRE',KEYS[1],ARGV[2]) end
if current>tonumber(ARGV[1]) then return redis.call('PTTL',KEYS[1]) end
return 0`)

var loginQuotaScript = redis.NewScript(`
local stamp=redis.call('TIME'); local now=stamp[1]*1000+math.floor(stamp[2]/1000)
for i,key in ipairs(KEYS) do
  local duration=tonumber(ARGV[i*2]); local limit=tonumber(ARGV[i*2+1])
  redis.call('ZREMRANGEBYSCORE',key,'-inf',now-duration)
  if redis.call('ZCARD',key)>=limit then return duration end
end
for i,key in ipairs(KEYS) do redis.call('ZADD',key,now,ARGV[1]); redis.call('PEXPIRE',key,ARGV[i*2]) end
return 0`)

func (a *App) loginQuota(c *gin.Context, name, ip string) (func(), error) {
	keys := []string{"ic:auth:ip:" + hash(ip), "ic:auth:user:" + hash(ip+":"+name)}
	token := uuid.NewString()
	wait, err := loginQuotaScript.Run(c.Request.Context(), a.Redis, keys, token, 300000, 30, 60000, 5).Int64()
	if err != nil {
		return nil, problem(503, "rate_limit_unavailable", "登录频控服务暂时不可用")
	}
	if wait > 0 {
		c.Header("Retry-After", str(wait/1000))
		return nil, problem(429, "too_many_requests", "登录尝试过于频繁，请稍后重试")
	}
	return func() {
		for _, key := range keys {
			_ = a.Redis.ZRem(c.Request.Context(), key, token).Err()
		}
	}, nil
}

func (a *App) rate(c *gin.Context, key string, limit int, window time.Duration) error {
	if limit <= 0 {
		return nil
	}
	ttl, err := rateScript.Run(c.Request.Context(), a.Redis, []string{"ic:rate:" + key}, limit, window.Milliseconds()).Int64()
	if err != nil {
		return problem(503, "rate_limit_unavailable", "频控服务暂时不可用，请稍后重试")
	}
	if ttl > 0 {
		c.Header("Retry-After", str((ttl+999)/1000))
		return problem(429, "too_many_requests", "操作过于频繁，请稍后重试")
	}
	return nil
}

func (a *App) authRoutes(r *gin.Engine) {
	r.POST("/api/auth/login", respond(func(c *gin.Context) (any, error) {
		input, err := body[struct {
			Username string `json:"username" binding:"required,max=64"`
			Password string `json:"password" binding:"required,max=128"`
		}](c)
		if err != nil {
			return nil, err
		}
		name := strings.ToLower(strings.TrimSpace(input.Username))
		ip := a.clientIP(c)
		refundQuota, err := a.loginQuota(c, name, ip)
		if err != nil {
			return nil, err
		}
		u, err := scanUser(a.DB.QueryRow(c.Request.Context(), "SELECT "+userColumns+" FROM users u LEFT JOIN user_groups g ON g.id=u.group_id WHERE u.username=$1 AND u.status='active'", name))
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return nil, err
		}
		encoded := a.dummyHash
		if u.ID != "" {
			encoded = u.PasswordHash
		}
		match, verifyErr := argon2id.ComparePasswordAndHash(input.Password, encoded)
		if verifyErr != nil || !match || u.ID == "" {
			return nil, problem(401, "invalid_credentials", "用户名或密码错误")
		}
		var token, challenge string
		err = pgx.BeginFunc(c.Request.Context(), a.DB, func(tx pgx.Tx) error {
			locked, err := scanUser(tx.QueryRow(c.Request.Context(), "SELECT "+userColumns+" FROM users u LEFT JOIN user_groups g ON g.id=u.group_id WHERE u.id=$1 FOR UPDATE OF u", u.ID))
			if err != nil {
				return err
			}
			if locked.PasswordHash != u.PasswordHash || locked.Status != "active" {
				return problem(401, "invalid_credentials", "账号状态已变更，请重新登录")
			}
			u = locked
			var mfa bool
			if err = tx.QueryRow(c.Request.Context(), "SELECT encrypted_totp_secret IS NOT NULL FROM users WHERE id=$1", u.ID).Scan(&mfa); err != nil {
				return err
			}
			if mfa {
				challenge, err = a.issueAuthToken(c.Request.Context(), tx, u.ID, "mfa", "", u.PasswordHash, mfaTokenLifetime)
				return err
			}
			if _, err = tx.Exec(c.Request.Context(), "UPDATE users SET last_login_at=now(),updated_at=now() WHERE id=$1", u.ID); err != nil {
				return err
			}
			token, err = a.sessionWithClient(c.Request.Context(), tx, u.ID, c)
			if err != nil {
				return err
			}
			return a.notifyLogin(c.Request.Context(), tx, u.ID, token, a.clientIP(c), c.GetHeader("User-Agent"))
		})
		if err != nil {
			return nil, err
		}
		now := time.Now()
		u.LastLoginAt = &now
		refundQuota()
		if challenge != "" {
			return gin.H{"mfaRequired": true, "challenge": challenge}, nil
		}
		a.setCookie(c, token)
		return gin.H{"user": u}, nil
	}))
	r.POST("/api/auth/register", respond(func(c *gin.Context) (any, error) {
		input, err := body[struct {
			Username       string `json:"username" binding:"required,max=64"`
			DisplayName    string `json:"displayName" binding:"required,max=80"`
			Password       string `json:"password" binding:"required,min=10,max=128"`
			InvitationCode string `json:"invitationCode" binding:"required"`
			ReferralCode   string `json:"referralCode" binding:"omitempty,uuid"`
		}](c)
		if err != nil {
			return nil, err
		}
		input.Username = strings.ToLower(strings.TrimSpace(input.Username))
		if !usernamePattern.MatchString(input.Username) {
			return nil, problem(400, "invalid_username", "用户名需为 3–64 位字母、数字、点、横线或下划线")
		}
		// 注册复用登录的账号/IP 频控边界。
		if err = a.rate(c, "login:ip:"+hash(a.clientIP(c)), 30, 5*time.Minute); err != nil {
			return nil, err
		}
		if err = a.rate(c, "register:"+hash(a.clientIP(c)), 5, time.Minute); err != nil {
			return nil, err
		}
		passwordHash, err := argon2id.CreateHash(input.Password, argon2id.DefaultParams)
		if err != nil {
			return nil, err
		}
		ctx := c.Request.Context()
		id := uuid.NewString()
		var token string
		var user User
		err = pgx.BeginFunc(ctx, a.DB, func(tx pgx.Tx) error {
			var invitation string
			err := tx.QueryRow(ctx, "UPDATE invitations SET used_count=used_count+1 WHERE code_hash=$1 AND NOT disabled AND used_count<max_uses AND (expires_at IS NULL OR expires_at>now()) RETURNING id", hash(strings.TrimSpace(input.InvitationCode))).Scan(&invitation)
			if errors.Is(err, pgx.ErrNoRows) {
				return problem(400, "invalid_invitation", "邀请码无效、已过期或已用完")
			}
			if err != nil {
				return err
			}
			user, err = scanUser(tx.QueryRow(ctx, "INSERT INTO users(id,username,password_hash,display_name) VALUES($1,$2,$3,$4) RETURNING id,username,display_name,role,status,must_change_password,last_login_at,created_at,password_hash,NULL,NULL", id, input.Username, passwordHash, strings.TrimSpace(input.DisplayName)))
			if err != nil {
				return err
			}
			if _, err = tx.Exec(ctx, "INSERT INTO wallets(user_id) VALUES($1)", id); err != nil {
				return err
			}
			if _, err = tx.Exec(ctx, "INSERT INTO invitation_uses(invitation_id,user_id) VALUES($1,$2)", invitation, id); err != nil {
				return err
			}
			if err = a.bindReferral(ctx, tx, id, input.ReferralCode); err != nil {
				return err
			}
			token, err = a.sessionWithClient(ctx, tx, id, c)
			return err
		})
		if err != nil {
			return nil, err
		}
		a.setCookie(c, token)
		return gin.H{"user": user}, nil
	}))
	r.GET("/api/auth/me", respond(func(c *gin.Context) (any, error) { u, err := a.loadUser(c); return gin.H{"user": u}, err }))
	r.POST("/api/auth/logout", respond(func(c *gin.Context) (any, error) {
		token, _ := c.Cookie(a.Config.CookieName)
		_, err := a.DB.Exec(c.Request.Context(), "UPDATE sessions SET revoked_at=now() WHERE token_hash=$1", hash(token))
		a.clearCookie(c)
		return nil, err
	}))
	r.POST("/api/auth/change-password", respond(func(c *gin.Context) (any, error) {
		u, err := a.loadUser(c)
		if err != nil {
			return nil, err
		}
		if err = a.rate(c, "password:"+u.ID, 5, time.Minute); err != nil {
			return nil, err
		}
		input, err := body[struct {
			CurrentPassword string `json:"currentPassword" binding:"required,max=128"`
			NewPassword     string `json:"newPassword" binding:"required,min=10,max=128"`
		}](c)
		if err != nil {
			return nil, err
		}
		match, err := argon2id.ComparePasswordAndHash(input.CurrentPassword, u.PasswordHash)
		if err != nil || !match {
			return nil, problem(400, "invalid_password", "当前密码错误")
		}
		if input.CurrentPassword == input.NewPassword {
			return nil, problem(400, "password_unchanged", "新密码不能与当前密码相同")
		}
		encoded, err := argon2id.CreateHash(input.NewPassword, argon2id.DefaultParams)
		if err != nil {
			return nil, err
		}
		ctx := c.Request.Context()
		var token string
		err = pgx.BeginFunc(ctx, a.DB, func(tx pgx.Tx) error {
			result, err := tx.Exec(ctx, "UPDATE users SET password_hash=$1,must_change_password=false,updated_at=now() WHERE id=$2 AND password_hash=$3", encoded, u.ID, u.PasswordHash)
			if err != nil {
				return err
			}
			if result.RowsAffected() != 1 {
				return problem(409, "account_changed", "账号已变更，请重新登录")
			}
			if _, err = tx.Exec(ctx, "UPDATE sessions SET revoked_at=now() WHERE user_id=$1", u.ID); err != nil {
				return err
			}
			token, err = a.sessionWithClient(ctx, tx, u.ID, c)
			if err != nil {
				return err
			}
			return a.notifySecurity(ctx, tx, u.ID, "password:"+u.ID+":"+fmt.Sprint(time.Now().UnixNano()), "密码已修改", "如果不是你本人操作，请立即联系管理员并重新设置密码。")
		})
		if err != nil {
			return nil, err
		}
		u.MustChangePassword = false
		a.setCookie(c, token)
		return gin.H{"user": u}, nil
	}))
}

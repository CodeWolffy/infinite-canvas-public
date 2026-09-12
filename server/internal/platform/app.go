package platform

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/minio/minio-go/v7"
	"github.com/minio/minio-go/v7/pkg/credentials"
	"github.com/redis/go-redis/v9"
)

type Config struct {
	Address, DatabaseURL, RedisURL, PublicURL, CookieName, EncryptionKey string
	Origins                                                              []string
	SecureCookie, TrustProxy, AllowPrivateHosts                          bool
	SessionDays, WorkerConcurrency, OrphanDays, LogDays                  int
	MaxUpload, MaxGenerated                                              int64
	HeaderTimeout                                                        time.Duration
	Bucket, MinioEndpoint, MinioAccessKey, MinioSecretKey                string
	MinioSSL                                                             bool
}

type App struct {
	DB          *pgxpool.Pool
	Redis       *redis.Client
	S3          *minio.Client
	Config      Config
	workers     sync.WaitGroup
	dummyHash   string
	streamMu    sync.Mutex
	streamSinks map[string]map[chan struct{}]struct{}
	shutdown    <-chan struct{}
	startedAt   time.Time
}

type Row map[string]any
type querier interface {
	Query(context.Context, string, ...any) (pgx.Rows, error)
	QueryRow(context.Context, string, ...any) pgx.Row
	Exec(context.Context, string, ...any) (pgconn.CommandTag, error)
}
type apiError struct {
	Status        int
	Code, Message string
}

func (e *apiError) Error() string                    { return e.Message }
func problem(status int, code, message string) error { return &apiError{status, code, message} }

var notFound = problem(404, "not_found", "记录不存在")

func env(key, fallback string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return fallback
}
func envInt(key string, fallback int) (int, error) {
	n, err := strconv.Atoi(env(key, strconv.Itoa(fallback)))
	if err != nil || n <= 0 {
		return 0, fmt.Errorf("%s 必须是正整数", key)
	}
	return n, nil
}

func New(ctx context.Context, migrations []string) (*App, error) {
	for _, key := range []string{"COOKIE_SECURE", "TRUST_PROXY", "ALLOW_PRIVATE_IMAGE_HOSTS", "MINIO_USE_SSL"} {
		if value := os.Getenv(key); value != "" && value != "true" && value != "false" {
			return nil, fmt.Errorf("%s 必须为 true 或 false", key)
		}
	}
	cfg := Config{Address: env("LISTEN_ADDRESS", ":3001"), DatabaseURL: os.Getenv("DATABASE_URL"), RedisURL: env("REDIS_URL", "redis://redis:6379/0"),
		PublicURL: strings.TrimRight(env("PUBLIC_URL", "http://localhost:3000"), "/"), CookieName: env("COOKIE_NAME", "infinite_canvas_public_session"),
		EncryptionKey: os.Getenv("CHANNEL_ENCRYPTION_KEY"), SecureCookie: env("COOKIE_SECURE", "true") == "true",
		TrustProxy: env("TRUST_PROXY", "false") == "true", AllowPrivateHosts: env("ALLOW_PRIVATE_IMAGE_HOSTS", "false") == "true",
		Bucket: env("MINIO_BUCKET", "infinite-canvas-public"), MinioEndpoint: env("MINIO_ENDPOINT", "minio") + ":" + env("MINIO_PORT", "9000"),
		MinioAccessKey: os.Getenv("MINIO_ACCESS_KEY"), MinioSecretKey: os.Getenv("MINIO_SECRET_KEY"), MinioSSL: env("MINIO_USE_SSL", "false") == "true"}
	if cfg.DatabaseURL == "" || len(cfg.EncryptionKey) < 32 || strings.HasPrefix(cfg.EncryptionKey, "change-me") {
		return nil, errors.New("请配置 DATABASE_URL 和独立的 CHANNEL_ENCRYPTION_KEY（至少 32 字符）")
	}
	u, err := url.Parse(cfg.PublicURL)
	if err != nil || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || u.Path != "" || (u.Scheme != "https" && u.Scheme != "http") {
		return nil, errors.New("PUBLIC_URL 必须为站点的完整 Origin")
	}
	if cfg.SecureCookie && u.Scheme != "https" {
		return nil, errors.New("Secure Cookie 需要 HTTPS PUBLIC_URL；本地 HTTP 请设置 COOKIE_SECURE=false")
	}
	cfg.Origins = strings.Split(env("CORS_ORIGIN", cfg.PublicURL), ",")
	for key, target := range map[string]*int{"SESSION_DAYS": &cfg.SessionDays, "IMAGE_WORKER_CONCURRENCY": &cfg.WorkerConcurrency, "ORPHAN_MEDIA_GRACE_DAYS": &cfg.OrphanDays, "REQUEST_LOG_RETENTION_DAYS": &cfg.LogDays} {
		defaults := map[string]int{"SESSION_DAYS": 7, "IMAGE_WORKER_CONCURRENCY": 20, "ORPHAN_MEDIA_GRACE_DAYS": 45, "REQUEST_LOG_RETENTION_DAYS": 30}
		*target, err = envInt(key, defaults[key])
		if err != nil {
			return nil, err
		}
	}
	upload, err := envInt("MAX_UPLOAD_BYTES", 50*1024*1024)
	if err != nil {
		return nil, err
	}
	cfg.MaxUpload = int64(upload)
	generated, err := envInt("MAX_GENERATED_BYTES", 50*1024*1024)
	if err != nil {
		return nil, err
	}
	cfg.MaxGenerated = int64(generated)
	// 沿用已有渠道默认超时；不额外引入独立的业务超时。
	cfg.HeaderTimeout = 480 * time.Second
	db, err := pgxpool.New(ctx, cfg.DatabaseURL)
	if err != nil {
		return nil, err
	}
	options, err := redis.ParseURL(cfg.RedisURL)
	if err != nil {
		db.Close()
		return nil, err
	}
	options.MaxRetries = -1 // 不静默重放 Redis 操作。
	rdb := redis.NewClient(options)
	s3, err := minio.New(cfg.MinioEndpoint, &minio.Options{Creds: credentials.NewStaticV4(cfg.MinioAccessKey, cfg.MinioSecretKey, ""), Secure: cfg.MinioSSL})
	if err != nil {
		db.Close()
		_ = rdb.Close()
		return nil, err
	}
	a := &App{DB: db, Redis: rdb, S3: s3, Config: cfg, startedAt: time.Now()}
	if err = a.initialize(ctx, migrations); err != nil {
		a.Close()
		return nil, err
	}
	return a, nil
}

func (a *App) applyMigrations(ctx context.Context, migrations []string) error {
	// 迁移脚本含多条 DDL；PostgreSQL 扩展协议（prepared statement）不接受多命令，
	// 迁移单独用简单协议连接执行，advisory lock 与版本表保证并发/幂等语义不变。
	conn, err := a.migrationConn(ctx)
	if err != nil {
		return err
	}
	if conn == nil {
		return pgx.BeginFunc(ctx, a.DB, func(tx pgx.Tx) error {
			return a.runMigrations(ctx, tx, migrations)
		})
	}
	defer conn.Close(ctx)
	tx, err := conn.Begin(ctx)
	if err != nil {
		return err
	}
	if err = a.runMigrations(ctx, tx, migrations); err != nil {
		_ = tx.Rollback(ctx)
		return err
	}
	return tx.Commit(ctx)
}

// migrationConn 返回简单协议连接；DSN 未配置时（测试直接构造 App）返回 nil 走 pool。
func (a *App) migrationConn(ctx context.Context) (*pgx.Conn, error) {
	if a.Config.DatabaseURL == "" {
		return nil, nil
	}
	cfg, err := pgx.ParseConfig(a.Config.DatabaseURL)
	if err != nil {
		return nil, nil
	}
	cfg.DefaultQueryExecMode = pgx.QueryExecModeSimpleProtocol
	return pgx.ConnectConfig(ctx, cfg)
}

func (a *App) runMigrations(ctx context.Context, tx pgx.Tx, migrations []string) error {
	if _, err := tx.Exec(ctx, "SELECT pg_advisory_xact_lock(hashtextextended('infinite-canvas-public-go-schema',0))"); err != nil {
		return err
	}
	var exists bool
	if err := tx.QueryRow(ctx, "SELECT to_regclass('public.platform_schema') IS NOT NULL").Scan(&exists); err != nil {
		return err
	}
	var version int
	if exists {
		if err := tx.QueryRow(ctx, "SELECT version FROM platform_schema").Scan(&version); err != nil {
			return err
		}
	} else {
		if err := tx.QueryRow(ctx, "SELECT to_regclass('public.users') IS NOT NULL").Scan(&exists); err != nil {
			return err
		}
		if exists {
			return errors.New("此数据库已包含其他后端的数据；请为 Go 公益平台创建独立空数据库")
		}
	}
	if len(migrations) > 0 && (version == 0 || version < len(migrations)) {
		// 首次建库时第一条迁移创建全部基础表，后续迁移按版本号追加。
		if version == 0 {
			if _, err := tx.Exec(ctx, migrations[0]); err != nil {
				return err
			}
			version = 1
		}
		for version < len(migrations) {
			if _, err := tx.Exec(ctx, migrations[version]); err != nil {
				return err
			}
			version++
		}
		if exists {
			if _, err := tx.Exec(ctx, "UPDATE platform_schema SET version=$1", version); err != nil {
				return err
			}
		} else {
			if _, err := tx.Exec(ctx, "CREATE TABLE platform_schema(version integer PRIMARY KEY); INSERT INTO platform_schema VALUES($1)", version); err != nil {
				return err
			}
		}
	}
	if version > len(migrations) {
		return errors.New("未知的 Go 数据库版本，拒绝覆盖")
	}
	return nil
}

func (a *App) initialize(ctx context.Context, migrations []string) error {
	if err := a.DB.Ping(ctx); err != nil {
		return err
	}
	if err := a.Redis.Ping(ctx).Err(); err != nil {
		return err
	}
	if err := a.applyMigrations(ctx, migrations); err != nil {
		return err
	}
	exists, err := a.S3.BucketExists(ctx, a.Config.Bucket)
	if err != nil {
		return err
	}
	if !exists {
		if err := a.S3.MakeBucket(ctx, a.Config.Bucket, minio.MakeBucketOptions{}); err != nil {
			if ok, _ := a.S3.BucketExists(ctx, a.Config.Bucket); !ok {
				return err
			}
		}
	}
	return a.bootstrap(ctx)
}

func (a *App) Close() {
	a.workers.Wait()
	if a.Redis != nil {
		_ = a.Redis.Close()
	}
	if a.DB != nil {
		a.DB.Close()
	}
}

func rows(ctx context.Context, q querier, query string, args ...any) ([]Row, error) {
	r, err := q.Query(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer r.Close()
	result := []Row{}
	for r.Next() {
		values, err := r.Values()
		if err != nil {
			return nil, err
		}
		row := Row{}
		for i, field := range r.FieldDescriptions() {
			value := values[i]
			switch v := value.(type) {
			case [16]byte:
				value = uuid.UUID(v).String()
			case pgtype.Numeric:
				value, _ = v.Value()
			}
			row[camel(field.Name)] = value
		}
		result = append(result, row)
	}
	return result, r.Err()
}
func one(ctx context.Context, q querier, query string, args ...any) (Row, error) {
	r, err := rows(ctx, q, query, args...)
	if err != nil {
		return nil, err
	}
	if len(r) == 0 {
		return nil, notFound
	}
	return r[0], nil
}
func camel(s string) string {
	parts := strings.Split(s, "_")
	for i := 1; i < len(parts); i++ {
		if parts[i] != "" {
			parts[i] = strings.ToUpper(parts[i][:1]) + parts[i][1:]
		}
	}
	return strings.Join(parts, "")
}
func str(v any) string {
	if v == nil {
		return ""
	}
	if s, ok := v.(string); ok {
		return s
	}
	return fmt.Sprint(v)
}
func integer(v any) int64 {
	switch n := v.(type) {
	case int64:
		return n
	case int32:
		return int64(n)
	case int:
		return int64(n)
	case float64:
		return int64(n)
	case json.Number:
		i, _ := n.Int64()
		return i
	}
	n, _ := strconv.ParseInt(str(v), 10, 64)
	return n
}
func jsonBytes(v any) []byte { b, _ := json.Marshal(v); return b }
func hash(s string) string   { sum := sha256.Sum256([]byte(s)); return hex.EncodeToString(sum[:]) }
func validID(s string) bool  { _, err := uuid.Parse(s); return err == nil }
func idParam(c *gin.Context, name string) (string, error) {
	id, err := uuid.Parse(c.Param(name))
	if err != nil {
		return "", problem(400, "invalid_id", "记录编号不正确")
	}
	return id.String(), nil
}
func body[T any](c *gin.Context, defaults ...T) (T, error) {
	var value T
	if len(defaults) > 0 {
		value = defaults[0]
	}
	if err := c.ShouldBindJSON(&value); err != nil {
		var sizeError *http.MaxBytesError
		if errors.As(err, &sizeError) {
			return value, err
		}
		return value, problem(400, "invalid_request", "请求参数不正确")
	}
	return value, nil
}
func pagination(c *gin.Context) (int, int) {
	limit, _ := strconv.Atoi(c.DefaultQuery("limit", "50"))
	offset, _ := strconv.Atoi(c.DefaultQuery("offset", "0"))
	if limit < 1 {
		limit = 50
	}
	if limit > 200 {
		limit = 200
	}
	if offset < 0 {
		offset = 0
	}
	return limit, offset
}

func (a *App) seal(value string) (string, error) {
	key := sha256.Sum256([]byte(a.Config.EncryptionKey))
	block, err := aes.NewCipher(key[:])
	if err != nil {
		return "", err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", err
	}
	nonce := make([]byte, gcm.NonceSize())
	if _, err = rand.Read(nonce); err != nil {
		return "", err
	}
	return base64.RawStdEncoding.EncodeToString(gcm.Seal(nonce, nonce, []byte(value), nil)), nil
}
func (a *App) unseal(value string) (string, error) {
	data, err := base64.RawStdEncoding.DecodeString(value)
	if err != nil {
		return "", err
	}
	key := sha256.Sum256([]byte(a.Config.EncryptionKey))
	block, err := aes.NewCipher(key[:])
	if err != nil {
		return "", err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", err
	}
	if len(data) < gcm.NonceSize() {
		return "", errors.New("密钥密文损坏")
	}
	plain, err := gcm.Open(nil, data[:gcm.NonceSize()], data[gcm.NonceSize():], nil)
	return string(plain), err
}

func respond(fn func(*gin.Context) (any, error)) gin.HandlerFunc {
	return func(c *gin.Context) {
		value, err := fn(c)
		if err != nil {
			fail(c, err)
			return
		}
		if value == nil {
			c.Status(204)
			return
		}
		c.JSON(200, value)
	}
}
func fail(c *gin.Context, err error) {
	var sizeError *http.MaxBytesError
	if errors.As(err, &sizeError) {
		c.AbortWithStatusJSON(413, gin.H{"error": "payload_too_large", "message": "请求超过平台大小限制"})
		return
	}
	var e *apiError
	if errors.As(err, &e) {
		c.AbortWithStatusJSON(e.Status, gin.H{"error": e.Code, "message": e.Message})
		return
	}
	var pg *pgconn.PgError
	if errors.As(err, &pg) {
		if pg.Code == "23505" {
			c.AbortWithStatusJSON(409, gin.H{"error": "conflict", "message": "数据已存在或请求正在执行"})
			return
		}
		if pg.Code == "23503" {
			c.AbortWithStatusJSON(409, gin.H{"error": "in_use", "message": "数据仍被其他记录引用"})
			return
		}
	}
	// 不记录请求正文、数据库参数或第三方错误，避免渠道/支付密钥回显。
	slog.Error("请求处理失败", "path", c.FullPath(), "type", fmt.Sprintf("%T", err))
	c.AbortWithStatusJSON(500, gin.H{"error": "internal_error", "message": "服务暂时不可用"})
}

func (a *App) Router() *gin.Engine {
	gin.SetMode(gin.ReleaseMode)
	r := gin.New()
	r.Use(gin.CustomRecoveryWithWriter(io.Discard, func(c *gin.Context, _ any) { fail(c, errors.New("panic")) }))
	_ = r.SetTrustedProxies(nil)
	r.Use(func(c *gin.Context) {
		c.Header("X-Content-Type-Options", "nosniff")
		c.Header("X-Frame-Options", "SAMEORIGIN")
		c.Header("Referrer-Policy", "strict-origin-when-cross-origin")
		c.Header("Cache-Control", "no-store")
		origin := c.GetHeader("Origin")
		allowed := origin == "" || origin == a.Config.PublicURL
		for _, item := range a.Config.Origins {
			if origin == strings.TrimSpace(item) {
				allowed = true
			}
		}
		callback := strings.HasPrefix(c.Request.URL.Path, "/api/payments/notify/")
		if !allowed && !callback {
			fail(c, problem(403, "invalid_origin", "请求来源不受信任"))
			return
		}
		if origin != "" && allowed {
			c.Header("Access-Control-Allow-Origin", origin)
			c.Header("Vary", "Origin")
			c.Header("Access-Control-Allow-Credentials", "true")
			c.Header("Access-Control-Allow-Headers", "Content-Type, Idempotency-Key")
			c.Header("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS")
		}
		if c.Request.Method == "OPTIONS" {
			c.AbortWithStatus(204)
			return
		}
		if c.GetHeader("Sec-Fetch-Site") == "cross-site" && origin == "" && !callback && c.Request.Method != "GET" {
			fail(c, problem(403, "invalid_origin", "请求来源不受信任"))
			return
		}
		c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, a.Config.MaxUpload)
		c.Next()
	})
	r.GET("/health", respond(func(c *gin.Context) (any, error) {
		ctx := c.Request.Context()
		if err := a.DB.Ping(ctx); err != nil {
			return nil, problem(503, "unavailable", "数据库不可用")
		}
		if err := a.Redis.Ping(ctx).Err(); err != nil {
			return nil, problem(503, "unavailable", "队列不可用")
		}
		ok, err := a.S3.BucketExists(ctx, a.Config.Bucket)
		if err != nil || !ok {
			return nil, problem(503, "unavailable", "存储不可用")
		}
		return gin.H{"status": "ok"}, nil
	}))
	a.authRoutes(r)
	a.authSecurityRoutes(r)
	a.paymentCallbacks(r)
	api := r.Group("/api", a.authenticate())
	api.GET("/status/models", respond(a.publicStatus))
	a.userRoutes(api)
	a.contentRoutes(api)
	a.generationRoutes(api)
	a.walletRoutes(api)
	a.groupRoutes(api)
	a.quoteRoutes(api)
	a.userSecurityRoutes(api)
	admin := api.Group("/admin", func(c *gin.Context) {
		if currentUser(c).Role != "admin" {
			fail(c, problem(403, "forbidden", "需要管理员权限"))
			return
		}
		c.Next()
	})
	a.adminRoutes(admin)
	a.billingAdminRoutes(admin)
	a.referralRoutes(api, admin)
	a.groupAdminRoutes(admin)
	a.groupPolicyRoutes(admin)
	a.moderationRoutes(admin)
	a.notificationRoutes(api, admin)
	a.costRoutes(admin)
	a.monitoringRoutes(admin)
	a.taskAdapterRoutes(admin)
	a.opsRoutes(admin)
	return r
}

func (a *App) audit(ctx context.Context, q querier, actor, action, target string, detail any) error {
	_, err := q.Exec(ctx, "INSERT INTO audit_logs(actor_id,action,target,detail) VALUES($1,$2,$3,$4)", actor, action, target, jsonBytes(detail))
	return err
}

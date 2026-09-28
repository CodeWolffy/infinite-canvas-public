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
	"sync/atomic"
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
	SessionDays, WorkerConcurrency, OrphanDays, LogDays, DBMaxConns      int
	MaxUpload, MaxGenerated                                              int64
	HeaderTimeout                                                        time.Duration
	// ShutdownGrace 是退出时等待在途任务收尾的最长时间。
	ShutdownGrace time.Duration
	Bucket, MinioEndpoint, MinioAccessKey, MinioSecretKey                string
	MinioSSL                                                             bool
	// MetricsAddress 为空表示不启动指标服务；非空时在该地址暴露 /metrics 与 pprof。
	MetricsAddress string
	// PreviousEncryptionKey 仅在轮换期间设置，用于解密没有版本前缀的旧密文。
	PreviousEncryptionKey string
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
	// running 保存本实例正在执行的上游请求的取消函数，键为任务 ID。
	running sync.Map
	// workersStarted 在 StartWorkers 之后置位，供 /ready 区分「进程存活」与「可以接单」。
	workersStarted atomic.Bool
	// shuttingDown 在退出信号到达后置位：在途任务按重排处理，而不是判失败退款。
	shuttingDown atomic.Bool
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
	if _, _, err := logSettings(); err != nil {
		return nil, err
	}
	cfg := Config{Address: env("LISTEN_ADDRESS", ":3001"), DatabaseURL: os.Getenv("DATABASE_URL"), RedisURL: env("REDIS_URL", "redis://redis:6379/0"),
		PublicURL: strings.TrimRight(env("PUBLIC_URL", "http://localhost:3000"), "/"), CookieName: env("COOKIE_NAME", "infinite_canvas_public_session"),
		EncryptionKey: os.Getenv("CHANNEL_ENCRYPTION_KEY"), SecureCookie: env("COOKIE_SECURE", "true") == "true",
		TrustProxy: env("TRUST_PROXY", "false") == "true", AllowPrivateHosts: env("ALLOW_PRIVATE_IMAGE_HOSTS", "false") == "true",
		Bucket: env("MINIO_BUCKET", "infinite-canvas-public"), MinioEndpoint: env("MINIO_ENDPOINT", "minio") + ":" + env("MINIO_PORT", "9000"),
		MinioAccessKey: os.Getenv("MINIO_ACCESS_KEY"), MinioSecretKey: os.Getenv("MINIO_SECRET_KEY"), MinioSSL: env("MINIO_USE_SSL", "false") == "true",
		MetricsAddress: os.Getenv("METRICS_ADDRESS")}
	if cfg.DatabaseURL == "" || len(cfg.EncryptionKey) < 32 || strings.HasPrefix(cfg.EncryptionKey, "change-me") {
		return nil, errors.New("请配置 DATABASE_URL 和独立的 CHANNEL_ENCRYPTION_KEY（至少 32 字符）")
	}
	cfg.PreviousEncryptionKey = os.Getenv("CHANNEL_ENCRYPTION_KEY_PREVIOUS")
	if cfg.PreviousEncryptionKey != "" && (len(cfg.PreviousEncryptionKey) < 32 || strings.HasPrefix(cfg.PreviousEncryptionKey, "change-me")) {
		return nil, errors.New("CHANNEL_ENCRYPTION_KEY_PREVIOUS 至少 32 字符")
	}
	u, err := url.Parse(cfg.PublicURL)
	if err != nil || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || u.Path != "" || (u.Scheme != "https" && u.Scheme != "http") {
		return nil, errors.New("PUBLIC_URL 必须为站点的完整 Origin")
	}
	if cfg.SecureCookie && u.Scheme != "https" {
		return nil, errors.New("Secure Cookie 需要 HTTPS PUBLIC_URL；本地 HTTP 请设置 COOKIE_SECURE=false")
	}
	cfg.Origins = strings.Split(env("CORS_ORIGIN", cfg.PublicURL), ",")
	for key, target := range map[string]*int{"SESSION_DAYS": &cfg.SessionDays, "ORPHAN_MEDIA_GRACE_DAYS": &cfg.OrphanDays, "REQUEST_LOG_RETENTION_DAYS": &cfg.LogDays, "DB_MAX_CONNS": &cfg.DBMaxConns} {
		defaults := map[string]int{"SESSION_DAYS": 7, "ORPHAN_MEDIA_GRACE_DAYS": 45, "REQUEST_LOG_RETENTION_DAYS": 30, "DB_MAX_CONNS": 20}
		*target, err = envInt(key, defaults[key])
		if err != nil {
			return nil, err
		}
	}
	workerKey := "WORKER_CONCURRENCY"
	if os.Getenv("WORKER_CONCURRENCY") == "" && os.Getenv("IMAGE_WORKER_CONCURRENCY") != "" {
		workerKey = "IMAGE_WORKER_CONCURRENCY"
	}
	cfg.WorkerConcurrency, err = envInt(workerKey, 20)
	if err != nil {
		return nil, err
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
	grace, err := envInt("SHUTDOWN_GRACE_SECONDS", 30)
	if err != nil {
		return nil, err
	}
	cfg.ShutdownGrace = time.Duration(grace) * time.Second
	// 沿用已有渠道默认超时；不额外引入独立的业务超时。
	cfg.HeaderTimeout = 480 * time.Second
	// 连接池默认 max(4, CPU)，而 worker、SSE 与 HTTP 请求共用同一个池，显式配置上限。
	poolConfig, err := pgxpool.ParseConfig(cfg.DatabaseURL)
	if err != nil {
		return nil, err
	}
	poolConfig.MaxConns = int32(cfg.DBMaxConns)
	poolConfig.MinConns = 2
	poolConfig.MaxConnLifetime = 30 * time.Minute
	poolConfig.MaxConnIdleTime = 5 * time.Minute
	db, err := pgxpool.NewWithConfig(ctx, poolConfig)
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
	// 先给在途任务收尾机会，超时后继续关闭连接，避免退出被长任务拖住。
	grace := a.Config.ShutdownGrace
	if grace <= 0 {
		grace = 30 * time.Second
	}
	done := make(chan struct{})
	go func() {
		a.workers.Wait()
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(grace):
		slog.Warn("等待在途任务超时，继续关闭连接", "grace", grace)
	}
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
	return paginationWith(c, 50, 200)
}

// paginationWith 让调用方自定义默认值与上限；用于画布列表这类条数更多的接口。
func paginationWith(c *gin.Context, defaultLimit, maxLimit int) (int, int) {
	limit, _ := strconv.Atoi(c.DefaultQuery("limit", strconv.Itoa(defaultLimit)))
	offset, _ := strconv.Atoi(c.DefaultQuery("offset", "0"))
	if limit < 1 {
		limit = defaultLimit
	}
	if limit > maxLimit {
		limit = maxLimit
	}
	if offset < 0 {
		offset = 0
	}
	return limit, offset
}

// cipherVersion 标记当前密文格式；轮换主密钥时靠它区分新旧格式。
const cipherVersion = "v1:"

func sealWith(key, value string) (string, error) {
	derived := sha256.Sum256([]byte(key))
	block, err := aes.NewCipher(derived[:])
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

func openWith(key, value string) (string, error) {
	data, err := base64.RawStdEncoding.DecodeString(value)
	if err != nil {
		return "", err
	}
	derived := sha256.Sum256([]byte(key))
	block, err := aes.NewCipher(derived[:])
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

func (a *App) seal(value string) (string, error) {
	sealed, err := sealWith(a.Config.EncryptionKey, value)
	if err != nil {
		return "", err
	}
	return cipherVersion + sealed, nil
}

func (a *App) unseal(value string) (string, error) {
	versioned := strings.HasPrefix(value, cipherVersion)
	plain, err := openWith(a.Config.EncryptionKey, strings.TrimPrefix(value, cipherVersion))
	if err == nil {
		return plain, nil
	}
	// 无版本前缀的旧密文允许用上一把主密钥解密，轮换期间可平滑过渡。
	if !versioned && a.Config.PreviousEncryptionKey != "" {
		if legacy, legacyErr := openWith(a.Config.PreviousEncryptionKey, value); legacyErr == nil {
			return legacy, nil
		}
	}
	return "", err
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
	if errors.Is(err, context.DeadlineExceeded) {
		c.AbortWithStatusJSON(504, gin.H{"error": "timeout", "message": "请求处理超时，请稍后重试"})
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
	slog.Error("请求处理失败", "requestId", requestIDOf(c), "method", c.Request.Method, "path", c.FullPath(), "userId", userIDOf(c), "error", truncate(err.Error(), errorLogLimit))
	c.AbortWithStatusJSON(500, gin.H{"error": "internal_error", "message": "服务暂时不可用"})
}

func (a *App) Router() *gin.Engine {
	gin.SetMode(gin.ReleaseMode)
	r := gin.New()
	r.Use(gin.CustomRecoveryWithWriter(io.Discard, func(c *gin.Context, _ any) { fail(c, errors.New("panic")) }))
	_ = r.SetTrustedProxies(nil)
	// 请求 ID 与访问日志包在来源校验外层，被拒绝的请求同样能追踪。
	r.Use(requestID())
	r.Use(a.accessLog())
	r.Use(a.requestTimeout())
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
	// 就绪探针只看进程自身状态：依赖不可用时 /health 已经会失败，这里不再重复探测。
	r.GET("/ready", func(c *gin.Context) {
		if a.startedAt.IsZero() || !a.workersStarted.Load() {
			c.JSON(503, gin.H{"status": "starting"})
			return
		}
		c.JSON(200, gin.H{"status": "ready"})
	})
	a.authRoutes(r)
	a.authSecurityRoutes(r)
	a.paymentCallbacks(r)
	// 公开只读分享：token 即权限，不走会话鉴权；只暴露被显式分享的资源。
	a.publicShareRoutes(r)
	api := r.Group("/api", a.authenticate())
	api.GET("/status/models", respond(a.publicStatus))
	a.userRoutes(api)
	a.contentRoutes(api)
	a.workspaceRoutes(api)
	a.shareRoutes(api)
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
	admin.Use(a.adminAudit())
	a.adminRoutes(admin)
	a.templateRoutes(api, admin)
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

// adminAudit 兜底记录管理后台所有成功的写请求；不落请求体，只记查询串、状态码与请求 ID。
func (a *App) adminAudit() gin.HandlerFunc {
	return func(c *gin.Context) {
		c.Next()
		if c.Request.Method == http.MethodGet || c.Writer.Status() >= 400 {
			return
		}
		target := ""
		if len(c.Params) > 0 {
			target = c.Params[0].Value
		}
		ctx := context.WithoutCancel(c.Request.Context())
		detail := gin.H{"query": c.Request.URL.RawQuery, "status": c.Writer.Status(), "requestId": requestIDOf(c)}
		if err := a.audit(ctx, a.DB, currentUser(c).ID, "http."+c.Request.Method+" "+c.FullPath(), target, detail); err != nil {
			slog.Warn("管理操作审计写入失败", "path", c.FullPath(), "error", err)
		}
	}
}

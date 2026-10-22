package platform

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"net/http/pprof"
	"os"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promhttp"
)

const (
	requestIDHeader = "X-Request-ID"
	requestIDKey    = "requestId"
	// 错误日志只保留前 500 字符，避免上游把整段响应写进日志。
	errorLogLimit = 500
)

var (
	httpRequestsTotal = prometheus.NewCounterVec(prometheus.CounterOpts{
		Name: "ic_http_requests_total", Help: "HTTP 请求总数",
	}, []string{"route", "method", "status"})
	httpRequestDuration = prometheus.NewHistogramVec(prometheus.HistogramOpts{
		Name: "ic_http_request_duration_seconds", Help: "HTTP 请求耗时", Buckets: prometheus.DefBuckets,
	}, []string{"route"})
	tasksQueuedGauge       = prometheus.NewGauge(prometheus.GaugeOpts{Name: "ic_tasks_queued", Help: "排队中的生成任务数"})
	tasksRunningGauge      = prometheus.NewGauge(prometheus.GaugeOpts{Name: "ic_tasks_running", Help: "执行中的生成任务数"})
	tasksOldestQueuedGauge = prometheus.NewGauge(prometheus.GaugeOpts{Name: "ic_tasks_oldest_queued_seconds", Help: "最老排队任务的等待秒数"})
	upstreamAttemptsTotal  = prometheus.NewCounterVec(prometheus.CounterOpts{
		Name: "ic_upstream_attempts_total", Help: "上游渠道调用尝试次数",
	}, []string{"channel_id", "category"})
	paymentNotifyTotal = prometheus.NewCounterVec(prometheus.CounterOpts{
		Name: "ic_payment_notify_total", Help: "支付回调处理结果",
	}, []string{"provider", "result"})
)

func init() {
	prometheus.MustRegister(httpRequestsTotal, httpRequestDuration, tasksQueuedGauge, tasksRunningGauge, tasksOldestQueuedGauge, upstreamAttemptsTotal, paymentNotifyTotal)
}

var requestIDPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)

// logSettings 解析日志级别与格式，供 main 与 New 共用一份校验口径。
func logSettings() (slog.Level, string, error) {
	level := slog.LevelInfo
	switch value := strings.ToLower(env("LOG_LEVEL", "info")); value {
	case "debug":
		level = slog.LevelDebug
	case "info":
	case "warn":
		level = slog.LevelWarn
	case "error":
		level = slog.LevelError
	default:
		return level, "", errors.New("LOG_LEVEL 必须为 debug、info、warn 或 error")
	}
	format := strings.ToLower(env("LOG_FORMAT", "text"))
	if format != "text" && format != "json" {
		return level, format, errors.New("LOG_FORMAT 必须为 text 或 json")
	}
	return level, format, nil
}

// NewLogger 按 LOG_LEVEL 与 LOG_FORMAT 构造默认日志处理器。
func NewLogger() (*slog.Logger, error) {
	level, format, err := logSettings()
	if err != nil {
		return nil, err
	}
	options := &slog.HandlerOptions{Level: level}
	if format == "json" {
		return slog.New(slog.NewJSONHandler(os.Stdout, options)), nil
	}
	return slog.New(slog.NewTextHandler(os.Stdout, options)), nil
}

func requestIDOf(c *gin.Context) string {
	if value, ok := c.Get(requestIDKey); ok {
		return str(value)
	}
	return ""
}

func userIDOf(c *gin.Context) string {
	if value, ok := c.Get("user"); ok {
		if user, ok := value.(User); ok {
			return user.ID
		}
	}
	return ""
}

// requestTimeout 给普通接口加统一处理时限；SSE 长连接、大文件上传下载与需要等上游的检测接口不设限。
const requestTimeout = 60 * time.Second

var slowRoutes = map[string]bool{
	"/api/text/requests/:id/events":       true,
	"/api/generation-batches/:id/events":  true,
	"/api/shared/:token/media/:mediaId":   true,
	"/api/media":                          true,
	"/api/media/:id":                      true,
	"/api/admin/playground/test":    true,
	"/api/admin/channels/:id/check": true,
	"/api/admin/channels/check-all": true,
	// 拉取上游模型列表要等上游响应，受渠道自身超时约束，不套 60 秒时限。
	"/api/admin/channels/:id/models": true,
}

func (a *App) requestTimeout() gin.HandlerFunc {
	return func(c *gin.Context) {
		if slowRoutes[c.FullPath()] {
			c.Next()
			return
		}
		ctx, cancel := context.WithTimeout(c.Request.Context(), requestTimeout)
		defer cancel()
		c.Request = c.Request.WithContext(ctx)
		c.Next()
	}
}

// requestID 采用上游传入的合法请求 ID，否则生成一个，便于串联访问日志与错误日志。
func requestID() gin.HandlerFunc {
	return func(c *gin.Context) {
		id := c.GetHeader(requestIDHeader)
		if !requestIDPattern.MatchString(id) {
			id = uuid.NewString()
		}
		c.Set(requestIDKey, id)
		c.Header(requestIDHeader, id)
		c.Next()
	}
}

// sseEventsPath 是长连接路由，既不计时也不记访问日志，避免污染指标与刷屏。
func sseEventsPath(c *gin.Context) bool {
	switch c.FullPath() {
	case "/api/text/requests/:id/events", "/api/generation-batches/:id/events":
		return true
	}
	return false
}

func silentPath(c *gin.Context) bool {
	switch c.FullPath() {
	case "/health", "/ready", "/metrics":
		return true
	}
	return false
}

func (a *App) accessLog() gin.HandlerFunc {
	return func(c *gin.Context) {
		start := time.Now()
		c.Next()
		route := c.FullPath()
		if route == "" {
			route = "unmatched"
		}
		if sseEventsPath(c) {
			return
		}
		status := c.Writer.Status()
		duration := time.Since(start)
		httpRequestsTotal.WithLabelValues(route, c.Request.Method, strconv.Itoa(status)).Inc()
		httpRequestDuration.WithLabelValues(route).Observe(duration.Seconds())
		if silentPath(c) {
			return
		}
		slog.Info("http", "requestId", requestIDOf(c), "method", c.Request.Method, "path", route,
			"status", status, "durationMs", duration.Milliseconds(), "userId", userIDOf(c))
	}
}

func truncate(value string, limit int) string {
	if len(value) <= limit {
		return value
	}
	return value[:limit]
}

// logExec 执行清理类语句并记录失败原因；这类语句失败不应中断整轮清理。
func (a *App) logExec(ctx context.Context, name, query string, args ...any) {
	if _, err := a.DB.Exec(ctx, query, args...); err != nil {
		slog.Warn("清理语句失败", "statement", name, "error", err)
	}
}

// startMetrics 在独立端口暴露 /metrics 与 pprof；METRICS_ADDRESS 为空时保持关闭。
func (a *App) startMetrics(ctx context.Context) {
	address := a.Config.MetricsAddress
	if address == "" {
		return
	}
	mux := http.NewServeMux()
	mux.Handle("/metrics", promhttp.Handler())
	mux.HandleFunc("/debug/pprof/", pprof.Index)
	mux.HandleFunc("/debug/pprof/cmdline", pprof.Cmdline)
	mux.HandleFunc("/debug/pprof/profile", pprof.Profile)
	mux.HandleFunc("/debug/pprof/symbol", pprof.Symbol)
	mux.HandleFunc("/debug/pprof/trace", pprof.Trace)
	server := &http.Server{Addr: address, Handler: mux, ReadHeaderTimeout: 10 * time.Second}
	a.workers.Add(1)
	go func() {
		defer a.workers.Done()
		slog.Info("指标服务已启动", "address", address)
		if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			slog.Error("指标服务停止", "error", err)
		}
	}()
	a.workers.Add(1)
	go func() {
		defer a.workers.Done()
		<-ctx.Done()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = server.Shutdown(shutdownCtx)
	}()
}

// startMetricsSampler 每 10 秒刷新队列指标；查询失败只记日志，不影响 worker。
func (a *App) startMetricsSampler(ctx context.Context) {
	sample := func() {
		row, err := one(ctx, a.DB, `SELECT count(*) FILTER(WHERE status='queued')::bigint AS queued,
			count(*) FILTER(WHERE status='running')::bigint AS running,
			coalesce(extract(epoch FROM(now()-min(queued_at) FILTER(WHERE status='queued'))),0)::bigint AS oldest_queued_seconds
			FROM generation_tasks WHERE status IN ('queued','running')`)
		if err != nil {
			if ctx.Err() == nil {
				slog.Warn("队列指标采集失败", "error", err)
			}
			return
		}
		tasksQueuedGauge.Set(float64(integer(row["queued"])))
		tasksRunningGauge.Set(float64(integer(row["running"])))
		tasksOldestQueuedGauge.Set(float64(integer(row["oldestQueuedSeconds"])))
	}
	sample()
	a.workers.Add(1)
	go func() {
		defer a.workers.Done()
		ticker := time.NewTicker(10 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				sample()
			}
		}
	}()
}

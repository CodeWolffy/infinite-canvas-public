package main

import (
	"context"
	_ "embed"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"

	"infinite-canvas-public/server/internal/platform"
)

//go:embed migrations/001_platform.sql
var schema string

//go:embed migrations/002_token_pricing.sql
var tokenPricing string

//go:embed migrations/003_platform_features.sql
var platformFeatures string

//go:embed migrations/004_platform_operations.sql
var platformOperations string

//go:embed migrations/005_platform_ops.sql
var platformOps string

//go:embed migrations/006_storage_quota.sql
var storageQuota string

func main() {
	if len(os.Args) > 1 && os.Args[1] == "health" {
		response, err := http.Get("http://127.0.0.1:3001/health")
		if err != nil {
			os.Exit(1)
		}
		defer response.Body.Close()
		if response.StatusCode != http.StatusOK {
			os.Exit(1)
		}
		return
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	app, err := platform.New(ctx, []string{schema, tokenPricing, platformFeatures, platformOperations, platformOps, storageQuota})
	if err != nil {
		slog.Error("平台启动失败", "error", err)
		os.Exit(1)
	}
	server := &http.Server{Addr: app.Config.Address, Handler: app.Router(), ReadHeaderTimeout: app.Config.HeaderTimeout}
	app.StartWorkers(ctx)
	go func() {
		<-ctx.Done()
		_ = server.Shutdown(context.Background())
	}()
	slog.Info("Go 创作平台已启动", "address", app.Config.Address)
	if err = server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		slog.Error("HTTP 服务停止", "error", err)
	}
	app.Close()
}

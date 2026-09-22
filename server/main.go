package main

import (
	"context"
	"embed"
	"io/fs"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"path"
	"strings"
	"syscall"

	"infinite-canvas-public/server/internal/platform"
)

//go:embed migrations/*.sql
var migrationFS embed.FS

// loadMigrations 读取全部迁移脚本并按文件名排序；版本号即切片下标加一，顺序由文件名前缀保证。
func loadMigrations(fsys fs.FS) ([]string, error) {
	entries, err := fs.ReadDir(fsys, "migrations")
	if err != nil {
		return nil, err
	}
	migrations := make([]string, 0, len(entries))
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".sql") {
			continue
		}
		content, err := fs.ReadFile(fsys, path.Join("migrations", entry.Name()))
		if err != nil {
			return nil, err
		}
		migrations = append(migrations, string(content))
	}
	return migrations, nil
}

func main() {
	if len(os.Args) > 1 {
		switch os.Args[1] {
		case "health":
			healthCheck()
			return
		case "rotate-keys":
			rotateKeys()
			return
		}
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	logger, err := platform.NewLogger()
	if err != nil {
		slog.Error("日志配置不正确", "error", err)
		os.Exit(1)
	}
	slog.SetDefault(logger)
	migrations, err := loadMigrations(migrationFS)
	if err != nil {
		slog.Error("读取迁移脚本失败", "error", err)
		os.Exit(1)
	}
	app, err := platform.New(ctx, migrations)
	if err != nil {
		slog.Error("平台启动失败", "error", err)
		os.Exit(1)
	}
	server := &http.Server{Addr: app.Config.Address, Handler: app.Router(), ReadHeaderTimeout: app.Config.HeaderTimeout}
	app.StartWorkers(ctx)
	go func() {
		<-ctx.Done()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), app.Config.ShutdownGrace)
		defer cancel()
		if err := server.Shutdown(shutdownCtx); err != nil {
			slog.Warn("HTTP 服务未能优雅关闭", "error", err)
		}
	}()
	slog.Info("Go 创作平台已启动", "address", app.Config.Address)
	if err = server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		slog.Error("HTTP 服务停止", "error", err)
	}
	app.Close()
}

func healthCheck() {
	response, err := http.Get("http://127.0.0.1:3001/health")
	if err != nil {
		os.Exit(1)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		os.Exit(1)
	}
}

// rotateKeys 用 CHANNEL_ENCRYPTION_KEY 重新加密全部密文列；旧密钥通过 CHANNEL_ENCRYPTION_KEY_PREVIOUS 提供。
func rotateKeys() {
	logger, err := platform.NewLogger()
	if err != nil {
		slog.Error("日志配置不正确", "error", err)
		os.Exit(1)
	}
	slog.SetDefault(logger)
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	migrations, err := loadMigrations(migrationFS)
	if err != nil {
		slog.Error("读取迁移脚本失败", "error", err)
		os.Exit(1)
	}
	app, err := platform.New(ctx, migrations)
	if err != nil {
		slog.Error("平台启动失败", "error", err)
		os.Exit(1)
	}
	defer app.Close()
	results, err := app.RotateKeys(ctx)
	for _, item := range results {
		slog.Info("密钥已重加密", "table", item.Table, "column", item.Column, "rows", item.Rows)
	}
	if err != nil {
		slog.Error("密钥轮换失败", "error", err)
		os.Exit(1)
	}
	slog.Info("密钥轮换完成")
}

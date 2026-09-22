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
		_ = server.Shutdown(context.Background())
	}()
	slog.Info("Go 创作平台已启动", "address", app.Config.Address)
	if err = server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		slog.Error("HTTP 服务停止", "error", err)
	}
	app.Close()
}

package platform

import (
	"context"
	"os"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

// loadMigrationScripts 按文件名顺序读取迁移目录，与 main.go 的 embed 顺序保持一致。
func loadMigrationScripts(t *testing.T) []string {
	t.Helper()
	entries, err := os.ReadDir("../../migrations")
	if err != nil {
		t.Fatal(err)
	}
	scripts := []string{}
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".sql") {
			continue
		}
		content, err := os.ReadFile("../../migrations/" + entry.Name())
		if err != nil {
			t.Fatal(err)
		}
		scripts = append(scripts, string(content))
	}
	if len(scripts) == 0 {
		t.Fatal("migrations 目录为空")
	}
	return scripts
}

// 迁移必须能从空库升到最新版本，重复执行保持幂等；这两点都是升级路径的实际要求。
func TestMigrationsUpgradeFromEmptyDatabase(t *testing.T) {
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("需要独立的 TEST_DATABASE_URL")
	}
	ctx := context.Background()
	database := "test_migrate_" + strings.ReplaceAll(uuid.NewString(), "-", "_")
	admin, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer admin.Close()
	if _, err = admin.Exec(ctx, "CREATE DATABASE "+database); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _, _ = admin.Exec(context.Background(), "DROP DATABASE "+database+" WITH (FORCE)") })
	base, query := dsn, ""
	if parts := strings.SplitN(dsn, "?", 2); len(parts) == 2 {
		base, query = parts[0], parts[1]
	}
	if slash := strings.LastIndex(base, "/"); slash >= 0 {
		base = base[:slash+1] + database
	}
	config, err := pgxpool.ParseConfig(base + "?" + query)
	if err != nil {
		t.Fatal(err)
	}
	db, err := pgxpool.NewWithConfig(ctx, config)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	scripts := loadMigrationScripts(t)
	// 带上 DatabaseURL 才会走生产用的简单协议连接：建库阶段有一条多命令语句，
	// 扩展协议不接受多命令。
	app := &App{DB: db, Config: Config{DatabaseURL: base + "?" + query}}
	if err = app.applyMigrations(ctx, scripts); err != nil {
		t.Fatal("空库升级失败: ", err)
	}
	var version int
	if err = db.QueryRow(ctx, "SELECT version FROM platform_schema").Scan(&version); err != nil {
		t.Fatal(err)
	}
	if version != len(scripts) {
		t.Fatalf("升级后版本应为 %d，实际 %d", len(scripts), version)
	}
	var hasView bool
	if err = db.QueryRow(ctx, "SELECT to_regclass('public.available_model_channels') IS NOT NULL").Scan(&hasView); err != nil || !hasView {
		t.Fatalf("可用渠道视图未创建: %v", err)
	}
	// 再次执行应直接跳过，不报错也不改版本。
	if err = app.applyMigrations(ctx, scripts); err != nil {
		t.Fatal("重复迁移应保持幂等: ", err)
	}
	if err = db.QueryRow(ctx, "SELECT version FROM platform_schema").Scan(&version); err != nil || version != len(scripts) {
		t.Fatalf("重复迁移后版本被改动: %d %v", version, err)
	}
}

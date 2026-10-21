package main

import (
	"os"
	"strings"
	"testing"
)

// 迁移数量必须与目录中的脚本文件数一致，避免新增迁移后漏注册。
func TestLoadMigrationsMatchesDirectory(t *testing.T) {
	migrations, err := loadMigrations(migrationFS)
	if err != nil {
		t.Fatal(err)
	}
	entries, err := os.ReadDir("migrations")
	if err != nil {
		t.Fatal(err)
	}
	count := 0
	for _, entry := range entries {
		if !entry.IsDir() && strings.HasSuffix(entry.Name(), ".sql") {
			content, err := os.ReadFile("migrations/" + entry.Name())
			if err != nil {
				t.Fatal(err)
			}
			if count >= len(migrations) || migrations[count] != string(content) {
				t.Fatalf("迁移 %s 的内容或加载顺序不一致", entry.Name())
			}
			count++
		}
	}
	if count == 0 || len(migrations) != count {
		t.Fatalf("迁移数量 %d，目录脚本数 %d", len(migrations), count)
	}
	if !strings.Contains(migrations[0], "CREATE TABLE users") {
		t.Fatal("第一条迁移应创建基础表")
	}
}

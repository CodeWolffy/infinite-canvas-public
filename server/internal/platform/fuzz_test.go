package platform

import (
	"encoding/json"
	"testing"
)

// 上游错误响应格式多变，解析必须对任意输入保持不 panic，并且不能回显渠道密钥。
func FuzzResponseError(f *testing.F) {
	seeds := []string{
		`{"error":{"code":"invalid_api_key","message":"Incorrect API key provided: sk-secret"}}`,
		`{"error":{"type":"rate_limit_error","message":"Rate limit reached"}}`,
		`{"error":"plain string error"}`,
		`{"message":"模型不存在"}`,
		`{"msg":"配额不足","code":40001}`,
		`{"error":{"code":"content_policy_violation"}}`,
		`not json at all`,
		``,
	}
	for _, seed := range seeds {
		f.Add(seed)
	}
	f.Fuzz(func(t *testing.T, raw string) {
		payload := map[string]any{}
		if err := json.Unmarshal([]byte(raw), &payload); err != nil {
			payload = map[string]any{}
		}
		failure := responseError(500, payload, raw, "sk-secret")
		if failure == nil {
			t.Fatal("应始终返回错误分类")
		}
		if failure.Category == "" {
			t.Fatal("错误分类不能为空")
		}
	})
}

// 生成结果里的媒体引用可能出现在任意嵌套结构中，抽取必须对任意 JSON 保持不 panic。
func FuzzExtractMediaIDs(f *testing.F) {
	seeds := []string{
		`{"mediaId":"6f1b0a2e-3c4d-4e5f-8a9b-0c1d2e3f4a5b"}`,
		`{"data":[{"mediaIds":["6f1b0a2e-3c4d-4e5f-8a9b-0c1d2e3f4a5b","bad-id"]}]}`,
		`{"url":"https://example.com/api/media/6f1b0a2e-3c4d-4e5f-8a9b-0c1d2e3f4a5b"}`,
		`{"storageKey":"image:6f1b0a2e-3c4d-4e5f-8a9b-0c1d2e3f4a5b"}`,
		`{"nested":{"deep":[{"fileId":"6f1b0a2e-3c4d-4e5f-8a9b-0c1d2e3f4a5b"}]}}`,
		`[]`,
		`null`,
		`{"mediaId":123}`,
	}
	for _, seed := range seeds {
		f.Add(seed)
	}
	f.Fuzz(func(t *testing.T, raw string) {
		var value any
		if err := json.Unmarshal([]byte(raw), &value); err != nil {
			value = raw
		}
		ids := extractMediaIDs(value)
		for _, id := range ids {
			if !validID(id) {
				t.Fatalf("抽取出非 UUID 的媒体编号: %s", id)
			}
		}
	})
}

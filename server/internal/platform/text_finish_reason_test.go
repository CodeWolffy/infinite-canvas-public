package platform

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/tmaxmax/go-sse"
)

func finishReasonStream(t *testing.T, protocol string, events ...string) (generationResult, error) {
	t.Helper()
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		for _, event := range events {
			_, _ = fmt.Fprintf(w, "data: %s\n\n", event)
		}
	}))
	defer upstream.Close()
	req, err := http.NewRequestWithContext(context.Background(), "POST", upstream.URL, nil)
	if err != nil {
		t.Fatal(err)
	}
	a := &App{Config: Config{AllowPrivateHosts: true, MaxGenerated: 50 * 1024 * 1024}}
	return a.streamText(context.Background(), req, channel{Protocol: protocol}, Row{"probe": true})
}

func TestTextStreamFinishReasons(t *testing.T) {
	for _, test := range []struct {
		name, protocol, reason string
		events                 []string
	}{
		{"chat_stop", "openai", "stop", []string{`{"choices":[{"delta":{"content":"正文"},"finish_reason":"stop"}]}`, `[DONE]`}},
		{"chat_length", "openai", "length", []string{`{"choices":[{"delta":{"content":"正文"},"finish_reason":"length"}]}`, `[DONE]`}},
		{"chat_other_reason", "openai", "tool_calls", []string{`{"choices":[{"delta":{"content":"正文"},"finish_reason":"tool_calls"}]}`, `[DONE]`}},
		{"gemini_stop", "gemini", "stop", []string{`{"candidates":[{"content":{"parts":[{"text":"正文"}]},"finishReason":"STOP"}]}`}},
		{"gemini_length", "gemini", "length", []string{`{"candidates":[{"content":{"parts":[{"text":"正文"}]},"finishReason":"MAX_TOKENS"}]}`}},
		{"anthropic_stop", "anthropic", "stop", []string{`{"type":"content_block_delta","delta":{"type":"text_delta","text":"正文"}}`, `{"type":"message_delta","delta":{"stop_reason":"end_turn"}}`, `{"type":"message_stop"}`}},
		{"anthropic_length", "anthropic", "length", []string{`{"type":"content_block_delta","delta":{"type":"text_delta","text":"正文"}}`, `{"type":"message_delta","delta":{"stop_reason":"max_tokens"}}`, `{"type":"message_stop"}`}},
		{"responses_stop", "openai", "stop", []string{`{"type":"response.output_text.delta","delta":"正文"}`, `{"type":"response.completed","response":{"status":"completed"}}`}},
		{"responses_length", "openai", "length", []string{`{"type":"response.output_text.delta","delta":"正文"}`, `{"type":"response.incomplete","response":{"status":"incomplete","incomplete_details":{"reason":"max_output_tokens"},"output":[{"type":"message","content":[{"type":"output_text","text":"正文"}]}]}}`}},
		{"responses_terminal_text", "openai", "length", []string{`{"type":"response.incomplete","response":{"status":"incomplete","incomplete_details":{"reason":"max_output_tokens"},"output":[{"type":"message","content":[{"type":"output_text","text":"正文"}]}]}}`}},
		{"responses_done_length", "openai", "length", []string{`{"type":"response.output_text.delta","delta":"正文"}`, `{"type":"response.done","response":{"status":"incomplete","incomplete_details":{"reason":"max_output_tokens"}}}`}},
	} {
		t.Run(test.name, func(t *testing.T) {
			result, err := finishReasonStream(t, test.protocol, test.events...)
			if err != nil || result.Text != "正文" || result.FinishReason != test.reason {
				t.Fatalf("result=%+v error=%v", result, err)
			}
		})
	}
}

func TestTextStreamRejectsUnfinishedResponses(t *testing.T) {
	for _, test := range []struct {
		name, protocol, category string
		events                   []string
	}{
		{"missing_terminal", "openai", "stream_interrupted", []string{`{"type":"response.output_text.delta","delta":"正文"}`}},
		{"unknown_incomplete", "openai", "stream_interrupted", []string{`{"type":"response.output_text.delta","delta":"正文"}`, `{"type":"response.incomplete","response":{"incomplete_details":{"reason":"unknown"}}}`, `[DONE]`}},
		{"missing_reason", "openai", "stream_interrupted", []string{`{"type":"response.output_text.delta","delta":"正文"}`, `{"type":"response.incomplete","response":{}}`, `[DONE]`}},
		{"filtered", "openai", "content_policy", []string{`{"type":"response.output_text.delta","delta":"正文"}`, `{"type":"response.incomplete","response":{"incomplete_details":{"reason":"content_filter"}}}`, `[DONE]`}},
		{"failed", "openai", "", []string{`{"type":"response.output_text.delta","delta":"正文"}`, `{"type":"response.failed","response":{"status":"failed","error":{"code":"server_error","message":"failed"}}}`, `[DONE]`}},
		{"done_in_progress", "openai", "stream_interrupted", []string{`{"type":"response.output_text.delta","delta":"正文"}`, `{"type":"response.done","response":{"status":"in_progress"}}`, `[DONE]`}},
		{"length_without_text", "openai", "stream_interrupted", []string{`{"type":"response.incomplete","response":{"incomplete_details":{"reason":"max_output_tokens"}}}`}},
		{"anthropic_missing_stop", "anthropic", "stream_interrupted", []string{`{"type":"content_block_delta","delta":{"type":"text_delta","text":"正文"}}`, `{"type":"message_delta","delta":{"stop_reason":"max_tokens"}}`}},
		{"gemini_filtered", "gemini", "content_policy", []string{`{"candidates":[{"content":{"parts":[{"text":"正文"}]},"finishReason":"SAFETY"}]}`}},
		{"chat_filtered", "openai", "content_policy", []string{`{"choices":[{"delta":{"content":"正文"},"finish_reason":"content_filter"}]}`}},
	} {
		t.Run(test.name, func(t *testing.T) {
			result, err := finishReasonStream(t, test.protocol, test.events...)
			if err == nil || result.FinishReason != "" || test.category != "" && classify(err).Category != test.category {
				t.Fatalf("invalid terminal event succeeded: %+v error=%v", result, err)
			}
		})
	}
}

func TestResponsesLengthPreservesUsage(t *testing.T) {
	result, err := finishReasonStream(t, "openai",
		`{"type":"response.output_text.delta","delta":"正文"}`,
		`{"type":"response.in_progress","response":{"usage":{"input_tokens":100,"input_tokens_details":{"cached_tokens":80}}}}`,
		`{"type":"response.incomplete","response":{"status":"incomplete","incomplete_details":{"reason":"max_output_tokens"},"usage":{"output_tokens":5}}}`)
	if err != nil || result.Text != "正文" || result.FinishReason != "length" || result.PromptTokens != 100 || result.CachedTokens != 80 || result.CompletionTokens != 5 {
		t.Fatalf("length response lost text or usage: %+v error=%v", result, err)
	}
}

func TestResponsesJSONFinishReasons(t *testing.T) {
	for _, test := range []struct {
		name, status, incomplete, reason string
	}{
		{"completed", "completed", "", "stop"},
		{"length", "incomplete", "max_output_tokens", "length"},
		{"unknown_incomplete", "incomplete", "unknown", ""},
		{"still_running", "in_progress", "", ""},
	} {
		t.Run(test.name, func(t *testing.T) {
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				_ = json.NewEncoder(w).Encode(Row{"object": "response", "status": test.status, "incomplete_details": Row{"reason": test.incomplete}, "output": []any{Row{"type": "message", "content": []any{Row{"type": "output_text", "text": "正文"}}}}, "usage": Row{"input_tokens": 100, "output_tokens": 5}})
			}))
			defer upstream.Close()
			req, err := http.NewRequestWithContext(context.Background(), "POST", upstream.URL, nil)
			if err != nil {
				t.Fatal(err)
			}
			a := &App{Config: Config{AllowPrivateHosts: true, MaxGenerated: 50 * 1024 * 1024}}
			result, err := a.streamText(context.Background(), req, channel{Protocol: "openai"}, Row{"probe": true})
			if test.reason == "" {
				if err == nil {
					t.Fatalf("unfinished response succeeded: %+v", result)
				}
			} else if err != nil || result.Text != "正文" || result.FinishReason != test.reason || result.PromptTokens != 100 || result.CompletionTokens != 5 {
				t.Fatalf("result=%+v error=%v", result, err)
			}
		})
	}
}

func TestTextLengthFinishReasonSettlesOnce(t *testing.T) {
	a := testApp(t)
	ctx := context.Background()
	user, cookie := testUser(t, a, moneyScale)
	task := securityTextTask(t, a, user, moneyScale)
	if _, err := a.DB.Exec(ctx, "UPDATE generation_tasks SET pricing_kind='token',input_price_per_million=1000000,cached_price_per_million=250000,output_price_per_million=2000000 WHERE id=$1", task["id"]); err != nil {
		t.Fatal(err)
	}
	result := &generationResult{Text: "保留的正文", FinishReason: "length", PromptTokens: 100, CachedTokens: 80, CompletionTokens: 5}
	for range 2 {
		if err := a.finishTask(ctx, task, nil, result, nil); err != nil {
			t.Fatal(err)
		}
	}
	testBalance(t, a, user, moneyScale-50, 0)
	stored, err := one(ctx, a.DB, "SELECT status,finish_reason,billed_micros,prompt_tokens,cached_tokens,completion_tokens FROM generation_tasks WHERE id=$1", task["id"])
	if err != nil || stored["status"] != "succeeded" || stored["finishReason"] != "length" || integer(stored["billedMicros"]) != 50 || integer(stored["promptTokens"]) != 100 || integer(stored["cachedTokens"]) != 80 || integer(stored["completionTokens"]) != 5 {
		t.Fatalf("settlement: %+v error=%v", stored, err)
	}
	var messages, charges int
	if err := a.DB.QueryRow(ctx, "SELECT count(*) FROM messages WHERE conversation_id=$1 AND role='assistant'", task["conversationId"]).Scan(&messages); err != nil || messages != 1 {
		t.Fatalf("messages=%d error=%v", messages, err)
	}
	if err := a.DB.QueryRow(ctx, "SELECT count(*) FROM wallet_entries WHERE user_id=$1 AND kind='charge'", user).Scan(&charges); err != nil || charges != 1 {
		t.Fatalf("charges=%d error=%v", charges, err)
	}
	response := testRequest(a.Router(), "GET", "/api/text/requests/"+str(task["id"])+"/events", nil, cookie)
	if response.Code != http.StatusOK {
		t.Fatal(response.Body)
	}
	snapshots := 0
	for event, err := range sse.Read(strings.NewReader(response.Body.String()), nil) {
		if err != nil {
			t.Fatal(err)
		}
		if event.Type != "snapshot" {
			continue
		}
		var payload Row
		if err := json.Unmarshal([]byte(event.Data), &payload); err != nil {
			t.Fatal(err)
		}
		request, message := object(payload["request"]), object(payload["message"])
		if request["finishReason"] != "length" || message["finishReason"] != "length" || message["content"] != result.Text {
			t.Fatalf("snapshot lost result metadata: %+v", payload)
		}
		snapshots++
	}
	if snapshots != 1 {
		t.Fatalf("snapshots=%d", snapshots)
	}
}

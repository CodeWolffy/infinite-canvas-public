package platform

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/google/uuid"
	"github.com/shopspring/decimal"
)

func TestModelPricePrecision(t *testing.T) {
	for _, sample := range []struct {
		micros int64
		want   string
	}{{0, "0"}, {8000, "0.008"}, {1, "0.000001"}, {1050000, "1.05"}, {1<<63 - 1, "9223372036854.775807"}} {
		if got := modelPrice(sample.micros); got != sample.want {
			t.Fatalf("price=%s, want %s", got, sample.want)
		}
	}
}

func TestConfiguredTextParameters(t *testing.T) {
	model := Row{"capability": "text", "config": Row{"maxOutputTokens": 128, "reasoningEfforts": []string{"high"}}, "priceMicros": 0, "inputPricePerMillion": 0, "outputPricePerMillion": 1000000}
	input := Row{"max_tokens": 1, "max_completion_tokens": 999999, "maxOutputTokens": 999999, "reasoningEffort": "high"}
	params, err := modelTextParameters(model, input)
	if err != nil || explicitTextTokens(params) != 128 || params["max_completion_tokens"] != nil || params["maxOutputTokens"] != nil || params["reasoningEffort"] != "high" {
		t.Fatalf("params=%v error=%v", params, err)
	}
	if input["max_tokens"] != 1 || input["max_completion_tokens"] != 999999 {
		t.Fatal("normalization changed the input used for idempotency")
	}
	pricing, err := pricingSnapshot(model, decimal.NewFromInt(1), params, 0)
	if err != nil || integer(pricing["priceMicros"]) != 128 {
		t.Fatalf("pricing=%v error=%v", pricing, err)
	}
	for _, invalid := range []any{nil, 0, -1, 1.5, "invalid", "9223372036854775808"} {
		if _, err := modelTextParameters(Row{"config": Row{"maxOutputTokens": invalid}}, input); err == nil {
			t.Fatalf("accepted invalid administrator limit %v", invalid)
		}
	}
}

func TestTextQuoteAndRequestUseConfiguredLimit(t *testing.T) {
	a := routingApp(t)
	ctx := context.Background()
	user, cookie := testUser(t, a, moneyScale)
	model, _ := capabilityModel(t, a, "text", "https://text.example", 8000)
	router := a.Router()
	models := responseRow(t, testRequest(router, "GET", "/api/models", nil, cookie))["models"].([]any)
	if len(models) != 1 || object(models[0])["price"] != "0.008" || object(models[0])["pricePerImage"] != "0.008" {
		t.Fatalf("incorrect model price: %v", models)
	}
	if _, err := a.DB.Exec(ctx, "UPDATE models SET config='{}',price_micros=0,input_price_per_million=0,output_price_per_million=1000000 WHERE id=$1", model); err != nil {
		t.Fatal(err)
	}
	params := Row{"max_tokens": 1, "max_completion_tokens": 999999, "maxOutputTokens": 999999, "reasoningEffort": "high"}
	request := Row{"requestId": uuid.NewString(), "modelId": model, "content": "hello", "parameters": params}
	quote := Row{"modelId": model, "count": 1, "content": "hello", "parameters": params}
	for path, payload := range map[string]Row{"/api/text/requests": request, "/api/generation-quote": quote} {
		response := testRequest(router, "POST", path, payload, cookie)
		if response.Code != 400 {
			t.Fatalf("missing model limit: %s %d %s", path, response.Code, response.Body.String())
		}
	}
	testBalance(t, a, user, moneyScale, 0)
	var count int
	if err := a.DB.QueryRow(ctx, "SELECT count(*) FROM generation_tasks WHERE user_id=$1", user).Scan(&count); err != nil || count != 0 {
		t.Fatalf("unconfigured model created tasks: %d %v", count, err)
	}
	if _, err := a.DB.Exec(ctx, "UPDATE models SET config=$2 WHERE id=$1", model, jsonBytes(Row{"maxOutputTokens": 128, "reasoningEfforts": []string{"high"}})); err != nil {
		t.Fatal(err)
	}
	quoted := testRequest(router, "POST", "/api/generation-quote", quote, cookie)
	if quoted.Code != 200 || object(responseRow(t, quoted)["quote"])["estimatedHold"] != "0.000128" {
		t.Fatalf("quote=%d %s", quoted.Code, quoted.Body.String())
	}
	accepted := testRequest(router, "POST", "/api/text/requests", request, cookie)
	if accepted.Code != 200 {
		t.Fatal(accepted.Body.String())
	}
	testBalance(t, a, user, moneyScale-128, 128)
	if _, err := a.DB.Exec(ctx, "UPDATE models SET config=$2 WHERE id=$1", model, jsonBytes(Row{"maxOutputTokens": 256})); err != nil {
		t.Fatal(err)
	}
	if replay := testRequest(router, "POST", "/api/text/requests", request, cookie); replay.Code != 200 {
		t.Fatal(replay.Body.String())
	}
	task, err := one(ctx, a.DB, "SELECT parameters,price_micros FROM generation_tasks WHERE id=$1", request["requestId"])
	if err != nil || explicitTextTokens(object(task["parameters"])) != 128 || object(task["parameters"])["reasoningEffort"] != "high" || integer(task["priceMicros"]) != 128 {
		t.Fatalf("request snapshot=%v error=%v", task, err)
	}
	testBalance(t, a, user, moneyScale-128, 128)
}

func TestModelReasoningConfiguration(t *testing.T) {
	for _, effort := range []string{"low", "medium", "high", "xhigh", "max", "ultra"} {
		model := Row{"config": Row{"maxOutputTokens": 128, "reasoningEfforts": []string{effort}}}
		for _, key := range []string{"reasoningEffort", "reasoning_effort"} {
			params, err := modelTextParameters(model, Row{key: effort})
			if err != nil || params["reasoningEffort"] != effort || params["reasoning_effort"] != nil {
				t.Fatalf("%s %s: %v %v", key, effort, params, err)
			}
		}
	}
	model := Row{"config": Row{"maxOutputTokens": 128, "reasoningEfforts": []string{"high", "ultra"}}}
	for _, input := range []Row{{"reasoningEffort": "low"}, {"reasoning_effort": "max"}, {"reasoningEffort": "ultrl"}, {"reasoningEffort": "high", "reasoning_effort": "ultra"}} {
		if _, err := modelTextParameters(model, input); err == nil {
			t.Fatalf("accepted unavailable or conflicting effort: %v", input)
		}
	}
	for _, config := range []any{"high", []int{1}, []string{"high", "high"}, []string{"unknown"}} {
		if _, err := modelTextParameters(Row{"config": Row{"maxOutputTokens": 128, "reasoningEfforts": config}}, nil); err == nil {
			t.Fatalf("accepted invalid model configuration: %v", config)
		}
	}
	model["config"] = Row{"maxOutputTokens": 128}
	if _, err := modelTextParameters(model, Row{"reasoningEffort": "high"}); err == nil {
		t.Fatal("unconfigured model accepted an explicit effort")
	}
	params, err := modelTextParameters(model, Row{"reasoningEffort": "auto"})
	if err != nil || params["reasoningEffort"] != nil {
		t.Fatalf("automatic mode must omit the effort: %v %v", params, err)
	}
}

func TestTextReasoningProtocolParameters(t *testing.T) {
	for _, sample := range []struct{ protocol, effort string }{{"openai", "ultra"}, {"anthropic", "max"}, {"gemini", "high"}, {"openai", "auto"}, {"anthropic", "auto"}, {"gemini", "auto"}} {
		t.Run(sample.protocol+"/"+sample.effort, func(t *testing.T) {
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				var input Row
				if err := json.NewDecoder(r.Body).Decode(&input); err != nil {
					t.Error(err)
				}
				got, expected := input["reasoning_effort"], sample.effort
				if sample.protocol == "anthropic" {
					got = object(input["output_config"])["effort"]
				} else if sample.protocol == "gemini" {
					got = object(object(input["generationConfig"])["thinkingConfig"])["thinkingLevel"]
					expected = "HIGH"
				}
				if sample.effort == "auto" && got != nil || sample.effort != "auto" && got != expected {
					t.Errorf("reasoning parameter: %v, input=%v", got, input)
				}
				w.Header().Set("Content-Type", "application/json")
				if sample.protocol == "anthropic" {
					_ = json.NewEncoder(w).Encode(Row{"content": []any{Row{"type": "text", "text": "done"}}, "stop_reason": "end_turn", "usage": Row{"input_tokens": 2, "output_tokens": 3}})
				} else if sample.protocol == "gemini" {
					_ = json.NewEncoder(w).Encode(Row{"candidates": []any{Row{"content": Row{"parts": []any{Row{"text": "done"}}}, "finishReason": "STOP"}}, "usageMetadata": Row{"promptTokenCount": 2, "candidatesTokenCount": 1, "thoughtsTokenCount": 2}})
				} else {
					_ = json.NewEncoder(w).Encode(Row{"choices": []any{Row{"message": Row{"content": "done"}, "finish_reason": "stop"}}, "usage": Row{"prompt_tokens": 2, "completion_tokens": 3}})
				}
			}))
			defer upstream.Close()
			a := &App{Config: Config{AllowPrivateHosts: true, MaxGenerated: 50 * 1024 * 1024}}
			task := Row{"capability": "text", "prompt": "hello", "probe": true, "parameters": Row{"max_tokens": 128, "reasoningEffort": sample.effort}}
			result, err := a.generate(context.Background(), channel{Protocol: sample.protocol, BaseURL: upstream.URL, UpstreamModel: "test", APIKey: "test-key"}, task)
			if err != nil || result.Text != "done" || result.CompletionTokens != 3 {
				t.Fatalf("result=%+v error=%v", result, err)
			}
		})
	}
}

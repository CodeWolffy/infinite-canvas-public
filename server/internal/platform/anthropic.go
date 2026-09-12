package platform

import "github.com/shopspring/decimal"

func explicitTextTokens(params map[string]any) int64 {
	for _, key := range []string{"max_completion_tokens", "max_tokens", "maxOutputTokens"} {
		if value := params[key]; value != nil {
			n, err := decimal.NewFromString(str(value))
			if err == nil && n.IsPositive() && n.Equal(n.Truncate(0)) && n.LessThanOrEqual(decimal.NewFromInt(1<<63-1)) {
				return n.IntPart()
			}
			return 0
		}
	}
	return 0
}

func anthropicContent(parts any) string {
	items, _ := parts.([]any)
	text := ""
	for _, part := range items {
		item := object(part)
		if item["type"] == "text" {
			text += str(item["text"])
		}
	}
	return text
}

func anthropicEvent(payload map[string]any, stream bool, result *generationResult) (string, bool, error) {
	message := payload
	if payload["type"] == "message_start" {
		message = object(payload["message"])
	}
	usage := object(message["usage"])
	if !stream || payload["type"] == "message_start" {
		result.CachedTokens = integer(usage["cache_read_input_tokens"])
		result.PromptTokens = integer(usage["input_tokens"]) + integer(usage["cache_creation_input_tokens"]) + result.CachedTokens
	}
	if usage["output_tokens"] != nil {
		result.CompletionTokens = integer(usage["output_tokens"])
	}
	delta := object(payload["delta"])
	if message["stop_reason"] == "refusal" || delta["stop_reason"] == "refusal" {
		return "", false, &upstreamError{Category: "content_policy"}
	}
	if !stream || payload["type"] == "message_start" {
		return anthropicContent(message["content"]), !stream, nil
	}
	if payload["type"] == "content_block_start" {
		block := object(payload["content_block"])
		if block["type"] == "text" {
			return str(block["text"]), false, nil
		}
	}
	if payload["type"] == "content_block_delta" && delta["type"] == "text_delta" {
		return str(delta["text"]), false, nil
	}
	return "", payload["type"] == "message_stop", nil
}

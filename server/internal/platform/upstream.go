package platform

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"mime"
	"mime/multipart"
	"net/http"
	"net/textproto"
	"net/url"
	"os"
	"strconv"
	"strings"

	"github.com/go-audio/audio"
	"github.com/go-audio/wav"
)

func (c channel) endpoint(path string) string {
	base := strings.TrimRight(c.BaseURL, "/")
	if c.Protocol == "gemini" && !strings.HasSuffix(base, "/v1beta") && !strings.HasSuffix(base, "/v1") {
		base += "/v1beta"
	}
	if c.Protocol == "anthropic" && !strings.HasSuffix(base, "/v1") {
		base += "/v1"
	}
	return base + "/" + strings.TrimLeft(path, "/")
}
func (c channel) authorize(req *http.Request) {
	if c.Protocol == "gemini" {
		req.Header.Set("x-goog-api-key", c.APIKey)
		if strings.HasPrefix(c.APIKey, "sk-") {
			req.Header.Set("Authorization", "Bearer "+c.APIKey)
		}
	} else if c.Protocol == "anthropic" {
		req.Header.Set("x-api-key", c.APIKey)
		req.Header.Set("anthropic-version", "2023-06-01")
	} else {
		req.Header.Set("Authorization", "Bearer "+c.APIKey)
	}
}
func (c channel) jsonRequest(ctx context.Context, path string, body any) (*http.Request, error) {
	req, err := http.NewRequestWithContext(ctx, "POST", c.endpoint(path), bytes.NewReader(jsonBytes(body)))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	c.authorize(req)
	return req, nil
}
func (a *App) upstreamJSON(req *http.Request) (map[string]any, error) {
	response, err := safeClient(a.Config.AllowPrivateHosts).Do(req)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	trace := traceFrom(req.Context())
	if trace != nil {
		trace.status = response.StatusCode
	}
	raw, err := io.ReadAll(io.LimitReader(response.Body, a.Config.MaxGenerated*2+1))
	if trace != nil {
		trace.rawResponse = trace.payload(string(raw))
	}
	if err != nil {
		return nil, err
	}
	if int64(len(raw)) > a.Config.MaxGenerated*2 {
		return nil, &upstreamError{Category: "upstream_error"}
	}
	var result map[string]any
	decodeErr := json.Unmarshal(raw, &result)
	rawText := string(raw)
	if response.StatusCode >= 300 {
		return nil, responseError(response.StatusCode, result, rawText)
	}
	if decodeErr != nil {
		return nil, &upstreamError{Category: "upstream_error"}
	}
	if result["error"] != nil {
		return nil, responseError(400, result, rawText)
	}
	if feedback := object(result["promptFeedback"]); str(feedback["blockReason"]) != "" {
		return nil, &upstreamError{Category: "content_policy", Message: "上游拒绝了此内容，请调整提示词"}
	}
	if envelope, ok := result["data"].(map[string]any); ok {
		if code, exists := result["code"]; exists && str(code) != "0" && str(code) != "200" {
			return nil, responseError(400, result, rawText)
		}
		result = envelope
	}
	return result, nil
}
func responseError(status int, payload map[string]any, raw ...string) *upstreamError {
	e := object(payload["error"])
	code := strings.ToLower(str(e["code"]))
	kind := strings.ToLower(str(e["type"]))
	msg := str(e["message"])
	if msg == "" {
		msg = str(payload["message"])
	}
	if msg == "" {
		msg = str(payload["msg"])
	}
	if msg == "" && str(payload["error"]) != "" {
		msg = str(payload["error"])
	}
	if msg == "" && len(raw) > 0 {
		msg = strings.TrimSpace(raw[0])
	}
	if len(msg) > 1000 {
		msg = msg[:1000]
	}

	lower := strings.ToLower(msg)
	isContentPolicy := false
	for _, value := range []string{code, kind, lower} {
		if strings.Contains(value, "content_policy") ||
			strings.Contains(value, "content_filter") ||
			strings.Contains(value, "prohibited_content") ||
			strings.Contains(value, "safety_violation") ||
			strings.Contains(value, "safety_policy") ||
			(status < 500 && strings.Contains(value, "safety")) ||
			strings.Contains(value, "安全政策") ||
			strings.Contains(value, "安全审核") ||
			strings.Contains(value, "不适合进行图像生成") ||
			strings.Contains(value, "被拦截") ||
			strings.Contains(value, "违规") {
			isContentPolicy = true
			break
		}
	}

	if isContentPolicy || status == 451 {
		return &upstreamError{Category: "content_policy", Status: status, Message: msg}
	}
	if status == 400 {
		switch kind {
		case "overloaded_error", "api_error":
			status = 503
		case "rate_limit_error":
			status = 429
		case "authentication_error":
			status = 401
		case "permission_error":
			status = 403
		}
	}
	switch {
	case status == 408 || status == 504:
		return &upstreamError{Category: "timeout", Status: status, Retryable: true, Message: msg}
	case status == 429:
		return &upstreamError{Category: "rate_limit", Status: status, Retryable: true, Message: msg}
	case status == 401 || status == 403:
		return &upstreamError{Category: "authentication", Status: status, Retryable: true, Message: msg}
	case status >= 500:
		return &upstreamError{Category: "upstream_error", Status: status, Retryable: true, Message: msg}
	case status == 400 || status == 422:
		return &upstreamError{Category: "invalid_request", Status: status, Message: msg}
	default:
		return &upstreamError{Category: "upstream_error", Status: status, Message: msg}
	}
}
func (a *App) binaryRequest(req *http.Request) ([]byte, error) {
	response, err := safeClient(a.Config.AllowPrivateHosts).Do(req)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	data, err := io.ReadAll(io.LimitReader(response.Body, a.Config.MaxGenerated+1))
	if err != nil {
		return nil, err
	}
	if response.StatusCode >= 300 {
		var payload map[string]any
		_ = json.Unmarshal(data, &payload)
		return nil, responseError(response.StatusCode, payload, string(data))
	}
	if int64(len(data)) > a.Config.MaxGenerated {
		return nil, &upstreamError{Category: "upstream_error"}
	}
	return data, nil
}
func selectedParams(params map[string]any, keys ...string) map[string]any {
	selected := map[string]any{}
	for _, key := range keys {
		if value, ok := params[key]; ok && value != nil && value != "" {
			selected[key] = value
		}
	}
	return selected
}

type referenceMedia struct {
	Data       []byte
	MIME, Name string
}

func (a *App) references(ctx context.Context, kind, id string) ([]referenceMedia, error) {
	items, err := rows(ctx, a.DB, "SELECT m.* FROM media_references r JOIN media_objects m ON m.id=r.media_id WHERE r.owner_kind=$1 AND r.owner_id=$2 AND m.status='ready' ORDER BY r.position", kind, id)
	if err != nil {
		return nil, err
	}
	refs := []referenceMedia{}
	for _, row := range items {
		data, err := a.readMedia(ctx, row)
		if err != nil {
			return nil, err
		}
		refs = append(refs, referenceMedia{data, str(row["mimeType"]), str(row["originalName"])})
	}
	return refs, nil
}
func (a *App) generate(ctx context.Context, c channel, task Row) (generationResult, error) {
	params := object(task["parameters"])
	capability := str(task["capability"])
	var adapter taskAdapter
	if capability == "video" {
		var err error
		adapter, err = videoAdapter(c)
		if err != nil {
			return generationResult{}, err
		}
		if id := str(task["upstreamTaskId"]); id != "" {
			return adapter.Poll(a, ctx, c, id)
		}
	}
	if capability == "text" {
		return a.generateText(ctx, c, task, params)
	}
	if c.Protocol == "anthropic" {
		return generationResult{}, &upstreamError{Category: "invalid_request", Message: "Claude Messages 渠道仅支持文本对话"}
	}
	var refs []referenceMedia
	var err error
	if task["probe"] != true {
		refs, err = a.references(ctx, "batch", str(task["batchId"]))
		if err != nil {
			return generationResult{}, &upstreamError{Category: "storage", Message: "参考文件暂时无法读取，请检查文件后重试"}
		}
	}
	if capability == "video" {
		return adapter.Submit(a, ctx, c, task, params, refs)
	}
	if c.Protocol == "gemini" {
		return a.generateGemini(ctx, c, capability, str(task["prompt"]), params, refs)
	}
	switch capability {
	case "image":
		body := selectedParams(params, "size", "quality", "background", "output_format", "style")
		body["model"] = c.UpstreamModel
		body["prompt"] = task["prompt"]
		body["n"] = 1
		if !strings.HasPrefix(c.UpstreamModel, "gpt-image-") {
			body["response_format"] = "b64_json"
		}
		var req *http.Request
		if len(refs) == 0 {
			req, err = c.jsonRequest(ctx, "images/generations", body)
		} else {
			fields := make([]formFile, 0, len(refs))
			for _, ref := range refs {
				if !strings.HasPrefix(ref.MIME, "image/") {
					return generationResult{}, &upstreamError{Category: "invalid_request"}
				}
				name := "image"
				if len(refs) > 1 {
					name = "image[]"
				}
				fields = append(fields, formFile{name, ref})
			}
			req, err = c.multipartRequest(ctx, "images/edits", body, fields)
		}
		if err != nil {
			return generationResult{}, err
		}
		response, err := a.upstreamJSON(req)
		if err != nil {
			return generationResult{}, err
		}
		images, _ := response["data"].([]any)
		if len(images) == 0 {
			return generationResult{}, &upstreamError{Category: "upstream_error"}
		}
		item := object(images[0])
		var data []byte
		if encoded := str(item["b64_json"]); encoded != "" {
			data, err = a.decodeBase64(encoded)
		} else {
			data, err = a.download(ctx, str(item["url"]), nil)
		}
		return generationResult{Data: data}, err
	case "audio":
		body := selectedParams(params, "voice", "speed", "instructions", "response_format")
		if body["voice"] == nil {
			body["voice"] = "alloy"
		}
		if body["response_format"] == nil {
			body["response_format"] = "mp3"
		}
		body["model"] = c.UpstreamModel
		body["input"] = task["prompt"]
		req, err := c.jsonRequest(ctx, "audio/speech", body)
		if err != nil {
			return generationResult{}, err
		}
		data, err := a.binaryRequest(req)
		if err == nil && body["response_format"] == "pcm" {
			data, err = pcmWAV(data, 24000)
		}
		return generationResult{Data: data}, err
	}
	return generationResult{}, &upstreamError{Category: "invalid_request"}
}
func (a *App) decodeBase64(encoded string) ([]byte, error) {
	if int64(len(encoded)) > (a.Config.MaxGenerated+2)/3*4 {
		return nil, &upstreamError{Category: "upstream_error"}
	}
	data, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil {
		return nil, err
	}
	if int64(len(data)) > a.Config.MaxGenerated {
		return nil, &upstreamError{Category: "upstream_error"}
	}
	return data, nil
}

type formFile struct {
	Field string
	Media referenceMedia
}

func (c channel) multipartRequest(ctx context.Context, path string, params map[string]any, files []formFile) (*http.Request, error) {
	var buffer bytes.Buffer
	writer := multipart.NewWriter(&buffer)
	for key, value := range params {
		if err := writer.WriteField(key, str(value)); err != nil {
			return nil, err
		}
	}
	for _, file := range files {
		header := textproto.MIMEHeader{}
		header.Set("Content-Disposition", mime.FormatMediaType("form-data", map[string]string{"name": file.Field, "filename": file.Media.Name}))
		header.Set("Content-Type", file.Media.MIME)
		part, err := writer.CreatePart(header)
		if err != nil {
			return nil, err
		}
		if _, err = part.Write(file.Media.Data); err != nil {
			return nil, err
		}
	}
	if err := writer.Close(); err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, "POST", c.endpoint(path), &buffer)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", writer.FormDataContentType())
	c.authorize(req)
	return req, nil
}
func (a *App) generateText(ctx context.Context, c channel, task Row, params map[string]any) (generationResult, error) {
	stored := []Row{{"role": "user", "content": task["prompt"]}}
	var err error
	if task["probe"] != true {
		stored, err = rows(ctx, a.DB, "SELECT m.id,m.role,m.content FROM messages m WHERE m.conversation_id=$1 AND "+approvedMessage+" ORDER BY m.sequence", task["conversationId"])
		if err != nil {
			return generationResult{}, &upstreamError{Category: "storage", Message: "对话暂时无法读取，请稍后重试"}
		}
	}
	messages := []any{}
	anthropicMessages := []any{}
	contents := []any{}
	system := str(params["systemPrompt"])
	if system != "" {
		messages = append(messages, map[string]any{"role": "system", "content": system})
	}
	for _, m := range stored {
		var refs []referenceMedia
		if m["id"] != nil {
			refs, err = a.references(ctx, "message", str(m["id"]))
			if err != nil {
				return generationResult{}, &upstreamError{Category: "storage", Message: "对话附件暂时无法读取，请检查文件后重试"}
			}
		}
		parts := []any{map[string]any{"text": m["content"]}}
		openParts := []any{map[string]any{"type": "text", "text": m["content"]}}
		claudeParts := []any{map[string]any{"type": "text", "text": m["content"]}}
		for _, ref := range refs {
			if !strings.HasPrefix(ref.MIME, "image/") {
				return generationResult{}, &upstreamError{Category: "invalid_request"}
			}
			encoded := base64.StdEncoding.EncodeToString(ref.Data)
			parts = append(parts, map[string]any{"inlineData": map[string]any{"mimeType": ref.MIME, "data": encoded}})
			openParts = append(openParts, map[string]any{"type": "image_url", "image_url": map[string]string{"url": "data:" + ref.MIME + ";base64," + encoded}})
			claudeParts = append(claudeParts, map[string]any{"type": "image", "source": map[string]any{"type": "base64", "media_type": ref.MIME, "data": encoded}})
		}
		messages = append(messages, map[string]any{"role": m["role"], "content": openParts})
		anthropicMessages = append(anthropicMessages, map[string]any{"role": m["role"], "content": claudeParts})
		role := str(m["role"])
		if role == "assistant" {
			role = "model"
		}
		contents = append(contents, map[string]any{"role": role, "parts": parts})
	}
	var req *http.Request
	if c.Protocol == "gemini" {
		config := selectedParams(params, "temperature", "topP", "maxOutputTokens")
		if limit := explicitTextTokens(params); limit > 0 {
			config["maxOutputTokens"] = limit
		}
		body := map[string]any{"contents": contents, "generationConfig": config}
		if system != "" {
			body["systemInstruction"] = map[string]any{"parts": []any{map[string]string{"text": system}}}
		}
		req, err = c.jsonRequest(ctx, "models/"+url.PathEscape(c.UpstreamModel)+":streamGenerateContent?alt=sse", body)
	} else if c.Protocol == "anthropic" {
		limit := explicitTextTokens(params)
		if limit == 0 {
			return generationResult{}, &upstreamError{Category: "invalid_request", Message: "Claude Messages 必须由用户指定最大输出 token 数"}
		}
		body := selectedParams(params, "temperature", "top_p", "stop_sequences")
		body["model"], body["messages"], body["max_tokens"], body["stream"] = c.UpstreamModel, anthropicMessages, limit, true
		if system != "" {
			body["system"] = system
		}
		req, err = c.jsonRequest(ctx, "messages", body)
	} else {
		body := selectedParams(params, "temperature", "top_p", "max_tokens", "max_completion_tokens", "reasoning_effort")
		if effort := str(params["reasoningEffort"]); effort != "" && effort != "auto" {
			body["reasoning_effort"] = effort
		}
		body["model"] = c.UpstreamModel
		body["messages"] = messages
		body["stream"] = true
		body["stream_options"] = map[string]any{"include_usage": true}
		body["n"] = 1
		if body["max_tokens"] == nil && body["max_completion_tokens"] == nil && explicitTextTokens(params) > 0 {
			body["max_tokens"] = explicitTextTokens(params)
		}
		req, err = c.jsonRequest(ctx, "chat/completions", body)
	}
	if err != nil {
		return generationResult{}, err
	}
	return a.streamText(ctx, req, c, task)
}

func geminiParts(response map[string]any) ([]any, error) {
	candidates, _ := response["candidates"].([]any)
	if len(candidates) == 0 {
		return nil, &upstreamError{Category: "upstream_error"}
	}
	candidate := object(candidates[0])
	switch str(candidate["finishReason"]) {
	case "SAFETY", "PROHIBITED_CONTENT", "BLOCKLIST", "IMAGE_SAFETY":
		return nil, &upstreamError{Category: "content_policy"}
	}
	parts, _ := object(candidate["content"])["parts"].([]any)
	return parts, nil
}
func geminiImageConfig(params map[string]any) map[string]any {
	ratio := str(params["aspectRatio"])
	size := strings.ToUpper(str(params["imageSize"]))
	var width, height int
	_, _ = fmt.Sscanf(str(params["size"]), "%dx%d", &width, &height)
	if ratio == "" && width > 0 && height > 0 {
		target := float64(width) / float64(height)
		distance := math.Inf(1)
		for _, candidate := range []string{"1:1", "1:4", "1:8", "2:3", "3:2", "3:4", "4:1", "4:3", "4:5", "5:4", "8:1", "9:16", "16:9", "21:9"} {
			var w, h float64
			_, _ = fmt.Sscanf(candidate, "%f:%f", &w, &h)
			delta := math.Abs(w/h - target)
			if delta < distance {
				distance = delta
				ratio = candidate
			}
		}
	}
	if size == "" {
		switch strings.ToLower(str(params["quality"])) {
		case "low", "standard", "1k":
			size = "1K"
		case "medium", "hd", "2k":
			size = "2K"
		case "high", "4k":
			size = "4K"
		default:
			if max(width, height) > 3072 {
				size = "4K"
			} else if max(width, height) > 1536 {
				size = "2K"
			} else {
				size = "1K"
			}
		}
	}
	config := map[string]any{"imageSize": size}
	if ratio != "" {
		config["aspectRatio"] = ratio
	}
	return config
}
func (a *App) generateGemini(ctx context.Context, c channel, capability, prompt string, params map[string]any, refs []referenceMedia) (generationResult, error) {
	parts := []any{map[string]any{"text": prompt}}
	for _, ref := range refs {
		parts = append(parts, map[string]any{"inlineData": map[string]any{"mimeType": ref.MIME, "data": base64.StdEncoding.EncodeToString(ref.Data)}})
	}
	config := map[string]any{}
	if capability == "image" {
		config["responseModalities"] = []string{"TEXT", "IMAGE"}
		config["imageConfig"] = geminiImageConfig(params)
	} else if capability == "audio" {
		config["responseModalities"] = []string{"AUDIO"}
		voice := str(params["voice"])
		if voice == "alloy" || voice == "" {
			voice = "Kore"
		}
		if voice != "" {
			config["speechConfig"] = map[string]any{"voiceConfig": map[string]any{"prebuiltVoiceConfig": map[string]any{"voiceName": voice}}}
		}
	}
	req, err := c.jsonRequest(ctx, "models/"+url.PathEscape(c.UpstreamModel)+":generateContent", map[string]any{"contents": []any{map[string]any{"role": "user", "parts": parts}}, "generationConfig": config})
	if err != nil {
		return generationResult{}, err
	}
	response, err := a.upstreamJSON(req)
	if err != nil {
		return generationResult{}, err
	}
	resultParts, err := geminiParts(response)
	if err != nil {
		return generationResult{}, err
	}
	for _, part := range resultParts {
		inline := object(object(part)["inlineData"])
		encoded := str(inline["data"])
		if encoded == "" {
			continue
		}
		mediaType, mediaParams, _ := mime.ParseMediaType(str(inline["mimeType"]))
		if capability == "image" && !strings.HasPrefix(mediaType, "image/") || capability == "audio" && !strings.HasPrefix(mediaType, "audio/") {
			continue
		}
		data, err := a.decodeBase64(encoded)
		if err != nil {
			return generationResult{}, err
		}
		if capability == "audio" && (strings.EqualFold(mediaType, "audio/L16") || strings.EqualFold(mediaType, "audio/pcm")) {
			rate, _ := strconv.Atoi(mediaParams["rate"])
			if rate <= 0 {
				rate = 24000
			}
			data, err = pcmWAV(data, rate)
		}
		return generationResult{Data: data}, err
	}
	return generationResult{}, &upstreamError{Category: "upstream_error"}
}

func (a *App) pollVideo(ctx context.Context, c channel, id string) (generationResult, error) {
	endpoint := "videos/" + url.PathEscape(id)
	if c.Protocol == "gemini" {
		if strings.Contains(id, "..") || strings.ContainsAny(id, "?#\\") {
			return generationResult{}, &upstreamError{Category: "upstream_error"}
		}
		endpoint = strings.TrimLeft(id, "/")
	}
	req, err := http.NewRequestWithContext(ctx, "GET", c.endpoint(endpoint), nil)
	if err != nil {
		return generationResult{}, err
	}
	c.authorize(req)
	response, err := a.upstreamJSON(req)
	if err != nil {
		failure := classify(err)
		if failure.Retryable || errors.Is(err, context.DeadlineExceeded) {
			return generationResult{Pending: true, UpstreamID: id}, nil
		}
		return generationResult{}, err
	}
	if c.Protocol == "gemini" {
		if response["done"] != true {
			return generationResult{Pending: true, UpstreamID: id}, nil
		}
		result := object(object(response["response"])["generateVideoResponse"])
		samples, _ := result["generatedSamples"].([]any)
		if len(samples) == 0 {
			return generationResult{}, &upstreamError{Category: "upstream_error"}
		}
		address := str(object(object(samples[0])["video"])["uri"])
		u, err := url.Parse(address)
		if err != nil {
			return generationResult{}, err
		}
		base, _ := url.Parse(c.BaseURL)
		if u.Host != base.Host {
			return generationResult{}, &upstreamError{Category: "upstream_error"}
		}
		download, err := http.NewRequestWithContext(ctx, "GET", address, nil)
		if err != nil {
			return generationResult{}, err
		}
		c.authorize(download)
		data, err := a.binaryRequest(download)
		return generationResult{Data: data}, err
	}
	status := str(response["status"])
	if status == "failed" || status == "cancelled" || status == "canceled" {
		return generationResult{}, &upstreamError{Category: "upstream_error"}
	}
	address := str(response["url"])
	if address == "" {
		address = str(response["video_url"])
	}
	if address == "" {
		address = str(response["result_url"])
	}
	if address == "" {
		address = str(object(response["content"])["video_url"])
	}
	if address != "" {
		data, err := a.download(ctx, address, nil)
		return generationResult{Data: data}, err
	}
	if status == "completed" || status == "succeeded" {
		download, _ := http.NewRequestWithContext(ctx, "GET", c.endpoint(endpoint+"/content"), nil)
		c.authorize(download)
		data, err := a.binaryRequest(download)
		return generationResult{Data: data}, err
	}
	return generationResult{Pending: true, UpstreamID: id}, nil
}

// 使用成熟的 WAV 编码器封装上游 PCM，不手写容器格式。
func pcmWAV(data []byte, rate int) ([]byte, error) {
	if len(data)%2 != 0 {
		return nil, errors.New("PCM 数据不完整")
	}
	samples := make([]int16, len(data)/2)
	if err := binary.Read(bytes.NewReader(data), binary.LittleEndian, samples); err != nil {
		return nil, err
	}
	values := make([]int, len(samples))
	for i, v := range samples {
		values[i] = int(v)
	}
	file, err := os.CreateTemp("", "canvas-audio-*.wav")
	if err != nil {
		return nil, err
	}
	defer os.Remove(file.Name())
	defer file.Close()
	encoder := wav.NewEncoder(file, rate, 16, 1, 1)
	if err = encoder.Write(&audio.IntBuffer{Data: values, Format: &audio.Format{NumChannels: 1, SampleRate: rate}, SourceBitDepth: 16}); err != nil {
		return nil, err
	}
	if err = encoder.Close(); err != nil {
		return nil, err
	}
	if _, err = file.Seek(0, io.SeekStart); err != nil {
		return nil, err
	}
	return io.ReadAll(file)
}

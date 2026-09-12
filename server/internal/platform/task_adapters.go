package platform

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"net/url"
	"strings"

	"github.com/gin-gonic/gin"
)

// 适配器只负责提交与续查；凭据快照、超时、账务和结果存储由 worker 统一处理。
type taskAdapter struct {
	Name, Protocol string
	Submit func(*App, context.Context, channel, Row, map[string]any, []referenceMedia) (generationResult, error)
	Poll func(*App, context.Context, channel, string) (generationResult, error)
}

var taskAdapters = map[string]taskAdapter{
	"openai-video": {Name: "OpenAI 兼容视频", Protocol: "openai", Submit: (*App).submitOpenAIVideo, Poll: (*App).pollVideo},
	"gemini-video": {Name: "Gemini / Veo", Protocol: "gemini", Submit: (*App).submitGeminiVideo, Poll: (*App).pollVideo},
}

func validateTaskAdapter(id, protocol string) error {
	if id == "" {
		return nil
	}
	adapter, ok := taskAdapters[id]
	if !ok || adapter.Protocol != protocol {
		return problem(400, "invalid_task_adapter", "请选择与渠道协议一致的已接入任务适配器")
	}
	return nil
}

func videoAdapter(ch channel) (taskAdapter, error) {
	id := ch.TaskAdapter
	if id == "" {
		id = ch.Protocol + "-video"
	}
	adapter, ok := taskAdapters[id]
	if !ok || adapter.Protocol != ch.Protocol {
		return adapter, &upstreamError{Category: "invalid_request", Message: "此渠道没有可用的视频任务适配器"}
	}
	return adapter, nil
}

func (a *App) taskAdapterRoutes(admin *gin.RouterGroup) {
	admin.GET("/task-adapters", respond(func(c *gin.Context) (any, error) {
		items := []gin.H{}
		for _, id := range []string{"openai-video", "gemini-video"} {
			adapter := taskAdapters[id]
			items = append(items, gin.H{"id": id, "name": adapter.Name, "protocol": adapter.Protocol, "capability": "video"})
		}
		return gin.H{"adapters": items}, nil
	}))
}

func (a *App) submitOpenAIVideo(ctx context.Context, c channel, task Row, params map[string]any, refs []referenceMedia) (generationResult, error) {
	body := selectedParams(params, "seconds", "size", "resolution_name", "generate_audio", "watermark", "mode")
	body["model"] = c.UpstreamModel
	body["prompt"] = task["prompt"]
	if body["mode"] == nil {
		body["mode"] = "frames"
	}
	images := 0
	for _, ref := range refs {
		if strings.HasPrefix(ref.MIME, "image/") {
			images++
		}
	}
	if images > 2 {
		body["mode"] = "reference"
	}
	fields := []formFile{}
	imageIndex := 0
	for _, ref := range refs {
		name := ""
		switch {
		case strings.HasPrefix(ref.MIME, "video/"):
			name = "video[]"
		case strings.HasPrefix(ref.MIME, "audio/"):
			name = "audio[]"
		case strings.HasPrefix(ref.MIME, "image/"):
			name = "image[]"
			if body["mode"] == "frames" {
				name = "first_frame"
				if imageIndex > 0 {
					name = "last_frame"
				}
			}
			imageIndex++
		}
		if name != "" {
			fields = append(fields, formFile{name, ref})
		}
	}
	req, err := c.multipartRequest(ctx, "videos", body, fields)
	if err != nil {
		return generationResult{}, err
	}
	response, err := a.upstreamJSON(req)
	if err != nil {
		return generationResult{}, err
	}
	id := str(response["id"])
	if id == "" {
		return generationResult{}, &upstreamError{Category: "upstream_error"}
	}
	return generationResult{Pending: true, UpstreamID: id}, nil
}

func (a *App) submitGeminiVideo(ctx context.Context, c channel, task Row, params map[string]any, refs []referenceMedia) (generationResult, error) {
	prompt := str(task["prompt"])
	instance := map[string]any{"prompt": prompt}
	images := []any{}
	for _, ref := range refs {
		if !strings.HasPrefix(ref.MIME, "image/") {
			return generationResult{}, &upstreamError{Category: "invalid_request"}
		}
		images = append(images, map[string]any{"bytesBase64Encoded": base64.StdEncoding.EncodeToString(ref.Data), "mimeType": ref.MIME})
	}
	if params["mode"] == "reference" || len(images) > 2 {
		references := []any{}
		for _, img := range images {
			references = append(references, map[string]any{"image": img, "referenceType": "asset"})
		}
		instance["referenceImages"] = references
	} else {
		if len(images) > 0 {
			instance["image"] = images[0]
		}
		if len(images) > 1 {
			instance["lastFrame"] = images[1]
		}
	}
	parameters := selectedParams(params, "aspectRatio", "resolution", "generateAudio")
	if audio, exists := params["generate_audio"]; exists {
		parameters["generateAudio"] = audio
	}
	if resolution := str(params["resolution_name"]); parameters["resolution"] == nil && resolution != "" {
		parameters["resolution"] = strings.TrimSuffix(resolution, "p") + "p"
	}
	// 上游请求使用与计费一致的规范化时长，不再直接透传 durationSeconds。
	if seconds, err := paramSeconds(params); err != nil {
		return generationResult{}, err
	} else if !seconds.IsZero() {
		parameters["durationSeconds"] = json.Number(seconds.String())
	}
	if parameters["aspectRatio"] == nil {
		parameters["aspectRatio"] = geminiImageConfig(params)["aspectRatio"]
	}
	parameters["sampleCount"] = 1
	req, err := c.jsonRequest(ctx, "models/"+url.PathEscape(c.UpstreamModel)+":predictLongRunning", map[string]any{"instances": []any{instance}, "parameters": parameters})
	if err != nil {
		return generationResult{}, err
	}
	response, err := a.upstreamJSON(req)
	if err != nil {
		return generationResult{}, err
	}
	id := str(response["name"])
	if id == "" {
		return generationResult{}, &upstreamError{Category: "upstream_error"}
	}
	return generationResult{Pending: true, UpstreamID: id}, nil
}

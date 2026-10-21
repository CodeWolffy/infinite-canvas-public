package platform

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestGeminiImageResolutionIndependentOfQuality(t *testing.T) {
	for _, quality := range []string{"low", "medium", "high", "xhigh", "max"} {
		config := geminiImageConfig(Row{"size": "2880x2880", "resolution": "4k", "quality": quality})
		if config["imageSize"] != "4K" || config["aspectRatio"] != "1:1" {
			t.Fatalf("quality %s changed explicit resolution: %v", quality, config)
		}
		config = geminiImageConfig(Row{"size": "1024x1536", "resolution": "1k", "quality": quality})
		if config["imageSize"] != "1K" || config["aspectRatio"] != "2:3" {
			t.Fatalf("quality %s changed explicit resolution: %v", quality, config)
		}
	}
	if config := geminiImageConfig(Row{"size": "auto", "resolution": "auto", "quality": "high"}); len(config) != 0 {
		t.Fatalf("automatic image size was forced by quality: %v", config)
	}
	if config := geminiImageConfig(Row{"size": "1536x864", "resolution": "auto"}); config["imageSize"] != nil || config["aspectRatio"] != "16:9" {
		t.Fatalf("automatic resolution lost its explicit ratio: %v", config)
	}
}

func TestOpenAIVideoSendsImagesAndRatio(t *testing.T) {
	for _, mode := range []string{"frames", "reference"} {
		t.Run(mode, func(t *testing.T) {
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				reader, err := r.MultipartReader()
				if err != nil {
					t.Error(err)
					return
				}
				fields := map[string][]string{}
				for {
					part, err := reader.NextPart()
					if err == io.EOF {
						break
					}
					if err != nil {
						t.Error(err)
						return
					}
					data, err := io.ReadAll(part)
					if err != nil {
						t.Error(err)
						return
					}
					fields[part.FormName()] = append(fields[part.FormName()], string(data))
				}
				if len(fields["ratio"]) != 1 || fields["ratio"][0] != "9:16" || len(fields["images"]) != 2 || fields["images"][0] != "first" || fields["images"][1] != "last" {
					t.Errorf("missing ratio or ordered reference images: %v", fields)
				}
				if mode == "frames" && (len(fields["first_frame"]) != 1 || len(fields["last_frame"]) != 1) || mode == "reference" && len(fields["image[]"]) != 2 {
					t.Errorf("original image fields were not preserved: %v", fields)
				}
				w.Header().Set("Content-Type", "application/json")
				_ = json.NewEncoder(w).Encode(Row{"id": "video-task"})
			}))
			defer upstream.Close()
			a := &App{Config: Config{AllowPrivateHosts: true, MaxGenerated: 1024 * 1024}}
			refs := []referenceMedia{{Name: "first.png", MIME: "image/png", Data: []byte("first")}, {Name: "last.png", MIME: "image/png", Data: []byte("last")}}
			result, err := a.submitOpenAIVideo(context.Background(), channel{Protocol: "openai", BaseURL: upstream.URL, UpstreamModel: "test"}, Row{"prompt": "test"}, Row{"mode": mode, "ratio": "9:16"}, refs)
			if err != nil || !result.Pending || result.UpstreamID != "video-task" {
				t.Fatalf("video submission: %+v %v", result, err)
			}
		})
	}
}

func TestPreferencesMergePreservesOtherFields(t *testing.T) {
	a := testApp(t)
	_, cookie := testUser(t, a, 0)
	router := a.Router()
	for _, patch := range []Row{{"size": "2048x2048", "videoModelId": "selected", "autoFocusOnSelect": true}, {"nodeRegenerateBehavior": "overwrite"}, {"autoFocusOnSelect": false}} {
		response := testRequest(router, "PUT", "/api/preferences", patch, cookie)
		if response.Code != 200 {
			t.Fatalf("save preferences: %d %s", response.Code, response.Body.String())
		}
	}
	response := testRequest(router, "GET", "/api/preferences", nil, cookie)
	preferences := object(responseRow(t, response)["preferences"])
	if preferences["size"] != "2048x2048" || preferences["videoModelId"] != "selected" || preferences["nodeRegenerateBehavior"] != "overwrite" || preferences["autoFocusOnSelect"] != false {
		t.Fatalf("preference patch overwrote other fields: %v", preferences)
	}
}

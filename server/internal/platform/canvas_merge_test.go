package platform

import (
	"encoding/json"
	"errors"
	"reflect"
	"testing"
)

func mergeTestSnapshot(t *testing.T, raw string) map[string]any {
	t.Helper()
	var result map[string]any
	if err := json.Unmarshal([]byte(raw), &result); err != nil {
		t.Fatal(err)
	}
	return result
}

func TestCanvasMergeIndependentEditsAndRepeatedSubmission(t *testing.T) {
	base := mergeTestSnapshot(t, `{"nodes":[{"id":"a/b~c","x":0,"metadata":{"text":"before"}},{"id":"second","x":0}],"connections":[]}`)
	local := mergeTestSnapshot(t, `{"nodes":[{"id":"a/b~c","x":12,"metadata":{"text":"before"}},{"id":"second","x":0},{"id":"local"}],"connections":[],"viewport":{"x":1,"y":2,"k":1},"chatSessions":[{"private":"local"}]}`)
	remote := mergeTestSnapshot(t, `{"nodes":[{"id":"a/b~c","x":0,"metadata":{"text":"remote"}},{"id":"second","x":40},{"id":"remote"}],"connections":[],"chatSessions":[{"private":"remote"}]}`)
	merged, err := mergeCanvasSnapshot(base, local, remote)
	if err != nil {
		t.Fatal(err)
	}
	nodes := merged["nodes"].([]any)
	if len(nodes) != 4 || object(nodes[0])["x"] != 12.0 || object(object(nodes[0])["metadata"])["text"] != "remote" || object(nodes[1])["x"] != 40.0 {
		t.Fatalf("independent fields or additions lost: %v", merged)
	}
	for _, key := range []string{"viewport", "chatSessions", "activeChatId"} {
		if _, present := merged[key]; present {
			t.Fatalf("shared merge exposed private %s", key)
		}
	}
	repeated, err := mergeCanvasSnapshot(base, local, merged)
	if err != nil || !reflect.DeepEqual(repeated, merged) {
		t.Fatalf("repeated request must be idempotent: %v %v", repeated, err)
	}
	if object(base["nodes"].([]any)[0])["x"] != 0.0 || len(local["nodes"].([]any)) != 3 {
		t.Fatal("merge mutated input snapshots")
	}
}

func TestCanvasMergeRejectsConflictingFields(t *testing.T) {
	for _, tc := range []struct{ name, base, local, remote string }{
		{"same field", `{"id":"n","x":0}`, `{"id":"n","x":1}`, `{"id":"n","x":2}`},
		{"delete versus edit", `{"id":"n","metadata":{"text":"old"}}`, "", `{"id":"n","metadata":{"text":"new"}}`},
		{"arrays are atomic", `{"id":"n","images":["a","b"]}`, `{"id":"n","images":["b"]}`, `{"id":"n","images":["a","c"]}`},
		{"nested replacement", `{"id":"n","metadata":{"text":"old"}}`, `{"id":"n","metadata":null}`, `{"id":"n","metadata":{"text":"new"}}`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			wrap := func(node string) map[string]any {
				return mergeTestSnapshot(t, `{"nodes":[`+node+`],"connections":[]}`)
			}
			_, err := mergeCanvasSnapshot(wrap(tc.base), wrap(tc.local), wrap(tc.remote))
			var conflict *apiError
			if !errors.As(err, &conflict) || conflict.Status != 409 || conflict.Code != "canvas_revision_conflict" {
				t.Fatalf("expected conflict, got %v", err)
			}
		})
	}
}

func TestCanvasMergeValidatesGraphAndFieldScope(t *testing.T) {
	valid := mergeTestSnapshot(t, `{"nodes":[{"id":"n"}],"connections":[]}`)
	for _, raw := range []string{
		`{"nodes":[{"id":"n"},{"id":"n"}],"connections":[]}`,
		`{"nodes":[{}],"connections":[]}`,
		`{"nodes":[{"id":"n"}],"connections":[{"id":"c","fromNodeId":"n","toNodeId":"missing"}]}`,
		`{"nodes":[],"connections":[],"admin":true}`,
	} {
		invalid := mergeTestSnapshot(t, raw)
		if _, err := mergeCanvasSnapshot(invalid, valid, valid); err == nil {
			t.Fatalf("invalid base accepted: %s", raw)
		}
		if _, err := mergeCanvasSnapshot(valid, invalid, valid); err == nil {
			t.Fatalf("invalid local accepted: %s", raw)
		}
	}
	base := mergeTestSnapshot(t, `{"nodes":[{"id":"a"},{"id":"b"}],"connections":[]}`)
	local := mergeTestSnapshot(t, `{"nodes":[{"id":"a"}],"connections":[]}`)
	remote := mergeTestSnapshot(t, `{"nodes":[{"id":"a"},{"id":"b"}],"connections":[{"id":"c","fromNodeId":"a","toNodeId":"b"}]}`)
	if _, err := mergeCanvasSnapshot(base, local, remote); err == nil {
		t.Fatal("concurrent connection creation must not survive deletion of its endpoint")
	}
	if _, err := mergeCanvasSnapshot(base, remote, local); err == nil {
		t.Fatal("remote endpoint deletion must conflict with local connection creation")
	}
}

func TestCanvasMergeConnectionAndNewNodeConflicts(t *testing.T) {
	base := mergeTestSnapshot(t, `{"nodes":[{"id":"a"},{"id":"b"},{"id":"c"}],"connections":[{"id":"link","fromNodeId":"a","toNodeId":"b"}]}`)
	local := mergeTestSnapshot(t, `{"nodes":[{"id":"a"},{"id":"b"},{"id":"c"},{"id":"new","title":"mine"}],"connections":[{"id":"link","fromNodeId":"a","toNodeId":"b"},{"id":"mine","fromNodeId":"a","toNodeId":"new"}]}`)
	remote := mergeTestSnapshot(t, `{"nodes":[{"id":"a"},{"id":"b"},{"id":"c"}],"connections":[{"id":"link","fromNodeId":"a","toNodeId":"b"},{"id":"theirs","fromNodeId":"b","toNodeId":"c"}]}`)
	merged, err := mergeCanvasSnapshot(base, local, remote)
	if err != nil || len(merged["connections"].([]any)) != 3 || len(merged["nodes"].([]any)) != 4 {
		t.Fatalf("independent new connections were lost: %v %v", merged, err)
	}
	remote["nodes"] = append(remote["nodes"].([]any), map[string]any{"id": "new", "title": "theirs"})
	if _, err := mergeCanvasSnapshot(base, local, remote); err == nil {
		t.Fatal("different nodes with the same new id must conflict")
	}
	local = mergeTestSnapshot(t, `{"nodes":[{"id":"a"},{"id":"b"},{"id":"c"}],"connections":[{"id":"link","fromNodeId":"a","toNodeId":"a"}]}`)
	remote = mergeTestSnapshot(t, `{"nodes":[{"id":"a"},{"id":"b"},{"id":"c"}],"connections":[{"id":"link","fromNodeId":"a","toNodeId":"c"}]}`)
	if _, err := mergeCanvasSnapshot(base, local, remote); err == nil {
		t.Fatal("same connection endpoint edited differently must conflict")
	}
}

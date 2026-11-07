package platform

import (
	"encoding/json"
	"reflect"
	"strings"

	jsonpatch "github.com/evanphx/json-patch/v5"
	"github.com/wI2L/jsondiff"
)

func canvasRevisionConflict() error {
	return problem(409, "canvas_revision_conflict", "画布同一内容已被其他成员修改，本地编辑已保留；请核对远端内容后处理冲突")
}

// sharedCanvasSnapshot 不包含个人视口和助手记录，返回新对象以免修改请求或数据库快照。
func sharedCanvasSnapshot(snapshot map[string]any) map[string]any {
	result := map[string]any{}
	for _, key := range []string{"nodes", "connections", "backgroundMode", "showImageInfo"} {
		if value, ok := snapshot[key]; ok {
			result[key] = value
		}
	}
	return result
}

// validateCanvasSnapshot 限定可写字段并校验实体身份，不能让重复 id 在归一化时静默覆盖。
func validateCanvasSnapshot(snapshot map[string]any) error {
	if err := canvasSnapshot(snapshot); err != nil {
		return err
	}
	for key := range snapshot {
		switch key {
		case "nodes", "connections", "backgroundMode", "showImageInfo", "viewport", "chatSessions", "activeChatId":
		default:
			return problem(400, "invalid_snapshot", "画布快照包含不支持的字段")
		}
	}
	for _, key := range []string{"nodes", "connections"} {
		seen := map[string]bool{}
		for _, value := range snapshot[key].([]any) {
			item, ok := value.(map[string]any)
			if !ok {
				return problem(400, "invalid_snapshot", "画布节点或连接格式不正确")
			}
			id, ok := item["id"].(string)
			if !ok || strings.TrimSpace(id) == "" || seen[id] {
				return problem(400, "invalid_snapshot", "画布节点或连接编号缺失或重复")
			}
			seen[id] = true
		}
	}
	nodes := map[string]bool{}
	for _, value := range snapshot["nodes"].([]any) {
		nodes[value.(map[string]any)["id"].(string)] = true
	}
	for _, value := range snapshot["connections"].([]any) {
		for _, key := range []string{"fromNodeId", "toNodeId"} {
			id, ok := value.(map[string]any)[key].(string)
			if !ok || !nodes[id] {
				return problem(400, "invalid_snapshot", "画布连接必须指向存在的节点")
			}
		}
	}
	if value, ok := snapshot["viewport"]; ok {
		viewport, ok := value.(map[string]any)
		if !ok {
			return problem(400, "invalid_viewport", "画布视口格式不正确")
		}
		if err := canvasViewport(viewport); err != nil {
			return err
		}
	}
	if value, ok := snapshot["chatSessions"]; ok {
		if _, ok := value.([]any); !ok {
			return problem(400, "invalid_snapshot", "助手会话格式不正确")
		}
	}
	if value, ok := snapshot["activeChatId"]; ok && value != nil {
		if _, ok := value.(string); !ok {
			return problem(400, "invalid_snapshot", "助手会话编号格式不正确")
		}
	}
	if value, ok := snapshot["backgroundMode"]; ok && value != "lines" && value != "dots" && value != "blank" {
		return problem(400, "invalid_snapshot", "画布背景格式不正确")
	}
	if value, ok := snapshot["showImageInfo"]; ok {
		if _, ok := value.(bool); !ok {
			return problem(400, "invalid_snapshot", "画布图片信息格式不正确")
		}
	}
	return nil
}

// canvasMergeValue 保留对象字段，其他值用 JSON 字符串作为原子叶子；嵌套数组不会按序号误合并。
func canvasMergeValue(value any, decode bool) any {
	if fields, ok := value.(map[string]any); ok {
		result := make(map[string]any, len(fields))
		for key, field := range fields {
			result[key] = canvasMergeValue(field, decode)
		}
		return result
	}
	if decode {
		var result any
		_ = json.Unmarshal([]byte(value.(string)), &result)
		return result
	}
	return string(jsonBytes(value))
}

func normalizedCanvasSnapshot(snapshot map[string]any) map[string]any {
	result := sharedCanvasSnapshot(snapshot)
	for _, key := range []string{"nodes", "connections"} {
		items := map[string]any{}
		for _, item := range snapshot[key].([]any) {
			items[item.(map[string]any)["id"].(string)] = item
		}
		result[key] = items
	}
	return canvasMergeValue(result, false).(map[string]any)
}

// mergeCanvasSnapshot 使用标准 JSON diff/patch 实现三方合并，应用层只判断同字段与父子字段冲突。
func mergeCanvasSnapshot(base, local, remote map[string]any) (map[string]any, error) {
	for _, snapshot := range []map[string]any{base, local, remote} {
		if err := validateCanvasSnapshot(snapshot); err != nil {
			return nil, err
		}
	}
	b, l, r := normalizedCanvasSnapshot(base), normalizedCanvasSnapshot(local), normalizedCanvasSnapshot(remote)
	localPatch, err := jsondiff.Compare(b, l)
	if err != nil {
		return nil, err
	}
	remotePatch, err := jsondiff.Compare(b, r)
	if err != nil {
		return nil, err
	}
	patch := jsondiff.Patch{}
	for _, change := range localPatch {
		duplicate := false
		for _, other := range remotePatch {
			if change.Path == other.Path && change.Type == other.Type && reflect.DeepEqual(change.Value, other.Value) {
				duplicate = true
				continue
			}
			if change.Path == other.Path || strings.HasPrefix(change.Path, other.Path+"/") || strings.HasPrefix(other.Path, change.Path+"/") {
				return nil, canvasRevisionConflict()
			}
		}
		if !duplicate {
			patch = append(patch, change)
		}
	}
	decoded, err := jsonpatch.DecodePatch(jsonBytes(patch))
	if err != nil {
		return nil, err
	}
	raw, err := decoded.Apply(jsonBytes(r))
	if err != nil {
		return nil, canvasRevisionConflict()
	}
	var merged map[string]any
	if err := json.Unmarshal(raw, &merged); err != nil {
		return nil, err
	}
	merged = canvasMergeValue(merged, true).(map[string]any)
	for _, key := range []string{"nodes", "connections"} {
		items := merged[key].(map[string]any)
		order, err := canvasMergeOrder(base[key].([]any), local[key].([]any), remote[key].([]any))
		if err != nil {
			return nil, err
		}
		values := []any{}
		for _, id := range order {
			if item, exists := items[id]; exists {
				values = append(values, item)
				delete(items, id)
			}
		}
		merged[key] = values
	}
	if err := validateCanvasSnapshot(merged); err != nil {
		return nil, canvasRevisionConflict()
	}
	return merged, nil
}

// 保留已有实体的相对顺序；双方重排同一批实体时必须达成一致，新增实体不因数组下标发生冲突。
func canvasMergeOrder(base, local, remote []any) ([]string, error) {
	ids := func(items []any) []string {
		result := []string{}
		for _, item := range items {
			result = append(result, item.(map[string]any)["id"].(string))
		}
		return result
	}
	b, l, r := ids(base), ids(local), ids(remote)
	counts := map[string]int{}
	for _, order := range [][]string{b, l, r} {
		for _, id := range order {
			counts[id]++
		}
	}
	common := func(order []string) []string {
		result := []string{}
		for _, id := range order {
			if counts[id] == 3 {
				result = append(result, id)
			}
		}
		return result
	}
	bc, lc, rc := common(b), common(l), common(r)
	if !reflect.DeepEqual(bc, lc) {
		if !reflect.DeepEqual(bc, rc) && !reflect.DeepEqual(lc, rc) {
			return nil, canvasRevisionConflict()
		}
		return append(l, r...), nil
	}
	return append(r, l...), nil
}

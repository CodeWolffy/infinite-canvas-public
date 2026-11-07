import { expect, test } from "vitest";
import { mergeCanvasSnapshots, type SharedCanvasSnapshot } from "@/lib/canvas/canvas-collaboration-merge";
import { CanvasNodeType, type CanvasConnection, type CanvasNodeData } from "@/types/canvas";

const node = (id: string, overrides: Partial<CanvasNodeData> = {}): CanvasNodeData => ({ id, type: CanvasNodeType.Text, title: id, position: { x: 0, y: 0 }, width: 240, height: 160, ...overrides });
const snapshot = (nodes = [node("a"), node("b")], connections: CanvasConnection[] = []): SharedCanvasSnapshot => ({ nodes, connections, backgroundMode: "dots", showImageInfo: true });
const copy = (value: SharedCanvasSnapshot): SharedCanvasSnapshot => structuredClone(value);

test("两人修改不同节点时保留双方内容，不改变输入快照", () => {
    const base = snapshot(), local = copy(base), remote = copy(base);
    local.nodes[0].title = "本地标题";
    remote.nodes[1].position = { x: 400, y: 200 };
    const inputs = JSON.stringify([base, local, remote]);
    const result = mergeCanvasSnapshots(base, local, remote);
    expect(result.nodes.map((item) => [item.id, item.title, item.position])).toEqual([
        ["a", "本地标题", { x: 0, y: 0 }], ["b", "b", { x: 400, y: 200 }],
    ]);
    expect(JSON.stringify([base, local, remote])).toBe(inputs);
});

test("同一节点的独立字段和画布设置可以合并", () => {
    const base = snapshot([node("a", { metadata: { content: "原文", fontSize: 16 } })]);
    const local = copy(base), remote = copy(base);
    local.nodes[0].position.x = 120;
    local.nodes[0].metadata!.content = "新文字";
    local.backgroundMode = "grid";
    remote.nodes[0].position.y = 80;
    remote.nodes[0].metadata!.fontSize = 24;
    remote.showImageInfo = false;
    expect(mergeCanvasSnapshots(base, local, remote)).toEqual({
        nodes: [node("a", { position: { x: 120, y: 80 }, metadata: { content: "新文字", fontSize: 24 } })],
        connections: [], backgroundMode: "grid", showImageInfo: false,
    });
});

test("同时修改同一字段为不同值必须报告冲突", () => {
    const base = snapshot(), local = copy(base), remote = copy(base);
    local.nodes[0].title = "本地";
    remote.nodes[0].title = "远端";
    expect(() => mergeCanvasSnapshots(base, local, remote)).toThrow();
    expect(local.nodes[0].title).toBe("本地");
    expect(remote.nodes[0].title).toBe("远端");
});

test("节点内的数组按整体处理，不能按下标拼接并发修改", () => {
    const base = snapshot([node("a", { metadata: { texts: [
        { id: "first", content: "第一版", status: "success" }, { id: "second", content: "第二版", status: "success" },
    ] } })]);
    const local = copy(base), remote = copy(base);
    local.nodes[0].metadata!.texts![0].content = "本地改第一项";
    remote.nodes[0].metadata!.texts![1].content = "远端改第二项";
    expect(() => mergeCanvasSnapshots(base, local, remote)).toThrow();
});

test("服务端仅重排数组内对象字段时，本地真实数组编辑不应误报冲突", () => {
    const base = snapshot([node("a", { metadata: { texts: [
        { id: "first", status: "success", content: "原内容" },
    ] } })]);
    const local = copy(base), remote = copy(base);
    remote.nodes[0].metadata!.texts = [{ content: "原内容", id: "first", status: "success" }];
    expect(remote.nodes[0].metadata!.texts).toEqual(base.nodes[0].metadata!.texts);
    expect(JSON.stringify(remote.nodes[0].metadata!.texts)).not.toBe(JSON.stringify(base.nodes[0].metadata!.texts));
    local.nodes[0].metadata!.texts![0].content = "本地更新";
    local.nodes[0].metadata!.texts!.push({ id: "second", content: "本地追加", status: "success" });
    remote.nodes[0].title = "远端标题";
    const result = mergeCanvasSnapshots(base, local, remote);
    expect(result.nodes[0].title).toBe("远端标题");
    expect(result.nodes[0].metadata!.texts).toEqual([
        { id: "first", status: "success", content: "本地更新" },
        { id: "second", content: "本地追加", status: "success" },
    ]);
});

test("单方数组编辑可与另一方普通字段编辑合并", () => {
    const base = snapshot([node("a", { metadata: { references: ["one"] } })]);
    const local = copy(base), remote = copy(base);
    local.nodes[0].metadata!.references!.push("two");
    remote.nodes[0].title = "远端标题";
    const result = mergeCanvasSnapshots(base, local, remote);
    expect(result.nodes[0].title).toBe("远端标题");
    expect(result.nodes[0].metadata?.references).toEqual(["one", "two"]);
});

test.each(["local", "remote"])("%s删除节点与另一方新增连线冲突，不生成悬空引用", (deletedBy) => {
    const base = snapshot(), deleted = snapshot([node("b")]), connected = copy(base);
    connected.connections.push({ id: "a-to-b", fromNodeId: "a", toNodeId: "b" });
    expect(() => mergeCanvasSnapshots(base, deletedBy === "local" ? deleted : connected, deletedBy === "remote" ? deleted : connected)).toThrow("连线引用的节点");
});

test("删除节点和对应旧连线可与无关节点编辑合并", () => {
    const base = snapshot(undefined, [{ id: "link", fromNodeId: "a", toNodeId: "b" }]);
    const local = snapshot([node("b")]), remote = copy(base);
    remote.nodes[1].title = "保留的节点";
    const result = mergeCanvasSnapshots(base, local, remote);
    expect(result.nodes).toEqual([node("b", { title: "保留的节点" })]);
    expect(result.connections).toEqual([]);
});

test("双方重复的等值更新、删除和新增不会误报冲突或出现重复节点", () => {
    const base = snapshot(), same = snapshot([node("a", { title: "一致的新标题" }), node("c", { metadata: { references: ["same"] } })]);
    expect(mergeCanvasSnapshots(base, copy(same), copy(same))).toEqual(same);
});

test("新增相同编号但内容不同的节点必须报告冲突", () => {
    const base = snapshot([]), local = snapshot([node("same", { title: "甲" })]), remote = snapshot([node("same", { title: "乙" })]);
    expect(() => mergeCanvasSnapshots(base, local, remote)).toThrow();
});

test("双方各自新增节点时保留远端顺序，再接入本地新增节点", () => {
    const base = snapshot([node("a")]), local = snapshot([node("a"), node("mine")]), remote = snapshot([node("a"), node("theirs")]);
    expect(mergeCanvasSnapshots(base, local, remote).nodes.map((item) => item.id)).toEqual(["a", "theirs", "mine"]);
});

test.each(["local", "remote"])("只有%s调整节点顺序时采用该顺序并保留另一方字段编辑", (reorderedBy) => {
    const base = snapshot([node("a"), node("b"), node("c")]);
    const reordered = snapshot([node("c"), node("a"), node("b")]), edited = copy(base);
    edited.nodes[0].title = "已修改";
    const result = mergeCanvasSnapshots(base, reorderedBy === "local" ? reordered : edited, reorderedBy === "remote" ? reordered : edited);
    expect(result.nodes.map((item) => item.id)).toEqual(["c", "a", "b"]);
    expect(result.nodes.find((item) => item.id === "a")?.title).toBe("已修改");
});

test("双方相同排序可以合并，不同排序则显式冲突", () => {
    const base = snapshot([node("a"), node("b"), node("c")]);
    const local = snapshot([node("c"), node("a"), node("b")]);
    expect(mergeCanvasSnapshots(base, local, copy(local)).nodes.map((item) => item.id)).toEqual(["c", "a", "b"]);
    const remote = snapshot([node("b"), node("c"), node("a")]);
    expect(() => mergeCanvasSnapshots(base, local, remote)).toThrow("节点顺序");
});

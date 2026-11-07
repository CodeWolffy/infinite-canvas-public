import * as React from "react";
import ts from "typescript";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";
import { evaluate, findNode, loadModule, readSource, sourceFile } from "./support/source-loader";

const account = { user: { id: "me" } };
const useUserStore = Object.assign((select: (state: typeof account) => unknown) => select(account), { getState: () => account });
const helpersSource = sourceFile("lib/canvas/canvas-generation-helpers.ts");
const declarations = helpersSource.statements.filter((part) => ts.isFunctionDeclaration(part) && ["canRecoverCanvasGeneration", "hasResumableVideoTask", "resetInterruptedGeneration"].includes(part.name?.text || ""));
const textHelpers = loadModule(readSource("lib/canvas/canvas-text-generation.ts"));
const generationHelpers = loadModule(declarations.map((part) => part.getText(helpersSource)).join("\n"), { CanvasNodeType, ...textHelpers, useUserStore, i18n: { t: () => "已中断" } });
const batch = vi.fn(), watch = vi.fn();
const subscriptions = new Map<string, { update: (detail: unknown) => void; stop: ReturnType<typeof vi.fn> }>();
const { useCanvasGenerationRecovery } = loadModule(readSource("pages/canvas/hooks/use-canvas-generation-recovery.ts"), { window }, {
    react: React, "@/services/api/generation": { getGenerationBatch: batch }, "@/services/api/text": { watchTextRequest: watch },
    "@/services/api/request": { ApiError: class extends Error {} }, "@/lib/canvas/canvas-text-generation": textHelpers,
    "@/lib/canvas/canvas-node-size": { fitNodeSize: (width: number, height: number) => ({ width, height }) },
    "@/lib/canvas/canvas-generation-helpers": generationHelpers, "@/stores/use-user-store": { useUserStore }, "@/types/canvas": { CanvasNodeType },
});
const t = (key: string) => key;
const node = (id: string, type: CanvasNodeType, owner?: string): CanvasNodeData => ({ id, type, title: id, width: 100, height: 100, position: { x: 0, y: 0 }, metadata: { generationUserId: owner, status: "loading" } });
const textNode = (id: string, owner?: string): CanvasNodeData => ({ ...node(id, CanvasNodeType.Text, owner), metadata: { generationUserId: owner, status: "loading", textRequestId: `text-${id}` } });
const imageNode = (id: string, owner?: string): CanvasNodeData => ({ ...node(id, CanvasNodeType.Image, owner), metadata: { generationUserId: owner, status: "loading", images: [{ id: "slot", status: "loading", generationBatchId: `batch-${id}`, generationTaskId: "task", content: "", naturalWidth: 0, naturalHeight: 0, bytes: 0, mimeType: "" }] } });
function recovery(initial: CanvasNodeData[]) {
    return renderHook(() => {
        const [nodes, setNodes] = React.useState(initial);
        const requests = React.useRef(new Map());
        useCanvasGenerationRecovery({ nodes, setNodes, connections: [], projectLoaded: true, t, generationRequestsRef: requests });
        return { nodes, setNodes };
    });
}
const projectSource = sourceFile("pages/canvas/project.tsx", ts.ScriptKind.TSX);
function callback(name: string, context: Record<string, unknown>) {
    const declaration = findNode(projectSource, (part) => ts.isVariableDeclaration(part) && part.name.getText(projectSource) === name) as ts.VariableDeclaration;
    const expression = (declaration.initializer as ts.CallExpression).arguments[0];
    return evaluate(expression.getText(projectSource), { ...generationHelpers, useUserStore, CanvasNodeType, AbortController, ...context });
}

beforeEach(() => {
    vi.useFakeTimers();
    subscriptions.clear();
    batch.mockReset().mockResolvedValue({ tasks: [{ id: "task", status: "running" }] });
    watch.mockReset().mockImplementation((id, update) => { const stop = vi.fn(); subscriptions.set(id, { update, stop }); return stop; });
});
afterEach(() => { cleanup(); vi.clearAllTimers(); vi.useRealTimers(); });

test("其他协作者的图片和文本任务不访问私人接口，也不改为失败", async () => {
    const initial = [imageNode("image-other", "other"), textNode("text-other", "other"), node("config-other", CanvasNodeType.Config, "other")];
    const hook = recovery(initial);
    await act(async () => { await vi.advanceTimersByTimeAsync(5400); });
    expect(batch).not.toHaveBeenCalled();
    expect(watch).not.toHaveBeenCalled();
    expect(hook.result.current.nodes).toEqual(initial);
});

test("本人任务与无归属旧任务正常恢复，外部任务只保留共享状态", async () => {
    const hook = recovery([imageNode("mine-image", "me"), imageNode("legacy-image"), imageNode("other-image", "other"), textNode("mine", "me"), textNode("legacy"), textNode("other", "other")]);
    await act(async () => {});
    expect(batch.mock.calls.map(([id]) => id)).toEqual(["batch-mine-image", "batch-legacy-image"]);
    expect(watch.mock.calls.map(([id]) => id)).toEqual(["text-mine", "text-legacy"]);
    act(() => subscriptions.get("text-mine")!.update({ request: { status: "succeeded" }, message: { content: "本人结果" } }));
    expect(hook.result.current.nodes.find((item) => item.type === CanvasNodeType.Text && item.id === "mine")?.metadata?.content).toBe("本人结果");
    expect(hook.result.current.nodes.filter((item) => item.metadata?.generationUserId === "other").every((item) => item.metadata?.status === "loading")).toBe(true);
});

test("恢复期间节点改由其他账号生成，迟到文本结果不改写新任务", async () => {
    const hook = recovery([textNode("text", "me")]);
    const previous = subscriptions.get("text-text")!;
    act(() => hook.result.current.setNodes([textNode("text", "other")]));
    expect(previous.stop).toHaveBeenCalledOnce();
    act(() => previous.update({ request: { status: "succeeded" }, message: { content: "旧结果" } }));
    expect(hook.result.current.nodes[0].metadata).toMatchObject({ generationUserId: "other", status: "loading" });
    expect(hook.result.current.nodes[0].metadata?.content).toBeUndefined();
});

test.each([CanvasNodeType.Text, CanvasNodeType.Image, CanvasNodeType.Video, CanvasNodeType.Audio, CanvasNodeType.Config])("刷新时保留其他账号的%s准备状态，本人及旧任务仍按原逻辑中断", (type) => {
    const other = node("other", type, "other"), mine = node("mine", type, "me"), legacy = node("legacy", type);
    const restored = generationHelpers.resetInterruptedGeneration([other, mine, legacy]);
    expect(restored[0]).toBe(other);
    expect(restored[1].metadata.status).toBe("error");
    expect(restored[2].metadata.status).toBe("error");
});

test.each(["pollVideoNodeTask", "pollAudioNodeTask"])("%s不轮询其他成员任务", async (name) => {
    const waiting = vi.fn(), setNodes = vi.fn(), started = vi.fn();
    const run = callback(name, { waitForVideoGenerationTask: waiting, waitForGenerationTask: waiting, setNodes, startGenerationRequest: started });
    await run({ ...node("foreign", CanvasNodeType.Video, "other"), metadata: { generationUserId: "other", videoTaskId: "private-video", audioTaskId: "private-audio" } });
    expect(waiting).not.toHaveBeenCalled();
    expect(started).not.toHaveBeenCalled();
    expect(setNodes).not.toHaveBeenCalled();
});

test("共享任务重试不会复用其他账号的私有任务编号", async () => {
    const warning = vi.fn(), retried = vi.fn();
    const run = callback("handleRetryNode", {
        canEditRef: { current: true }, accessRoleRef: { current: "editor" }, loadedSessionVersionRef: { current: undefined },
        message: { warning }, retryGenerationTask: retried,
    });
    await run(imageNode("foreign", "other"), "slot");
    expect(warning).toHaveBeenCalledOnce();
    expect(retried).not.toHaveBeenCalled();
});

test("任务启动标记本人及新节点，不接管其他成员仍在运行的文本请求", () => {
    let nodes = [node("image", CanvasNodeType.Image), node("text", CanvasNodeType.Text), node("video", CanvasNodeType.Video), node("audio", CanvasNodeType.Audio), node("config", CanvasNodeType.Config), textNode("foreign", "other")];
    const run = callback("startGenerationRequest", { generationRequestsRef: { current: new Map() }, setNodes: (change: (previous: CanvasNodeData[]) => CanvasNodeData[]) => { nodes = change(nodes); } });
    for (const item of nodes) run(item.id, item.id);
    expect(nodes.slice(0, 5).every((item) => item.metadata?.generationUserId === "me")).toBe(true);
    expect(nodes[5].metadata?.generationUserId).toBe("other");
});

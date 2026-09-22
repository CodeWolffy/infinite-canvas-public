import ts from "typescript";
import { expect, test } from "vitest";
import { findNode, loadModule, readSource, sourceFile } from "./support/source-loader";

const helpers = loadModule(readSource("lib/canvas/canvas-text-generation.ts"));
const reasoning = loadModule(readSource("lib/model-reasoning.ts"), {}, { "@/i18n": { default: { t: (key: string) => key } } });
const restoreSource = sourceFile("lib/canvas/canvas-generation-helpers.ts");
const restoreDeclaration = restoreSource.statements.find((part) => ts.isFunctionDeclaration(part) && part.name?.text === "resetInterruptedGeneration")!;
const { resetInterruptedGeneration } = loadModule(restoreDeclaration.getText(restoreSource), {
    ...helpers, CanvasNodeType: { Text: "text", Config: "config", Image: "image" }, hasResumableVideoTask: () => false, i18n: { t: () => "interrupted" },
});
const node = (): any => ({ id: "node", type: "text", metadata: { status: "loading", primaryTextId: "a", texts: ["a", "b"].map((id) => ({ id, status: "loading", content: "", textRequestId: `request-${id}`, conversationId: `conversation-${id}` })) } });

test("each text result restores independently and ignores another request's response", () => {
    const first = node();
    const partial = helpers.applyTextGenerationResult(first, "request-b", { status: "success", content: "B" });
    expect(partial.metadata.status).toBe("loading");
    expect(partial.metadata.content).toBe("B");
    expect(partial.metadata.conversationId).toBe("conversation-b");
    const finished = helpers.applyTextGenerationResult(partial, "request-a", { status: "success", content: "A" });
    expect(finished.metadata.status).toBe("success");
    expect(Array.from(finished.metadata.texts, (text: any) => text.content)).toEqual(["A", "B"]);
    expect(helpers.applyTextGenerationResult(first, "old-request", { status: "success", content: "wrong" })).toBe(first);
});

test("initial multi-text generation persists distinct request and conversation associations", async () => {
    const source = sourceFile("pages/canvas/project.tsx", ts.ScriptKind.TSX);
    const call = findNode(source, (part) => ts.isCallExpression(part) && ts.isPropertyAccessExpression(part.expression) && part.expression.getText(source) === "textIds.map" && ts.isArrowFunction(part.arguments[0]) && part.arguments[0].getText(source).includes("requestImageQuestion")) as ts.CallExpression;
    expect(call).toBeTruthy();
    const callback = call.arguments[0];
    let current = node();
    current.metadata.texts = current.metadata.texts.map(({ id }: any) => ({ id, status: "loading", content: "" }));
    let sequence = 0;
    const { generate } = loadModule(`export const generate = ${callback.getText(source)};`, {
        ...helpers,
        textIds: ["a", "b"], rootId: "node", projectId: "project", sourceNode: {}, generationConfig: {}, generationContext: {}, effectivePrompt: "question", controller: new AbortController(),
        NODE_STATUS_LOADING: "loading", NODE_STATUS_SUCCESS: "success", NODE_STATUS_ERROR: "error",
        buildNodeResponseMessages: () => [], isGenerationCanceled: () => false, t: (key: string) => key,
        setNodes: (update: any) => { current = update([current])[0]; },
        requestImageQuestion: async (_config: any, _messages: any, onDelta: any, options: any) => {
            const id = ++sequence;
            options.onTextRequestPrepared(`request-${id}`, `conversation-${id}`);
            onDelta(`answer-${id}`);
            return `answer-${id}`;
        },
    });
    const results = await Promise.all([generate("a"), generate("b")]);
    expect(Array.from(current.metadata.texts, (text: any) => text.textRequestId)).toEqual(["request-1", "request-2"]);
    expect(Array.from(current.metadata.texts, (text: any) => text.conversationId)).toEqual(["conversation-1", "conversation-2"]);
    expect(results.map((text: any) => text.textRequestId)).toEqual(["request-1", "request-2"]);
});

function deferred() {
    let resolve: (value?: any) => void;
    const promise = new Promise((done) => { resolve = done; });
    return { promise, resolve: resolve! };
}
function textGeneration({ count = 2, request, failBeforeSubmit = false, reasoningEffort = "auto", reasoningEfforts = [] as string[] }: { count?: number; request?: (input: any, index: number) => Promise<any>; failBeforeSubmit?: boolean; reasoningEffort?: string; reasoningEfforts?: string[] } = {}) {
    const project = sourceFile("pages/canvas/project.tsx", ts.ScriptKind.TSX);
const recoverySource = sourceFile("pages/canvas/hooks/use-canvas-generation-recovery.ts");
    const api = sourceFile("services/api/image.ts");
    const user = { sessionVersion: 1 };
    const requests: any[] = [], errors: any[] = [], started: any[] = [];
    let sequence = 0, conversation = 0;
    let nodes: any[] = [{ id: "source", type: "config", metadata: { status: "loading", prompt: "question" } }, { ...node(), metadata: { status: "loading", prompt: "question", primaryTextId: "a", texts: ["a", "b"].slice(0, count).map((id) => ({ id, status: "loading", content: "" })) } }];
    const context: Record<string, any> = {
        ...helpers, ...reasoning, AbortController, DOMException,
        findChannelModel: () => ({ model: { reasoningEfforts } }),
        useUserStore: { getState: () => user },
        assertCurrentSession: (version: number) => { if (user.sessionVersion !== version) throw new DOMException("changed session", "AbortError"); },
        textIds: ["a", "b"].slice(0, count), rootId: "node", nodeId: "source", projectId: "project", sourceNode: nodes[0], generationConfig: { model: "model", reasoningEffort }, generationContext: {}, effectivePrompt: "question", controller: new AbortController(), isConfigNode: true,
        NODE_STATUS_LOADING: "loading", NODE_STATUS_SUCCESS: "success", NODE_STATUS_ERROR: "error", NODE_STATUS_IDLE: "idle", CanvasNodeType: { Text: "text", Config: "config", Image: "image" },
        buildNodeResponseMessages: () => [{ role: "user", content: "question" }], isGenerationCanceled: (error: any) => error?.name === "AbortError", t: (key: string) => key,
        setNodes: (update: any) => { nodes = update(nodes); context.nodesRef.current = nodes; }, nodesRef: { current: nodes },
        setExpandedBatchNodeIds: () => {}, setRunningNodeId: () => {}, finishGenerationRequest: () => {}, message: { error: (error: any) => errors.push(error), warning: (error: any) => errors.push(error) },
        startGenerationRequest: () => { started.push(true); return new AbortController(); },
        hasResumableVideoTask: () => false, findRetrySourceNode: () => nodes[0], config: {}, buildGenerationConfig: () => ({ model: "model", reasoningEffort: "auto" }), hasPlatformModel: () => true,
        hydrateNodeGenerationContext: async () => ({ prompt: "question", referenceImages: [] }), buildNodeGenerationContext: () => ({}), isVideoTaskFailed: () => false,
        connections: [{ fromNodeId: "source", toNodeId: "node" }], connectionsRef: { current: [{ fromNodeId: "source", toNodeId: "node" }] }, disposed: false, missingTextRequestsRef: { current: new Map() },
    };
    const declarations = ["requestImageQuestion", "waitForTextRequest"].map((name) => api.statements.find((part) => ts.isFunctionDeclaration(part) && part.name?.text === name)!.getText(api));
    context.requestImageQuestion = loadModule(declarations.join("\n"), {
        ...context, crypto: { randomUUID: () => `request-${++sequence}` }, textMessageContent: (content: any) => content, apiText: (key: string) => key,
        createTextConversation: async () => ({ id: `conversation-${++conversation}` }),
        resolvePlatformModelId: async () => { if (failBeforeSubmit) throw new Error("model unavailable"); return "model"; },
        createTextRequest: async (input: any) => { requests.push(input); return request ? request(input, requests.length) : { message: { content: `answer-${input.requestId}` } }; },
    }).requestImageQuestion;
    const batch = findNode(project, (part) => ts.isVariableStatement(part) && part.declarationList.declarations.some((item) => item.name.getText(project) === "results" && item.initializer?.getText(project).includes("textIds.map"))) as ts.VariableStatement;
    expect(batch).toBeTruthy();
    const batchBlock = batch.parent as ts.Block;
    const batchCode = batchBlock.statements.slice(batchBlock.statements.indexOf(batch)).map((part) => part.getText(project)).join("\n");
    const retry = ((findNode(project, (part) => ts.isVariableDeclaration(part) && part.name.getText(project) === "handleRetryNode") as ts.VariableDeclaration).initializer as ts.CallExpression).arguments[0];
    // 文本恢复已改为复用 SSE，取订阅回调里应用快照的 applyTextDetail。
    const recovery = (findNode(recoverySource, (part) => ts.isVariableDeclaration(part) && part.name.getText(recoverySource) === "applyTextDetail") as ts.VariableDeclaration).initializer;
    return {
        user, context, requests, errors, started,
        get root() { return nodes.find((item) => item.id === "node"); },
        get parent() { return nodes[0]; },
        setRoot: (root: any) => context.setNodes((items: any[]) => items.map((item) => item.id === root.id ? root : item)),
        generate: () => loadModule(`export async function generate() { ${batchCode} }`, context).generate(),
        retry: (root: any) => loadModule(`export const retry = ${retry.getText(project)};`, context).retry(root),
        recover: (requestId: string, status: string, content = "") => loadModule(`export const recover = ${recovery.getText(recoverySource)};`, { ...context, nodeId: "node", requestId, missingTextRequestsRef: { current: new Map() } }).recover("node", requestId, { request: { status, errorCode: status === "failed" ? "channel_error" : null }, message: status === "succeeded" ? { content } : null }),
    };
}

test("lost text POST responses retain every submitted slot for recovery after reload", async () => {
    const setup = textGeneration({ request: async () => { throw new TypeError("connection lost"); } });
    await setup.generate();
    expect(setup.requests.length).toBe(2);
    expect(setup.root.metadata.status).toBe("loading");
    expect(setup.parent.metadata.status).toBe("loading");
    expect(Array.from(setup.root.metadata.texts, (text: any) => [text.status, text.textRequestId, text.conversationId])).toEqual([["loading", "request-1", "conversation-1"], ["loading", "request-2", "conversation-2"]]);
    setup.setRoot(resetInterruptedGeneration([JSON.parse(JSON.stringify(setup.root))])[0]);
    setup.recover("request-1", "succeeded", "first answer");
    setup.recover("request-2", "succeeded", "second answer");
    expect(Array.from(setup.root.metadata.texts, (text: any) => text.content)).toEqual(["first answer", "second answer"]);
    expect(setup.root.metadata.status).toBe("success");
    expect(setup.parent.metadata.status).toBe("success");
});

test("canvas sends only reasoning levels supported by the selected model", async () => {
    for (const [reasoningEfforts, expected] of [[['high', 'ultra'], 'ultra'], [['high'], undefined], [[], undefined]] as [string[], string | undefined][]) {
        const setup = textGeneration({ reasoningEffort: "ultra", reasoningEfforts });
        await setup.generate();
        expect(setup.requests.length).toBe(2);
        expect(setup.requests.every((request) => request.parameters.reasoningEffort === expected)).toBe(true);
    }
});

test("a lost multi-text response keeps successful siblings and later records authoritative failure", async () => {
    const setup = textGeneration({ request: async (_input, index) => { if (index === 2) throw new TypeError("connection lost"); return { message: { content: "first answer" } }; } });
    await setup.generate();
    expect(Array.from(setup.root.metadata.texts, (text: any) => text.status)).toEqual(["success", "loading"]);
    expect(setup.root.metadata.status).toBe("loading");
    setup.recover("request-2", "failed");
    expect(Array.from(setup.root.metadata.texts, (text: any) => text.status)).toEqual(["success", "error"]);
    expect(setup.root.metadata.texts[1].textRequestId).toBe("request-2");
    expect(setup.root.metadata.content).toBe("first answer");
    expect(setup.root.metadata.status).toBe("success");
});

test("text failures before request preparation stay failed instead of polling nonexistent work", async () => {
    const setup = textGeneration({ failBeforeSubmit: true });
    await setup.generate();
    expect(setup.requests.length).toBe(0);
    expect(setup.root.metadata.texts.length).toBe(2);
    expect(setup.root.metadata.texts.every((text: any) => text.status === "error" && !text.textRequestId)).toBe(true);
    expect(setup.root.metadata.status).toBe("error");
    expect(setup.parent.metadata.status).toBe("error");
});

for (const result of ["lost response", "late response"]) {
    test(`a materialized text result survives the original ${result} and aggregate callback`, async () => {
        const entered = deferred(), finish = deferred();
        const setup = textGeneration({ count: 1, request: async (input) => { entered.resolve(input); await finish.promise; if (result === "lost response") throw new TypeError("connection lost"); return { message: { content: "outdated response" } }; } });
        const pending = setup.generate();
        const input = await entered.promise;
        setup.recover(input.requestId, "succeeded", "authoritative answer");
        finish.resolve();
        await pending;
        expect(setup.root.metadata.content).toBe("authoritative answer");
        expect(setup.root.metadata.texts[0].content).toBe("authoritative answer");
        expect(setup.root.metadata.status).toBe("success");
    });
}

for (const batch of [false, true]) {
    test(`retry with ${batch ? "multiple text slots" : "a single text node"} recovers a lost response`, async () => {
        const setup = textGeneration({ request: async () => { throw new TypeError("connection lost"); } });
        const failed = { ...node(), metadata: batch ? { ...node().metadata, prompt: "question", status: "error", texts: node().metadata.texts.map((text: any) => ({ ...text, status: "error" })) } : { prompt: "question", status: "error" } };
        setup.setRoot(failed);
        await setup.retry(failed);
        const requestId = setup.requests[0].requestId;
        expect(setup.root.metadata.status).toBe("loading");
        expect(setup.root.metadata.textRequestId).toBe(requestId);
        expect(helpers.textGenerationRequests(setup.root).find((text: any) => text.textRequestId === requestId).status).toBe("loading");
        setup.recover(requestId, batch ? "failed" : "succeeded", "retried answer");
        expect(setup.root.metadata.status).toBe(batch ? "error" : "success");
        expect(helpers.textGenerationRequests(setup.root).find((text: any) => text.textRequestId === requestId).status).toBe(batch ? "error" : "success");
    });
}

test("retry preparation cannot start a text request after the login session changes", async () => {
    const setup = textGeneration();
    const entered = deferred(), finish = deferred();
    setup.context.hydrateNodeGenerationContext = () => { entered.resolve(); return finish.promise; };
    const pending = setup.retry(setup.root);
    await entered.promise;
    setup.user.sessionVersion++;
    finish.resolve({ prompt: "old private question", referenceImages: [] });
    await pending;
    expect(setup.requests.length).toBe(0);
    expect(setup.started.length).toBe(0);
    expect(setup.errors.length).toBe(0);
});

test("reload only interrupts text slots without a prepared server request", () => {
    const pending = node();
    delete pending.metadata.texts[0].textRequestId;
    const [restored] = resetInterruptedGeneration([pending]);
    expect(restored.metadata.status).toBe("loading");
    expect(restored.metadata.texts[0].status).toBe("error");
    expect(restored.metadata.texts[1].status).toBe("loading");
});

test("reload during retry preparation does not treat old failed requests as pending", () => {
    const root = node();
    root.metadata.texts = root.metadata.texts.map((text: any) => ({ ...text, status: "error" }));
    const parent = { id: "source", type: "config", metadata: { status: "loading" } };
    const [restoredParent, restored] = resetInterruptedGeneration([parent, root], [{ fromNodeId: "source", toNodeId: "node" }]);
    expect(restoredParent.metadata.status).toBe("error");
    expect(restored.metadata.status).toBe("error");
    expect(restored.metadata.texts[0].textRequestId).toBe("request-a");
    expect(restored.metadata.texts.every((text: any) => text.status === "error")).toBe(true);
});

test("history changes wait for pending saves and stop on save failure or session replacement", async () => {
    const source = sourceFile("components/canvas/canvas-history-modal.tsx", ts.ScriptKind.TSX);
    const declaration = source.statements.find((part) => ts.isFunctionDeclaration(part) && part.name?.text === "flushBeforeHistoryChange")!;
    const user = { sessionVersion: 1 };
    const store: any = { saveError: null, flushProject: async () => {} };
    const { flushBeforeHistoryChange } = loadModule(`${declaration.getText(source)}\nexport { flushBeforeHistoryChange };`, {
        useUserStore: { getState: () => user }, useCanvasStore: { getState: () => store },
        assertCurrentSession: (version: number) => { if (version !== user.sessionVersion) throw new Error("changed session"); },
    });
    let release: (() => void) | undefined, finished = false;
    store.flushProject = () => new Promise((resolve) => { release = resolve; });
    const pending = flushBeforeHistoryChange("project").then(() => { finished = true; });
    await Promise.resolve();
    expect(finished).toBe(false);
    release!();
    await pending;
    store.flushProject = async () => { store.saveError = { projectId: "project", message: "save failed" }; };
    await expect(flushBeforeHistoryChange("project")).rejects.toThrow(/save failed/);
    store.flushProject = async () => { user.sessionVersion++; };
    await expect(flushBeforeHistoryChange("project")).rejects.toThrow(/changed session/);
});

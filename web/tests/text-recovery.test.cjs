const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");
const { runInNewContext } = require("node:vm");
const { test } = require("node:test");
const ts = require("typescript");

function compile(source, context = {}) {
    const module = { exports: {} };
    const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
    runInNewContext(code, { module, exports: module.exports, ...context });
    return module.exports;
}
const read = (path) => readFileSync(resolve(__dirname, "../src", path), "utf8");
const helpers = compile(read("lib/canvas/canvas-text-generation.ts"));
const reasoning = compile(read("lib/model-reasoning.ts"), { require: (name) => { assert.equal(name, "@/i18n"); return { default: { t: (key) => key } }; } });
const restoreSource = ts.createSourceFile("helpers.ts", read("lib/canvas/canvas-generation-helpers.ts"), ts.ScriptTarget.Latest, true);
const restoreDeclaration = restoreSource.statements.find((part) => ts.isFunctionDeclaration(part) && part.name?.text === "resetInterruptedGeneration");
const { resetInterruptedGeneration } = compile(restoreDeclaration.getText(restoreSource), {
    ...helpers, CanvasNodeType: { Text: "text", Config: "config", Image: "image" }, hasResumableVideoTask: () => false, i18n: { t: () => "interrupted" },
});
const node = () => ({ id: "node", type: "text", metadata: { status: "loading", primaryTextId: "a", texts: ["a", "b"].map((id) => ({ id, status: "loading", content: "", textRequestId: `request-${id}`, conversationId: `conversation-${id}` })) } });

test("each text result restores independently and ignores another request's response", () => {
    const first = node();
    const partial = helpers.applyTextGenerationResult(first, "request-b", { status: "success", content: "B" });
    assert.equal(partial.metadata.status, "loading");
    assert.equal(partial.metadata.content, "B");
    assert.equal(partial.metadata.conversationId, "conversation-b");
    const finished = helpers.applyTextGenerationResult(partial, "request-a", { status: "success", content: "A" });
    assert.equal(finished.metadata.status, "success");
    assert.deepEqual(Array.from(finished.metadata.texts, (text) => text.content), ["A", "B"]);
    assert.strictEqual(helpers.applyTextGenerationResult(first, "old-request", { status: "success", content: "wrong" }), first);
});

test("initial multi-text generation persists distinct request and conversation associations", async () => {
    const source = ts.createSourceFile("project.tsx", read("pages/canvas/project.tsx"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    let callback;
    const visit = (part) => {
        if (ts.isCallExpression(part) && ts.isPropertyAccessExpression(part.expression) && part.expression.getText(source) === "textIds.map" && ts.isArrowFunction(part.arguments[0]) && part.arguments[0].getText(source).includes("requestImageQuestion")) callback = part.arguments[0];
        ts.forEachChild(part, visit);
    };
    visit(source);
    assert.ok(callback);
    let current = node();
    current.metadata.texts = current.metadata.texts.map(({ id }) => ({ id, status: "loading", content: "" }));
    let sequence = 0;
    const { generate } = compile(`export const generate = ${callback.getText(source)};`, {
        ...helpers,
        textIds: ["a", "b"], rootId: "node", projectId: "project", sourceNode: {}, generationConfig: {}, generationContext: {}, effectivePrompt: "question", controller: new AbortController(),
        NODE_STATUS_LOADING: "loading", NODE_STATUS_SUCCESS: "success", NODE_STATUS_ERROR: "error",
        buildNodeResponseMessages: () => [], isGenerationCanceled: () => false, t: (key) => key,
        setNodes: (update) => { current = update([current])[0]; },
        requestImageQuestion: async (_config, _messages, onDelta, options) => {
            const id = ++sequence;
            options.onTextRequestPrepared(`request-${id}`, `conversation-${id}`);
            onDelta(`answer-${id}`);
            return `answer-${id}`;
        },
    });
    const results = await Promise.all([generate("a"), generate("b")]);
    assert.deepEqual(Array.from(current.metadata.texts, (text) => text.textRequestId), ["request-1", "request-2"]);
    assert.deepEqual(Array.from(current.metadata.texts, (text) => text.conversationId), ["conversation-1", "conversation-2"]);
    assert.deepEqual(results.map((text) => text.textRequestId), ["request-1", "request-2"]);
});

function findNode(source, predicate) {
    return predicate(source) ? source : ts.forEachChild(source, (child) => findNode(child, predicate));
}
function deferred() {
    let resolve;
    const promise = new Promise((done) => { resolve = done; });
    return { promise, resolve };
}
function textGeneration({ count = 2, request, failBeforeSubmit = false, reasoningEffort = "auto", reasoningEfforts = [] } = {}) {
    const project = ts.createSourceFile("project.tsx", read("pages/canvas/project.tsx"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const api = ts.createSourceFile("image.ts", read("services/api/image.ts"), ts.ScriptTarget.Latest, true);
    const user = { sessionVersion: 1 };
    const requests = [], errors = [], started = [];
    let sequence = 0, conversation = 0;
    let nodes = [{ id: "source", type: "config", metadata: { status: "loading", prompt: "question" } }, { ...node(), metadata: { status: "loading", prompt: "question", primaryTextId: "a", texts: ["a", "b"].slice(0, count).map((id) => ({ id, status: "loading", content: "" })) } }];
    const context = {
        ...helpers, ...reasoning, AbortController, DOMException,
        findChannelModel: () => ({ model: { reasoningEfforts } }),
        useUserStore: { getState: () => user },
        assertCurrentSession: (version) => { if (user.sessionVersion !== version) throw new DOMException("changed session", "AbortError"); },
        textIds: ["a", "b"].slice(0, count), rootId: "node", nodeId: "source", projectId: "project", sourceNode: nodes[0], generationConfig: { model: "model", reasoningEffort }, generationContext: {}, effectivePrompt: "question", controller: new AbortController(), isConfigNode: true,
        NODE_STATUS_LOADING: "loading", NODE_STATUS_SUCCESS: "success", NODE_STATUS_ERROR: "error", NODE_STATUS_IDLE: "idle", CanvasNodeType: { Text: "text", Config: "config", Image: "image" },
        buildNodeResponseMessages: () => [{ role: "user", content: "question" }], isGenerationCanceled: (error) => error?.name === "AbortError", t: (key) => key,
        setNodes: (update) => { nodes = update(nodes); context.nodesRef.current = nodes; }, nodesRef: { current: nodes },
        setExpandedBatchNodeIds: () => {}, setRunningNodeId: () => {}, finishGenerationRequest: () => {}, message: { error: (error) => errors.push(error), warning: (error) => errors.push(error) },
        startGenerationRequest: () => { started.push(true); return new AbortController(); },
        hasResumableVideoTask: () => false, findRetrySourceNode: () => nodes[0], effectiveConfig: {}, buildGenerationConfig: () => ({ model: "model", reasoningEffort: "auto" }), isAiConfigReady: () => true,
        hydrateNodeGenerationContext: async () => ({ prompt: "question", referenceImages: [] }), buildNodeGenerationContext: () => ({}), isVideoTaskFailed: () => false,
        connections: [{ fromNodeId: "source", toNodeId: "node" }], connectionsRef: { current: [{ fromNodeId: "source", toNodeId: "node" }] }, disposed: false, missingTextRequestsRef: { current: new Map() },
    };
    const declarations = ["requestImageQuestion", "waitForTextRequest"].map((name) => api.statements.find((part) => ts.isFunctionDeclaration(part) && part.name?.text === name).getText(api));
    context.requestImageQuestion = compile(declarations.join("\n"), {
        ...context, crypto: { randomUUID: () => `request-${++sequence}` }, textMessageContent: (content) => content, apiText: (key) => key,
        createTextConversation: async () => ({ id: `conversation-${++conversation}` }),
        resolvePlatformModelId: async () => { if (failBeforeSubmit) throw new Error("model unavailable"); return "model"; },
        createTextRequest: async (input) => { requests.push(input); return request ? request(input, requests.length) : { message: { content: `answer-${input.requestId}` } }; },
    }).requestImageQuestion;
    const batch = findNode(project, (part) => ts.isVariableStatement(part) && part.declarationList.declarations.some((item) => item.name.getText(project) === "results" && item.initializer?.getText(project).includes("textIds.map")));
    assert.ok(batch);
    const batchCode = batch.parent.statements.slice(batch.parent.statements.indexOf(batch)).map((part) => part.getText(project)).join("\n");
    const retry = findNode(project, (part) => ts.isVariableDeclaration(part) && part.name.getText(project) === "handleRetryNode").initializer.arguments[0];
    const recovery = findNode(project, (part) => ts.isCallExpression(part) && ts.isPropertyAccessExpression(part.expression) && part.expression.name.text === "then" && part.expression.expression.getText(project) === "getTextRequest(requestId)").arguments[0];
    return {
        user, context, requests, errors, started,
        get root() { return nodes.find((item) => item.id === "node"); },
        get parent() { return nodes[0]; },
        setRoot: (root) => context.setNodes((items) => items.map((item) => item.id === root.id ? root : item)),
        generate: () => compile(`export async function generate() { ${batchCode} }`, context).generate(),
        retry: (root) => compile(`export const retry = ${retry.getText(project)};`, context).retry(root),
        recover: (requestId, status, content = "") => compile(`export const recover = ${recovery.getText(project)};`, { ...context, nodeId: "node", requestId }).recover({ request: { status, errorCode: status === "failed" ? "channel_error" : null }, message: status === "succeeded" ? { content } : null }),
    };
}

test("lost text POST responses retain every submitted slot for recovery after reload", async () => {
    const setup = textGeneration({ request: async () => { throw new TypeError("connection lost"); } });
    await setup.generate();
    assert.equal(setup.requests.length, 2);
    assert.equal(setup.root.metadata.status, "loading");
    assert.equal(setup.parent.metadata.status, "loading");
    assert.deepEqual(Array.from(setup.root.metadata.texts, (text) => [text.status, text.textRequestId, text.conversationId]), [["loading", "request-1", "conversation-1"], ["loading", "request-2", "conversation-2"]]);
    setup.setRoot(resetInterruptedGeneration([JSON.parse(JSON.stringify(setup.root))])[0]);
    setup.recover("request-1", "succeeded", "first answer");
    setup.recover("request-2", "succeeded", "second answer");
    assert.deepEqual(Array.from(setup.root.metadata.texts, (text) => text.content), ["first answer", "second answer"]);
    assert.equal(setup.root.metadata.status, "success");
    assert.equal(setup.parent.metadata.status, "success");
});

test("canvas sends only reasoning levels supported by the selected model", async () => {
    for (const [reasoningEfforts, expected] of [[['high', 'ultra'], 'ultra'], [['high'], undefined], [[], undefined]]) {
        const setup = textGeneration({ reasoningEffort: "ultra", reasoningEfforts });
        await setup.generate();
        assert.equal(setup.requests.length, 2);
        assert.ok(setup.requests.every((request) => request.parameters.reasoningEffort === expected));
    }
});

test("a lost multi-text response keeps successful siblings and later records authoritative failure", async () => {
    const setup = textGeneration({ request: async (_input, index) => { if (index === 2) throw new TypeError("connection lost"); return { message: { content: "first answer" } }; } });
    await setup.generate();
    assert.deepEqual(Array.from(setup.root.metadata.texts, (text) => text.status), ["success", "loading"]);
    assert.equal(setup.root.metadata.status, "loading");
    setup.recover("request-2", "failed");
    assert.deepEqual(Array.from(setup.root.metadata.texts, (text) => text.status), ["success", "error"]);
    assert.equal(setup.root.metadata.texts[1].textRequestId, "request-2");
    assert.equal(setup.root.metadata.content, "first answer");
    assert.equal(setup.root.metadata.status, "success");
});

test("text failures before request preparation stay failed instead of polling nonexistent work", async () => {
    const setup = textGeneration({ failBeforeSubmit: true });
    await setup.generate();
    assert.equal(setup.requests.length, 0);
    assert.equal(setup.root.metadata.texts.length, 2);
    assert.ok(setup.root.metadata.texts.every((text) => text.status === "error" && !text.textRequestId));
    assert.equal(setup.root.metadata.status, "error");
    assert.equal(setup.parent.metadata.status, "error");
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
        assert.equal(setup.root.metadata.content, "authoritative answer");
        assert.equal(setup.root.metadata.texts[0].content, "authoritative answer");
        assert.equal(setup.root.metadata.status, "success");
    });
}

for (const batch of [false, true]) {
    test(`retry with ${batch ? "multiple text slots" : "a single text node"} recovers a lost response`, async () => {
        const setup = textGeneration({ request: async () => { throw new TypeError("connection lost"); } });
        const failed = { ...node(), metadata: batch ? { ...node().metadata, prompt: "question", status: "error", texts: node().metadata.texts.map((text) => ({ ...text, status: "error" })) } : { prompt: "question", status: "error" } };
        setup.setRoot(failed);
        await setup.retry(failed);
        const requestId = setup.requests[0].requestId;
        assert.equal(setup.root.metadata.status, "loading");
        assert.equal(setup.root.metadata.textRequestId, requestId);
        assert.equal(helpers.textGenerationRequests(setup.root).find((text) => text.textRequestId === requestId).status, "loading");
        setup.recover(requestId, batch ? "failed" : "succeeded", "retried answer");
        assert.equal(setup.root.metadata.status, batch ? "error" : "success");
        assert.equal(helpers.textGenerationRequests(setup.root).find((text) => text.textRequestId === requestId).status, batch ? "error" : "success");
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
    assert.equal(setup.requests.length, 0);
    assert.equal(setup.started.length, 0);
    assert.equal(setup.errors.length, 0);
});

test("reload only interrupts text slots without a prepared server request", () => {
    const pending = node();
    delete pending.metadata.texts[0].textRequestId;
    const [restored] = resetInterruptedGeneration([pending]);
    assert.equal(restored.metadata.status, "loading");
    assert.equal(restored.metadata.texts[0].status, "error");
    assert.equal(restored.metadata.texts[1].status, "loading");
});

test("reload during retry preparation does not treat old failed requests as pending", () => {
    const root = node();
    root.metadata.texts = root.metadata.texts.map((text) => ({ ...text, status: "error" }));
    const parent = { id: "source", type: "config", metadata: { status: "loading" } };
    const [restoredParent, restored] = resetInterruptedGeneration([parent, root], [{ fromNodeId: "source", toNodeId: "node" }]);
    assert.equal(restoredParent.metadata.status, "error");
    assert.equal(restored.metadata.status, "error");
    assert.equal(restored.metadata.texts[0].textRequestId, "request-a");
    assert.ok(restored.metadata.texts.every((text) => text.status === "error"));
});

test("history changes wait for pending saves and stop on save failure or session replacement", async () => {
    const source = ts.createSourceFile("history.tsx", read("components/canvas/canvas-history-modal.tsx"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const declaration = source.statements.find((part) => ts.isFunctionDeclaration(part) && part.name?.text === "flushBeforeHistoryChange");
    const user = { sessionVersion: 1 };
    const store = { saveError: null, flushProject: async () => {} };
    const { flushBeforeHistoryChange } = compile(`${declaration.getText(source)}\nexport { flushBeforeHistoryChange };`, {
        useUserStore: { getState: () => user }, useCanvasStore: { getState: () => store },
        assertCurrentSession: (version) => { if (version !== user.sessionVersion) throw new Error("changed session"); },
    });
    let release, finished = false;
    store.flushProject = () => new Promise((resolve) => { release = resolve; });
    const pending = flushBeforeHistoryChange("project").then(() => { finished = true; });
    await Promise.resolve();
    assert.equal(finished, false);
    release();
    await pending;
    store.flushProject = async () => { store.saveError = { projectId: "project", message: "save failed" }; };
    await assert.rejects(flushBeforeHistoryChange("project"), /save failed/);
    store.flushProject = async () => { user.sessionVersion++; };
    await assert.rejects(flushBeforeHistoryChange("project"), /changed session/);
});

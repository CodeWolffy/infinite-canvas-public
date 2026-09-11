const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");
const { runInNewContext } = require("node:vm");
const { test } = require("node:test");
const ts = require("typescript");

const source = ts.createSourceFile("local-agent-panel.tsx", readFileSync(resolve(__dirname, "../src/components/agent/local-agent-panel.tsx"), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function handler(name, context) {
    let declaration;
    const visit = (part) => {
        if (ts.isVariableDeclaration(part) && part.name.getText(source) === name) declaration = part;
        ts.forEachChild(part, visit);
    };
    visit(source);
    assert.ok(declaration, name);
    const module = { exports: {} };
    const code = ts.transpileModule(`export const invoke = ${declaration.initializer.getText(source)};`, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
    runInNewContext(code, { module, exports: module.exports, DOMException, ...context });
    return module.exports.invoke;
}
function deferred() {
    let resolve;
    const promise = new Promise((done) => { resolve = done; });
    return { promise, resolve };
}
const image = { id: "canvas:node", name: "private.png", type: "image/png", size: 12, width: 10, height: 10, url: "blob:private", dataUrl: "data:image/png;base64,cHJpdmF0ZQ==" };
function panel(canvasReferences = [], attachments = []) {
    const user = { id: "same-user", sessionVersion: 1 };
    const state = { connected: true, sending: false, waiting: false, loadingThreads: false, prompt: "private prompt", attachments, canvasReferences, canvasContext: { snapshot: { nodes: [{ id: "node" }] } }, messages: [], activeThreadId: "thread", conversation: { status: "ready", conversationId: "conversation", revision: 1 } };
    const requests = [], events = [], urls = [];
    const context = {
        sessionVersion: 1, useUserStore: { getState: () => user }, useAgentStore: { getState: () => state },
        assertCurrentSession: (version) => { if (version !== user.sessionVersion) throw new DOMException("changed session", "AbortError"); },
        useAgentSkillStore: { getState: () => ({ selectedSkill: null }) },
        prompt: state.prompt, attachments, models: [], model: "local-model", reasoningEffort: "", permissionMode: "request", endpoint: "http://127.0.0.1:17371", token: "local-token",
        promptWithCanvasReferences: (text) => text, promptWithAttachments: (text) => text, attachmentPayloadBytes: () => 12,
        MAX_ATTACHMENTS: 10, MAX_ATTACHMENT_PAYLOAD_BYTES: 1000, createId: () => "message", rt: (key) => key, compactText: (text) => text,
        setAgentState: (patch) => { if (user.sessionVersion === 1) Object.assign(state, patch); },
        addMessage: (message) => { if (user.sessionVersion === 1) state.messages.push(message); },
        addEventLog: (...event) => { if (user.sessionVersion === 1) events.push(event); },
        message: { warning: () => {} },
        loadThreadsSequenceRef: { current: 0 }, threadMessagesRef: { current: new Map() }, attachmentUrlsRef: { current: new Set() }, clientIdRef: { current: "tab:same-user" },
        resolveCanvasReferenceImages: async () => [image], createMessageAttachmentMetadata: async (file) => ({ id: file.id, url: file.dataUrl }),
        fetchAgentJson: async (_endpoint, _token, path, request) => { requests.push({ path, body: JSON.parse(request.body) }); return { threadId: "thread" }; },
        URL: { createObjectURL: () => { urls.push("blob:new"); return "blob:new"; }, revokeObjectURL: () => {} },
        readDataUrl: async () => image.dataUrl, readImageMeta: async () => ({ width: 10, height: 10 }),
        clearSkillSelection: () => {}, AgentApiError: class extends Error {},
    };
    const replaceSession = () => {
        user.sessionVersion++;
        Object.assign(state, { prompt: "replacement draft", attachments: [], canvasReferences: [], messages: [], activeThreadId: "replacement-thread", conversation: { status: "ready", conversationId: "replacement-conversation", revision: 2 } });
    };
    return { context, state, requests, events, urls, replaceSession };
}

for (const stage of ["canvas image read", "canvas image preview", "attachment preview"]) {
    test(`Agent send discards ${stage} from a previous login of the same user`, async () => {
        const canvas = stage !== "attachment preview";
        const setup = panel(canvas ? [{ nodeId: "node", kind: "image", label: "image" }] : [], canvas ? [] : [{ ...image, id: "attachment" }]);
        const entered = deferred(), finish = deferred();
        const method = stage === "canvas image read" ? "resolveCanvasReferenceImages" : "createMessageAttachmentMetadata";
        setup.context[method] = () => { entered.resolve(); return finish.promise; };
        const pending = handler("sendPrompt", setup.context)();
        await entered.promise;
        setup.replaceSession();
        finish.resolve(stage === "canvas image read" ? [image] : { url: image.dataUrl });
        await pending;
        assert.equal(setup.requests.length, 0);
        assert.equal(setup.state.prompt, "replacement draft");
        assert.equal(setup.state.messages.length, 0);
    });
}

test("Agent sends current-session attachments and canvas references with their original ownership", async () => {
    const setup = panel([{ nodeId: "node", kind: "image", label: "image" }], [{ ...image, id: "attachment", dataUrl: "data:image/png;base64,bG9jYWw=" }]);
    await handler("sendPrompt", setup.context)();
    assert.equal(setup.requests.length, 1);
    const request = setup.requests[0];
    assert.equal(request.path, "/agent/codex/turn");
    assert.equal(request.body.clientId, "tab:same-user");
    assert.equal(request.body.threadId, "thread");
    assert.equal(request.body.conversationId, "conversation");
    assert.deepEqual(request.body.attachments.map((item) => item.id), ["attachment", "canvas:node"]);
    assert.equal(request.body.messageMetadata.canvasReferences[0].previewUrl, image.dataUrl);
});

for (const stage of ["readDataUrl", "readImageMeta"]) {
    test(`Agent attachment ${stage} cannot populate a replacement session`, async () => {
        const setup = panel();
        const entered = deferred(), finish = deferred();
        setup.context[stage] = () => { entered.resolve(); return finish.promise; };
        const pending = handler("addAttachments", setup.context)([image]);
        await entered.promise;
        setup.replaceSession();
        finish.resolve(stage === "readDataUrl" ? image.dataUrl : { width: 10, height: 10 });
        await pending;
        assert.equal(setup.state.attachments.length, 0);
        assert.equal(setup.urls.length, 0);
        assert.equal(setup.state.messages.length, 0);
    });
}

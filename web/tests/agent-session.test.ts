import ts from "typescript";
import { expect, test } from "vitest";
import { findNode, loadModule, sourceFile } from "./support/source-loader";

// `sendPrompt`/`addAttachments` are closures inside the React panel component, so they cannot be
// imported directly; they are extracted from the source and executed with injected dependencies.
const source = sourceFile("components/agent/local-agent-panel.tsx", ts.ScriptKind.TSX);

function handler(name: string, context: Record<string, any>) {
    const declaration = findNode(source, (node) => ts.isVariableDeclaration(node) && node.name.getText(source) === name) as ts.VariableDeclaration | undefined;
    expect(declaration).toBeTruthy();
    const initializer = declaration!.initializer!.getText(source);
    return loadModule(`export const invoke = ${initializer};`, { DOMException, ...context }).invoke;
}
function deferred() {
    let resolve: (value?: unknown) => void;
    const promise = new Promise((done) => { resolve = done; });
    return { promise, resolve: resolve! };
}
const image = { id: "canvas:node", name: "private.png", type: "image/png", size: 12, width: 10, height: 10, url: "blob:private", dataUrl: "data:image/png;base64,cHJpdmF0ZQ==" };
function panel(canvasReferences: any[] = [], attachments: any[] = []) {
    const user = { id: "same-user", sessionVersion: 1 };
    const state: any = { connected: true, sending: false, waiting: false, loadingThreads: false, prompt: "private prompt", attachments, canvasReferences, canvasContext: { snapshot: { nodes: [{ id: "node" }] } }, messages: [], activeThreadId: "thread", conversation: { status: "ready", conversationId: "conversation", revision: 1 } };
    const requests: any[] = [], events: any[] = [], urls: string[] = [];
    const context: Record<string, any> = {
        sessionVersion: 1, useUserStore: { getState: () => user }, useAgentStore: { getState: () => state },
        assertCurrentSession: (version: number) => { if (version !== user.sessionVersion) throw new DOMException("changed session", "AbortError"); },
        useAgentSkillStore: { getState: () => ({ selectedSkill: null }) },
        prompt: state.prompt, attachments, models: [], model: "local-model", reasoningEffort: "", permissionMode: "request", endpoint: "http://127.0.0.1:17371", token: "local-token",
        promptWithCanvasReferences: (text: string) => text, promptWithAttachments: (text: string) => text, attachmentPayloadBytes: () => 12,
        MAX_ATTACHMENTS: 10, MAX_ATTACHMENT_PAYLOAD_BYTES: 1000, createId: () => "message", rt: (key: string) => key, compactText: (text: string) => text,
        setAgentState: (patch: any) => { if (user.sessionVersion === 1) Object.assign(state, patch); },
        addMessage: (message: any) => { if (user.sessionVersion === 1) state.messages.push(message); },
        addEventLog: (...event: any[]) => { if (user.sessionVersion === 1) events.push(event); },
        message: { warning: () => {} },
        loadThreadsSequenceRef: { current: 0 }, threadMessagesRef: { current: new Map() }, attachmentUrlsRef: { current: new Set() }, clientIdRef: { current: "tab:same-user" },
        resolveCanvasReferenceImages: async () => [image], createMessageAttachmentMetadata: async (file: any) => ({ id: file.id, url: file.dataUrl }),
        fetchAgentJson: async (_endpoint: string, _token: string, path: string, request: any) => { requests.push({ path, body: JSON.parse(request.body) }); return { threadId: "thread" }; },
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
        expect(setup.requests.length).toBe(0);
        expect(setup.state.prompt).toBe("replacement draft");
        expect(setup.state.messages.length).toBe(0);
    });
}

test("Agent sends current-session attachments and canvas references with their original ownership", async () => {
    const setup = panel([{ nodeId: "node", kind: "image", label: "image" }], [{ ...image, id: "attachment", dataUrl: "data:image/png;base64,bG9jYWw=" }]);
    await handler("sendPrompt", setup.context)();
    expect(setup.requests.length).toBe(1);
    const request = setup.requests[0];
    expect(request.path).toBe("/agent/codex/turn");
    expect(request.body.clientId).toBe("tab:same-user");
    expect(request.body.threadId).toBe("thread");
    expect(request.body.conversationId).toBe("conversation");
    expect(request.body.attachments.map((item: any) => item.id)).toEqual(["attachment", "canvas:node"]);
    expect(request.body.messageMetadata.canvasReferences[0].previewUrl).toBe(image.dataUrl);
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
        expect(setup.state.attachments.length).toBe(0);
        expect(setup.urls.length).toBe(0);
        expect(setup.state.messages.length).toBe(0);
    });
}

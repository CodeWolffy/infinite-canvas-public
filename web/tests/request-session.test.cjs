const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");
const { runInNewContext } = require("node:vm");
const { test } = require("node:test");
const ts = require("typescript");
const read = (path) => readFileSync(resolve(__dirname, "../src", path), "utf8");

function load(source, context = {}, imports = {}) {
    const module = { exports: {} };
    const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
    runInNewContext(code, { module, exports: module.exports, require: (id) => { assert.ok(imports[id], id); return imports[id]; }, DOMException, Blob, Headers, Event, File, FormData, ...context });
    return module.exports;
}
function session() {
    const state = { sessionVersion: 1 };
    return { state, useUserStore: { getState: () => state, subscribe: () => () => {} }, assertCurrentSession: (version) => { if (version !== state.sessionVersion) throw new DOMException("changed session", "AbortError"); } };
}

function callback(path, name) {
    const source = ts.createSourceFile(path, read(path), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const find = (node) => {
        if (ts.isFunctionDeclaration(node) && node.name?.text === name) return node;
        if (ts.isVariableDeclaration(node) && node.name.getText(source) === name) {
            return ts.isCallExpression(node.initializer) ? node.initializer.arguments[0] : node.initializer;
        }
        return ts.forEachChild(node, find);
    };
    const node = find(source);
    assert.ok(node, name);
    return `exports.run = ${node.getText(source)}`;
}

test("a late unauthorized response cannot log the next account out", async () => {
    const auth = session();
    let finish, events = 0;
    const { apiRequest } = load(read("services/api/request.ts"), { fetch: () => new Promise((resolve) => { finish = resolve; }), window: { dispatchEvent: () => { events++; } } }, { "@/stores/use-user-store": auth });
    const pending = apiRequest("/api/canvas-projects");
    auth.state.sessionVersion++;
    finish(new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 }));
    await assert.rejects(pending, { name: "AbortError" });
    assert.equal(events, 0);
});

test("image metadata reading cannot upload an old account's bytes after switching", async () => {
    const auth = session();
    let finish, uploads = 0, revoked = 0;
    const { uploadImage } = load(read("services/image-storage.ts"), {
        URL: { createObjectURL: () => "blob:test", revokeObjectURL: () => { revoked++; } },
    }, {
        "@/stores/use-user-store": auth,
        "@/i18n": { __esModule: true, default: { t: (key) => key } },
        "@/lib/image-utils": { readImageMeta: () => new Promise((resolve) => { finish = resolve; }) },
        "@/services/api/media": { uploadMedia: async () => { uploads++; return { id: "new-account-image", url: "/api/media/new-account-image", width: 1, height: 1, byteSize: 13, mimeType: "image/png" }; } },
        "@/stores/use-config-store": { withLocalProxy: (url) => url },
    });
    const pending = uploadImage(new Blob(["private bytes"]));
    auth.state.sessionVersion++;
    finish({ width: 1, height: 1, mimeType: "image/png" });
    await assert.rejects(pending, { name: "AbortError" });
    assert.equal(uploads, 0);
    assert.equal(revoked, 1);
});

test("text attachment preparation cannot submit a request in a replacement session", async () => {
    const auth = session();
    let finish, requests = 0;
    const source = ts.createSourceFile("image.ts", read("services/api/image.ts"), ts.ScriptTarget.Latest, true);
    const declaration = source.statements.find((part) => ts.isFunctionDeclaration(part) && part.name?.text === "requestImageQuestion");
    const { requestImageQuestion } = load(declaration.getText(source), {
        ...auth, textMessageContent: () => "question",
        ensureReferenceMedia: () => new Promise((resolve) => { finish = resolve; }),
        resolvePlatformModelId: async () => "model",
        crypto: { randomUUID: () => "new-account-request" },
        createTextRequest: async () => { requests++; return { message: { content: "saved" } }; },
    });
    const pending = requestImageQuestion({ systemPrompt: "", model: "model", reasoningEffort: "auto" }, [{ role: "user", content: [{ type: "image_url", image_url: { url: "data:image/png;base64,dGVzdA==" } }] }], () => {}, { conversationId: "conversation" });
    auth.state.sessionVersion++;
    finish("media");
    await assert.rejects(pending, { name: "AbortError" });
    assert.equal(requests, 0);
});

test("a stale generation media upload cannot clear a replacement login", async () => {
    const auth = session();
    let finish, events = 0;
    const context = { fetch: () => new Promise((resolve) => { finish = resolve; }), window: { dispatchEvent: () => { events++; } } };
    const request = load(read("services/api/request.ts"), context, { "@/stores/use-user-store": auth });
    const media = load(read("services/api/media.ts"), context, { "@/stores/use-user-store": auth, "@/services/api/request": request });
    const generation = load(read("services/api/generation.ts"), context, { "@/services/api/request": request, "@/services/api/media": media, "@/stores/use-user-store": auth });
    const pending = generation.uploadGenerationMedia(new Blob(["private bytes"]));
    auth.state.sessionVersion++;
    finish(new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 }));
    await assert.rejects(pending, { name: "AbortError" });
    assert.equal(events, 0);
});

test("reference blob preparation cannot upload using a replacement session", async () => {
    const auth = session();
    let finish, uploads = 0;
    const { run } = load(callback("services/api/image.ts", "ensureReferenceMedia"), {
        ...auth, mediaIdFromUrl: () => [],
        fetch: async () => ({ blob: () => new Promise((resolve) => { finish = resolve; }) }),
        uploadGenerationMedia: async () => { uploads++; return { id: "new-account-media" }; },
    });
    const pending = run({ dataUrl: "blob:private" });
    await new Promise(setImmediate);
    auth.state.sessionVersion++;
    finish(new Blob(["private bytes"]));
    await assert.rejects(pending, { name: "AbortError" });
    assert.equal(uploads, 0);
});

test("image model lookup cannot submit an old prompt after session replacement", async () => {
    const auth = session();
    let finish, submissions = 0;
    const { run } = load(callback("services/api/image.ts", "requestPlatformImages"), {
        ...auth,
        ensureReferenceMedia: async () => "media",
        resolvePlatformModelId: () => new Promise((resolve) => { finish = resolve; }),
        createGenerationBatch: async () => { submissions++; return { batch: { id: "batch" }, tasks: [] }; },
        platformImageParameters: () => ({}),
        getGenerationBatch: async () => ({ tasks: [{ id: "task", status: "succeeded", image: { url: "/image" } }] }),
        BATCH_POLL_BASE_MS: 700,
    });
    const pending = run({ model: "model" }, "private prompt", [], 1);
    await new Promise(setImmediate);
    auth.state.sessionVersion++;
    finish("model");
    await assert.rejects(pending, { name: "AbortError" });
    assert.equal(submissions, 0);
});

for (const cancelAfterSubmission of [false, true]) {
    test(`image batches preserve their server association when foreground cancellation is ${cancelAfterSubmission}`, async () => {
        const auth = session();
        const controller = new AbortController();
        let finish, associated = "", polls = 0;
        const { run } = load(callback("services/api/image.ts", "requestPlatformImages"), {
            ...auth,
            ensureReferenceMedia: async () => "media",
            resolvePlatformModelId: async () => "model",
            createGenerationBatch: () => new Promise((resolve) => { finish = resolve; }),
            platformImageParameters: () => ({}),
            getGenerationBatch: async () => { polls++; return { tasks: [{ id: "task", status: "succeeded", image: { url: "/image" } }] }; },
            BATCH_POLL_BASE_MS: 700,
        });
        const pending = run({ model: "model" }, "prompt", [], 1, {
            signal: controller.signal, onBatchCreated: (detail) => { associated = detail.batch.id; },
        });
        await new Promise(setImmediate);
        if (cancelAfterSubmission) controller.abort();
        finish({ batch: { id: "submitted-batch" }, tasks: [] });
        if (cancelAfterSubmission) await assert.rejects(pending, { name: "AbortError" });
        else assert.equal((await pending)[0].dataUrl, "/image");
        assert.equal(associated, "submitted-batch");
        assert.equal(polls, cancelAfterSubmission ? 0 : 1);
    });
}

test("clipboard preparation cannot upload into a replacement account", async () => {
    const auth = session();
    let finish, uploads = 0;
    const { run } = load(callback("pages/image/index.tsx", "addReferencesFromClipboard"), {
        ...auth,
        navigator: { clipboard: { read: async () => [{ types: ["image/png"], getType: () => new Promise((resolve) => { finish = resolve; }) }] } },
        SUPPORTED_IMAGE_TYPES: new Set(["image/png"]),
        uploadGenerationMedia: async () => { uploads++; return { originalName: "clipboard", mimeType: "image/png", url: "/image", id: "media" }; },
        nanoid: () => "image", setReferences() {}, message: { error() {}, success() {} }, t: (key) => key,
    });
    const pending = run();
    await new Promise(setImmediate);
    auth.state.sessionVersion++;
    finish(new Blob(["private bytes"]));
    await pending;
    assert.equal(uploads, 0);
});

test("canvas clipboard reads cannot create images after session replacement", async () => {
    const auth = session();
    let finish, uploads = 0;
    const { run } = load(callback("pages/canvas/project.tsx", "pasteSystemClipboard"), {
        ...auth,
        navigator: { clipboard: { read: async () => [{ types: ["image/png"], getType: () => new Promise((resolve) => { finish = resolve; }) }] } },
        createImageFileNode: async () => { uploads++; }, getCanvasCenter: () => ({ x: 0, y: 0 }),
        message: { success() {} }, t: (key) => key,
    });
    const pending = run();
    await new Promise(setImmediate);
    auth.state.sessionVersion++;
    finish(new Blob(["private bytes"]));
    await pending;
    assert.equal(uploads, 0);
});

test("canvas import does not write a parsed archive into a replacement account", async () => {
    const auth = session();
    let finish, imports = 0;
    const { run } = load(callback("pages/canvas/index.tsx", "importCanvas"), {
        ...auth,
        readZip: async () => new Map([["projects.json", { text: () => new Promise((resolve) => { finish = resolve; }) }]]),
        importProject: async () => { imports++; },
        message: { error() {}, success() {} }, t: (key) => key, inputRef: { current: null },
    });
    const pending = run(new File(["archive"], "canvas.zip"));
    await new Promise(setImmediate);
    auth.state.sessionVersion++;
    finish(JSON.stringify({ projects: [{ files: [], project: { title: "Private project", nodes: [] } }] }));
    await pending;
    assert.equal(imports, 0);
});

for (const [name, processor] of [["cropImageNode", "cropDataUrl"], ["splitImageNode", "splitDataUrl"], ["upscaleImageNode", "upscaleDataUrl"]]) {
    test(`${name} cannot upload a processed image after session replacement`, async () => {
        const auth = session();
        let finish, uploads = 0;
        const { run } = load(callback("pages/canvas/project.tsx", name), {
            ...auth,
            [processor]: () => new Promise((resolve) => { finish = resolve; }),
            uploadImage: async () => { uploads++; return { width: 1, height: 1 }; },
            fitNodeSize: () => ({ width: 1, height: 1 }), nanoid: () => "image", imageMetadata: () => ({}),
            CanvasNodeType: { Image: "image" },
            setNodes() {}, setConnections() {}, setSelectedNodeIds() {}, setSelectedConnectionId() {},
            setDialogNodeId() {}, setCropNodeId() {}, setSplitNodeId() {}, setUpscaleNodeId() {},
            t: (key) => key, message: { success() {} },
        });
        const pending = run({ metadata: { content: "blob:private" }, width: 10, height: 10, position: { x: 0, y: 0 } }, { rows: 1, columns: 1 });
        auth.state.sessionVersion++;
        finish(processor === "splitDataUrl" ? [{ dataUrl: "data:image/png;base64,dGVzdA==", row: 0, column: 0 }] : "data:image/png;base64,dGVzdA==");
        await assert.rejects(pending, { name: "AbortError" });
        assert.equal(uploads, 0);
    });
}

import ts from "typescript";
import { expect, test } from "vitest";
import { findNode, loadModule, readSource, sourceFile } from "./support/source-loader";

const globals = { DOMException, Blob, Headers, Event, File, FormData };
function load(source: string, context: Record<string, any> = {}, imports: Record<string, any> = {}) {
    return loadModule(source, { ...globals, ...context }, imports);
}
function session() {
    const state = { sessionVersion: 1 };
    return { state, useUserStore: { getState: () => state, subscribe: () => () => {} }, assertCurrentSession: (version: number) => { if (version !== state.sessionVersion) throw new DOMException("changed session", "AbortError"); } };
}

// Callbacks are closures inside page/store modules, so they are extracted from the source.
function callback(path: string, name: string) {
    const source = sourceFile(path, ts.ScriptKind.TSX);
    const node = findNode(source, (part) => (ts.isFunctionDeclaration(part) && part.name?.text === name) || (ts.isVariableDeclaration(part) && part.name.getText(source) === name)) as ts.Node | undefined;
    expect(node).toBeTruthy();
    let target: ts.Node = node!;
    if (ts.isVariableDeclaration(target)) target = ts.isCallExpression(target.initializer!) ? target.initializer!.arguments[0] : target.initializer!;
    return `exports.run = ${target.getText(source)}`;
}

test("a late unauthorized response cannot log the next account out", async () => {
    const auth = session();
    let finish!: (value: any) => void; let events = 0;
    const { apiRequest } = load(readSource("services/api/request.ts"), { fetch: () => new Promise((resolve) => { finish = resolve; }), window: { dispatchEvent: () => { events++; } } }, { "@/stores/use-user-store": auth });
    const pending = apiRequest("/api/canvas-projects");
    auth.state.sessionVersion++;
    finish(new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 }));
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(events).toBe(0);
});

test("image metadata reading cannot upload an old account's bytes after switching", async () => {
    const auth = session();
    let finish!: (value: any) => void; let uploads = 0, revoked = 0;
    const { uploadImage } = load(readSource("services/image-storage.ts"), {
        URL: { createObjectURL: () => "blob:test", revokeObjectURL: () => { revoked++; } },
    }, {
        "@/stores/use-user-store": auth,
        "@/i18n": { __esModule: true, default: { t: (key: string) => key } },
        "@/lib/image-utils": { readImageMeta: () => new Promise((resolve) => { finish = resolve; }) },
        "@/lib/image-thumbnail": { createImageThumbnail: async () => undefined },
        localforage: { default: { createInstance: () => ({ getItem: async () => null, setItem: async () => undefined, removeItem: async () => undefined, iterate: async () => undefined }) }, createInstance: () => ({ getItem: async () => null, setItem: async () => undefined, removeItem: async () => undefined, iterate: async () => undefined }) },
        "@/services/api/media": { uploadMedia: async () => { uploads++; return { id: "new-account-image", url: "/api/media/new-account-image", width: 1, height: 1, byteSize: 13, mimeType: "image/png" }; } },
        "@/stores/use-config-store": { withLocalProxy: (url: string) => url },
    });
    const pending = uploadImage(new Blob(["private bytes"]));
    auth.state.sessionVersion++;
    finish({ width: 1, height: 1, mimeType: "image/png" });
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(uploads).toBe(0);
    expect(revoked).toBe(1);
});

test("text attachment preparation cannot submit a request in a replacement session", async () => {
    const auth = session();
    let finish!: (value: any) => void; let requests = 0;
    const source = sourceFile("services/api/image.ts");
    const declaration = source.statements.find((part) => ts.isFunctionDeclaration(part) && part.name?.text === "requestImageQuestion")!;
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
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(requests).toBe(0);
});

test("a stale generation media upload cannot clear a replacement login", async () => {
    const auth = session();
    let finish!: (value: any) => void; let events = 0;
    const context = { fetch: () => new Promise((resolve) => { finish = resolve; }), window: { dispatchEvent: () => { events++; } } };
    const request = load(readSource("services/api/request.ts"), context, { "@/stores/use-user-store": auth });
    const media = load(readSource("services/api/media.ts"), context, { "@/stores/use-user-store": auth, "@/services/api/request": request });
    const generation = load(readSource("services/api/generation.ts"), context, { "@/services/api/request": request, "@/services/api/media": media, "@/stores/use-user-store": auth });
    const pending = generation.uploadGenerationMedia(new Blob(["private bytes"]));
    auth.state.sessionVersion++;
    finish(new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 }));
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(events).toBe(0);
});

test("reference blob preparation cannot upload using a replacement session", async () => {
    const auth = session();
    let finish!: (value: any) => void; let uploads = 0;
    const { run } = load(callback("services/api/image.ts", "ensureReferenceMedia"), {
        ...auth, mediaIdFromUrl: () => [],
        fetch: async () => ({ blob: () => new Promise((resolve) => { finish = resolve; }) }),
        uploadGenerationMedia: async () => { uploads++; return { id: "new-account-media" }; },
    });
    const pending = run({ dataUrl: "blob:private" });
    await new Promise(setImmediate);
    auth.state.sessionVersion++;
    finish(new Blob(["private bytes"]));
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(uploads).toBe(0);
});

test("image model lookup cannot submit an old prompt after session replacement", async () => {
    const auth = session();
    let finish!: (value: any) => void; let submissions = 0;
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
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(submissions).toBe(0);
});

for (const cancelAfterSubmission of [false, true]) {
    test(`image batches preserve their server association when foreground cancellation is ${cancelAfterSubmission}`, async () => {
        const auth = session();
        const controller = new AbortController();
        let finish!: (value: any) => void; let associated = "", polls = 0;
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
            signal: controller.signal, onBatchCreated: (detail: any) => { associated = detail.batch.id; },
        });
        await new Promise(setImmediate);
        if (cancelAfterSubmission) controller.abort();
        finish({ batch: { id: "submitted-batch" }, tasks: [] });
        if (cancelAfterSubmission) await expect(pending).rejects.toMatchObject({ name: "AbortError" });
        else expect((await pending)[0].dataUrl).toBe("/image");
        expect(associated).toBe("submitted-batch");
        expect(polls).toBe(cancelAfterSubmission ? 0 : 1);
    });
}

test("clipboard preparation cannot upload into a replacement account", async () => {
    const auth = session();
    let finish!: (value: any) => void; let uploads = 0;
    const { run } = load(callback("pages/image/index.tsx", "addReferencesFromClipboard"), {
        ...auth,
        navigator: { clipboard: { read: async () => [{ types: ["image/png"], getType: () => new Promise((resolve) => { finish = resolve; }) }] } },
        SUPPORTED_IMAGE_TYPES: new Set(["image/png"]),
        uploadGenerationMedia: async () => { uploads++; return { originalName: "clipboard", mimeType: "image/png", url: "/image", id: "media" }; },
        nanoid: () => "image", setReferences() {}, message: { error() {}, success() {} }, t: (key: string) => key,
    });
    const pending = run();
    await new Promise(setImmediate);
    auth.state.sessionVersion++;
    finish(new Blob(["private bytes"]));
    await pending;
    expect(uploads).toBe(0);
});

test("canvas clipboard reads cannot create images after session replacement", async () => {
    const auth = session();
    let finish!: (value: any) => void; let uploads = 0;
    const { run } = load(callback("pages/canvas/project.tsx", "pasteSystemClipboard"), {
        ...auth,
        navigator: { clipboard: { read: async () => [{ types: ["image/png"], getType: () => new Promise((resolve) => { finish = resolve; }) }] } },
        createImageFileNode: async () => { uploads++; }, getCanvasCenter: () => ({ x: 0, y: 0 }),
        message: { success() {} }, t: (key: string) => key,
    });
    const pending = run();
    await new Promise(setImmediate);
    auth.state.sessionVersion++;
    finish(new Blob(["private bytes"]));
    await pending;
    expect(uploads).toBe(0);
});

test("canvas import does not write a parsed archive into a replacement account", async () => {
    const auth = session();
    let finish!: (value: any) => void; let imports = 0;
    const { run } = load(callback("pages/canvas/index.tsx", "importCanvas"), {
        ...auth,
        readZip: async () => new Map([["projects.json", { text: () => new Promise((resolve) => { finish = resolve; }) }]]),
        importProject: async () => { imports++; },
        message: { error() {}, success() {} }, t: (key: string) => key, inputRef: { current: null },
    });
    const pending = run(new File(["archive"], "canvas.zip"));
    await new Promise(setImmediate);
    auth.state.sessionVersion++;
    finish(JSON.stringify({ projects: [{ files: [], project: { title: "Private project", nodes: [] } }] }));
    await pending;
    expect(imports).toBe(0);
});

for (const [name, processor] of [["cropImageNode", "cropDataUrl"], ["splitImageNode", "splitDataUrl"], ["upscaleImageNode", "upscaleDataUrl"]] as const) {
    test(`${name} cannot upload a processed image after session replacement`, async () => {
        const auth = session();
        let finish!: (value: any) => void; let uploads = 0;
        const { run } = load(callback("pages/canvas/project.tsx", name), {
            ...auth,
            [processor]: () => new Promise((resolve) => { finish = resolve; }),
            uploadImage: async () => { uploads++; return { width: 1, height: 1 }; },
            fitNodeSize: () => ({ width: 1, height: 1 }), nanoid: () => "image", imageMetadata: () => ({}),
            CanvasNodeType: { Image: "image" },
            setNodes() {}, setConnections() {}, setSelectedNodeIds() {}, setSelectedConnectionId() {},
            setDialogNodeId() {}, setCropNodeId() {}, setSplitNodeId() {}, setUpscaleNodeId() {},
            t: (key: string) => key, message: { success() {} },
        });
        const pending = run({ metadata: { content: "blob:private" }, width: 10, height: 10, position: { x: 0, y: 0 } }, { rows: 1, columns: 1 });
        auth.state.sessionVersion++;
        finish(processor === "splitDataUrl" ? [{ dataUrl: "data:image/png;base64,dGVzdA==", row: 0, column: 0 }] : "data:image/png;base64,dGVzdA==");
        await expect(pending).rejects.toMatchObject({ name: "AbortError" });
        expect(uploads).toBe(0);
    });
}

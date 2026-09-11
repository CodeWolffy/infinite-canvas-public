const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");
const { runInNewContext } = require("node:vm");
const { test } = require("node:test");
const ts = require("typescript");

const source = ts.createSourceFile("project.tsx", readFileSync(resolve(__dirname, "../src/pages/canvas/project.tsx"), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const find = (node, predicate) => predicate(node) ? node : ts.forEachChild(node, (child) => find(child, predicate));
const declares = (statement, name) => ts.isVariableStatement(statement) && statement.declarationList.declarations.some((item) => ts.isIdentifier(item.name) && item.name.text === name);
const recovery = find(source, (node) => ts.isArrowFunction(node) && ts.isBlock(node.body) && node.body.statements.some((item) => declares(item, "pollPendingImage")));
const generation = find(source, (node) => ts.isTryStatement(node) && node.tryBlock.statements.some((item) => declares(item, "generatedImages")));
assert.ok(recovery && generation, "Canvas image generation/recovery hooks must be present");
const generationTail = generation.parent.statements.slice(generation.parent.statements.indexOf(generation)).map((statement) => statement.getText(source)).join("\n");

function evaluate(code, context) {
    // Execute the production callback bodies, with HTTP and React's state setter isolated.
    const compiled = ts.transpileModule(`globalThis.run = ${code}`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
    runInNewContext(compiled, context);
    return context.run;
}

const tick = () => new Promise(setImmediate);

for (const terminalStatus of ["succeeded", "failed"]) {
    test(`foreground timeout preserves submitted image slots until server reports ${terminalStatus}`, async () => {
        let nodes = [
            { id: "source", type: "config", metadata: { status: "loading" } },
            { id: "image", type: "image", width: 100, height: 100, metadata: { status: "loading", images: [{ id: "slot", status: "loading", generationBatchId: "batch", generationTaskId: "task" }] } },
        ];
        let interval;
        let task = { id: "task", status: "running" };
        const context = {
            rootId: "image", nodeId: "source", isConfigNode: true, projectId: "project", batchId: "batch",
            referenceImages: [], generationConfig: {}, effectivePrompt: "prompt", count: 1,
            controller: { signal: { aborted: false } }, onBatchCreated() {}, applyTaskUpdate() {},
            requestGeneration: async () => { throw new Error("foreground wait expired"); },
            getGenerationBatch: async () => ({ tasks: [task] }),
            hasSuccess: false, hasFailure: false, firstError: "",
            isGenerationCanceled: () => false,
            message: { error() {} }, t: (key) => key,
            NODE_STATUS_LOADING: "loading", NODE_STATUS_SUCCESS: "success", NODE_STATUS_ERROR: "error",
            CanvasNodeType: { Config: "config", Image: "image" },
            setNodes: (update) => { nodes = update(nodes); context.nodes = nodes; },
            nodes, projectLoaded: true,
            connections: [{ fromNodeId: "source", toNodeId: "image" }],
            generationRequestsRef: { current: new Map([["image", {}]]) },
            restoringGenerationImagesRef: { current: new Set() },
            finishGenerationRequest: (id) => context.generationRequestsRef.current.delete(id),
            fitNodeSize: (width, height) => ({ width, height }),
            window: { setInterval: (callback, delay) => { assert.equal(delay, 1800); interval = callback; return 1; }, clearInterval: () => { interval = null; } },
            Date: { now: () => 11 * 60 * 1000 + 1 },
            GENERATION_RECOVERY_MAX_WAIT_MS: 10 * 60 * 1000,
            generationRecoveryStartedRef: { current: new Map([["image:slot:batch", 1]]) },
        };
        await evaluate(`async () => { ${generationTail} }`, context)();
        assert.equal(nodes[0].metadata.status, "loading");
        assert.equal(nodes[1].metadata.images[0].status, "loading");
        assert.equal(nodes[1].metadata.images[0].generationTaskId, "task");
        assert.equal(context.generationRequestsRef.current.has("image"), false);

        const cleanup = evaluate(recovery.getText(source), context)();
        try {
            await tick();
            assert.equal(nodes[1].metadata.images[0].status, "loading");
            task = { id: "task", status: terminalStatus, errorMessage: "upstream rejected", image: terminalStatus === "succeeded" ? { mediaId: "media", url: "/api/media/media", width: 100, height: 100 } : undefined };
            interval();
            await tick();
            const expected = terminalStatus === "succeeded" ? "success" : "error";
            assert.equal(nodes[0].metadata.status, expected);
            assert.equal(nodes[1].metadata.images[0].status, expected);
            if (terminalStatus === "succeeded") assert.equal(nodes[1].metadata.content, "/api/media/media");
            else assert.equal(nodes[1].metadata.images[0].errorDetails, "upstream rejected");
        } finally {
            cleanup();
        }
    });
}

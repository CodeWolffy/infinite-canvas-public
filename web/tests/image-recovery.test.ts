import ts from "typescript";
import { expect, test } from "vitest";
import { evaluate, findNode, sourceFile } from "./support/source-loader";

// The generation/recovery callbacks live inside the canvas page component, so they are extracted
// from the source and executed with HTTP and React's state setter isolated.
const source = sourceFile("pages/canvas/project.tsx", ts.ScriptKind.TSX);
const declares = (statement: ts.Statement, name: string) =>
    ts.isVariableStatement(statement) && statement.declarationList.declarations.some((item) => ts.isIdentifier(item.name) && item.name.text === name);
// 图片恢复轮询已迁到 use-canvas-generation-recovery，生成尾部仍在画布页面里。
const recoverySource = sourceFile("pages/canvas/hooks/use-canvas-generation-recovery.ts");
const recovery = findNode(recoverySource, (node) => ts.isArrowFunction(node) && ts.isBlock(node.body) && node.body.statements.some((item) => declares(item, "pollPendingImage"))) as ts.ArrowFunction;
const generation = findNode(source, (node) => ts.isTryStatement(node) && node.tryBlock.statements.some((item) => declares(item, "generatedImages"))) as ts.TryStatement;
expect(recovery && generation).toBeTruthy();
const generationBlock = generation.parent as ts.Block;
const generationTail = generationBlock.statements.slice(generationBlock.statements.indexOf(generation)).map((statement) => statement.getText(source)).join("\n");

const tick = () => new Promise(setImmediate);

for (const terminalStatus of ["succeeded", "failed"]) {
    test(`foreground timeout preserves submitted image slots until server reports ${terminalStatus}`, async () => {
        let nodes: any[] = [
            { id: "source", type: "config", metadata: { status: "loading" } },
            { id: "image", type: "image", width: 100, height: 100, metadata: { status: "loading", images: [{ id: "slot", status: "loading", generationBatchId: "batch", generationTaskId: "task" }] } },
        ];
        let interval: (() => void) | undefined;
        let task: any = { id: "task", status: "running" };
        const context: Record<string, any> = {
            rootId: "image", nodeId: "source", isConfigNode: true, projectId: "project", batchId: "batch",
            referenceImages: [], generationConfig: {}, effectivePrompt: "prompt", count: 1,
            controller: { signal: { aborted: false } }, onBatchCreated() {}, applyTaskUpdate() {},
            requestGeneration: async () => { throw new Error("foreground wait expired"); },
            getGenerationBatch: async () => ({ tasks: [task] }),
            hasSuccess: false, hasFailure: false, firstError: "",
            isGenerationCanceled: () => false,
            message: { error() {} }, t: (key: string) => key,
            NODE_STATUS_LOADING: "loading", NODE_STATUS_SUCCESS: "success", NODE_STATUS_ERROR: "error",
            CanvasNodeType: { Config: "config", Image: "image" },
            setNodes: (update: (value: any[]) => any[]) => { nodes = update(nodes); context.nodes = nodes; },
            nodes, projectLoaded: true,
            connections: [{ fromNodeId: "source", toNodeId: "image" }],
            generationRequestsRef: { current: new Map([["image", {}]]) },
            // 恢复轮询从 pendingImagesRef 读取待恢复的图片槽位。
            pendingImagesRef: { get current() { return nodes[1].metadata.images.map((image: any) => ({ nodeId: "image", image })); } },
            restoringGenerationImagesRef: { current: new Set() },
            finishGenerationRequest: (id: string) => context.generationRequestsRef.current.delete(id),
            fitNodeSize: (width: number, height: number) => ({ width, height }),
            window: { setInterval: (callback: () => void, delay: number) => { expect(delay).toBe(1800); interval = callback; return 1; }, clearInterval: () => { interval = undefined; } },
            Date: { now: () => 11 * 60 * 1000 + 1 },
            GENERATION_RECOVERY_MAX_WAIT_MS: 10 * 60 * 1000,
            generationRecoveryStartedRef: { current: new Map([["image:slot:batch", 1]]) },
        };
        await evaluate(`async () => { ${generationTail} }`, context)();
        expect(nodes[0].metadata.status).toBe("loading");
        expect(nodes[1].metadata.images[0].status).toBe("loading");
        expect(nodes[1].metadata.images[0].generationTaskId).toBe("task");
        expect(context.generationRequestsRef.current.has("image")).toBe(false);

        const cleanup = evaluate(recovery.getText(recoverySource), context)();
        try {
            await tick();
            expect(nodes[1].metadata.images[0].status).toBe("loading");
            task = { id: "task", status: terminalStatus, errorMessage: "upstream rejected", image: terminalStatus === "succeeded" ? { mediaId: "media", url: "/api/media/media", width: 100, height: 100 } : undefined };
            interval!();
            await tick();
            const expected = terminalStatus === "succeeded" ? "success" : "error";
            expect(nodes[0].metadata.status).toBe(expected);
            expect(nodes[1].metadata.images[0].status).toBe(expected);
            if (terminalStatus === "succeeded") expect(nodes[1].metadata.content).toBe("/api/media/media");
            else expect(nodes[1].metadata.images[0].errorDetails).toBe("upstream rejected");
        } finally {
            cleanup();
        }
    });
}

import type { InsertAssetPayload } from "@/components/canvas/asset-picker-modal";
import { createCanvasNode, imageMetadata, audioMetadata } from "./canvas-node-factory";
import { fitNodeSize } from "./canvas-node-size";
import { readImageMeta } from "@/lib/image-utils";
import { uploadImage } from "@/services/image-storage";
import { CanvasNodeType, type Position } from "@/types/canvas";
import { arrangeCanvasNodes } from "./canvas-arrange";

export async function prepareCanvasHandoff(items: InsertAssetPayload[], center: Position, assertCurrent: () => void) {
    assertCurrent();
    const nodes = await Promise.all(items.map(async (item) => {
        assertCurrent();
        if (item.kind === "image") {
            const stored = item.storageKey ? null : await uploadImage(item.dataUrl);
            assertCurrent();
            const meta = stored || await readImageMeta(item.dataUrl);
            assertCurrent();
            const size = fitNodeSize(meta.width, meta.height);
            return { ...createCanvasNode(CanvasNodeType.Image, center, imageMetadata({ url: stored?.url || item.dataUrl, storageKey: stored?.storageKey || item.storageKey!, width: meta.width, height: meta.height, bytes: stored?.bytes || 0, mimeType: stored?.mimeType || "image/png" })), ...size, position: { x: center.x - size.width / 2, y: center.y - size.height / 2 }, title: item.title };
        }
        if (item.kind === "text") return { ...createCanvasNode(CanvasNodeType.Text, center, { content: item.content, status: "success" }), title: item.title };
        if (item.kind === "audio") return { ...createCanvasNode(CanvasNodeType.Audio, center, audioMetadata({ url: item.url, storageKey: item.storageKey || "", bytes: item.bytes || 0, mimeType: item.mimeType || "audio/mpeg" })), title: item.title };
        const node = createCanvasNode(CanvasNodeType.Video, center, { content: item.url, storageKey: item.storageKey, status: "success", naturalWidth: item.width, naturalHeight: item.height });
        const size = fitNodeSize(item.width || node.width, item.height || node.height, node.width, node.width);
        return { ...node, ...size, position: { x: center.x - size.width / 2, y: center.y - size.height / 2 }, title: item.title };
    }));
    assertCurrent();
    return arrangeCanvasNodes(nodes, new Set(nodes.map((node) => node.id)), "grid");
}

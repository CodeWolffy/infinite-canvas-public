import { saveAs } from "file-saver";

import { createZip, readZip } from "@/lib/zip";
import { getMediaBlob } from "@/services/file-storage";
import { getImageBlob, uploadImage } from "@/services/image-storage";
import { uploadMedia } from "@/services/api/media";
import { randomId } from "@/lib/utils";
import type { Asset, AssetDraft } from "@/stores/use-asset-store";
import { assertCurrentSession, useUserStore } from "@/stores/use-user-store";

type AssetExportFile = {
    app: "infinite-canvas";
    version: 1;
    exportedAt: string;
    assets: Asset[];
    files: AssetExportItem[];
};

type AssetExportItem = {
    storageKey: string;
    path: string;
    mimeType: string;
    bytes: number;
};

export async function exportAssets(assets: Asset[], filename: string) {
    const session = useUserStore.getState().sessionVersion;
    const files: AssetExportItem[] = [];
    const zipFiles: { name: string; data: BlobPart }[] = [];

    await Promise.all(
        assets.map(async (asset) => {
            if (asset.kind === "text") return;
            const storageKey = asset.data.storageKey;
            if (!storageKey) return;
            const blob = asset.kind === "image" ? await getImageBlob(storageKey) : await getMediaBlob(storageKey);
            if (!blob) return;
            const path = `files/${safeFileName(storageKey)}.${fileExtension(blob.type, asset.kind)}`;
            files.push({ storageKey, path, mimeType: blob.type || asset.data.mimeType, bytes: blob.size });
            zipFiles.push({ name: path, data: blob });
        }),
    );

    const data: AssetExportFile = { app: "infinite-canvas", version: 1, exportedAt: new Date().toISOString(), assets, files };
    const zip = await createZip([{ name: "assets.json", data: JSON.stringify(data, null, 2) }, ...zipFiles]);
    assertCurrentSession(session);
    saveAs(zip, filename);
}

export type AssetImportItem = { requestId: string; title: string; prepare: () => Promise<AssetDraft> };

export async function readAssetPackage(file: File, options: { signal: AbortSignal; assertCurrent: () => void }): Promise<AssetImportItem[]> {
    const session = useUserStore.getState().sessionVersion;
    const assertCurrent = () => {
        assertCurrentSession(session);
        options.assertCurrent();
        if (options.signal.aborted) throw new DOMException("导入已取消", "AbortError");
    };
    const zip = await readZip(file);
    assertCurrent();
    const assetFile = zip.get("assets.json");
    if (!assetFile) throw new Error("素材包缺少 assets.json");
    const data = JSON.parse(await assetFile.text()) as AssetExportFile;
    assertCurrent();
    if (data?.app !== "infinite-canvas" || data.version !== 1 || !Array.isArray(data.assets) || !Array.isArray(data.files)) throw new Error("素材包格式不正确");
    const uploads = new Map<string, Promise<{ storageKey: string; url: string; bytes: number; mimeType: string }>>();
    return data.assets.map((asset: Asset, index) => {
        let prepared: AssetDraft | undefined;
        return { requestId: randomId(), title: typeof asset?.title === "string" && asset.title ? asset.title : `第 ${index + 1} 项`, prepare: async () => {
            assertCurrent();
            if (prepared) return prepared;
            if (!asset || !["text", "image", "video", "audio"].includes(asset.kind) || typeof asset.title !== "string" || !asset.title.trim() || !asset.data) throw new Error("素材信息不完整");
            if (asset.kind === "text") {
                if (typeof asset.data.content !== "string") throw new Error("文本素材缺少正文");
                return prepared = { ...asset, scope: "private", workspaceId: null };
            }
            const key = asset.data.storageKey;
            const entry = data.files.find((item) => item.storageKey === key);
            const blob = entry && zip.get(entry.path);
            if (!key || !entry || !blob) throw new Error("素材包缺少对应媒体文件");
            let upload = uploads.get(key);
            if (!upload) {
                const typedBlob = blob.type ? blob : blob.slice(0, blob.size, entry.mimeType);
                assertCurrent();
                upload = (asset.kind === "image" ? uploadImage(typedBlob, { signal: options.signal }) : uploadMedia(typedBlob, entry.path).then((media) => ({ storageKey: `media:${media.id}`, url: media.url, bytes: media.byteSize, mimeType: media.mimeType }))).catch((error) => { uploads.delete(key); throw error; });
                uploads.set(key, upload);
            }
            const media = await upload;
            assertCurrent();
            const common = { ...asset, scope: "private" as const, workspaceId: null, coverUrl: asset.kind === "image" ? media.url : "" };
            const result: AssetDraft = asset.kind === "image" ? { ...common, kind: "image", data: { ...asset.data, ...media, dataUrl: media.url } } : { ...common, kind: asset.kind, data: { ...asset.data, ...media } };
            prepared = result;
            return result;
        } };
    });
}

function safeFileName(value: string) {
    return value.replace(/[\\/:*?"<>|]/g, "_");
}

function fileExtension(mimeType: string, kind: Asset["kind"]) {
    if (mimeType.includes("png")) return "png";
    if (mimeType.includes("jpeg")) return "jpg";
    if (mimeType.includes("webp")) return "webp";
    if (mimeType.includes("gif")) return "gif";
    if (mimeType.includes("mp4")) return "mp4";
    if (mimeType.includes("webm")) return "webm";
    return kind === "image" ? "png" : "bin";
}

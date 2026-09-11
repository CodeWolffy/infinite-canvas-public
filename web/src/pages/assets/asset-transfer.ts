import { saveAs } from "file-saver";

import { createZip, readZip } from "@/lib/zip";
import { getMediaBlob, uploadMediaFile } from "@/services/file-storage";
import { getImageBlob, uploadImage } from "@/services/image-storage";
import { mediaUrl } from "@/services/api/media";
import type { Asset } from "@/stores/use-asset-store";
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

export async function readAssetPackage(file: File) {
    const session = useUserStore.getState().sessionVersion;
    const zip = await readZip(file);
    const assetFile = zip.get("assets.json");
    if (!assetFile) throw new Error("missing assets.json");
    const data = JSON.parse(await assetFile.text()) as AssetExportFile;
    assertCurrentSession(session);
    const storageKeys = new Map<string, string>();
    await Promise.all(
        data.files.map(async (item) => {
            const blob = zip.get(item.path);
            if (!blob) return;
            const typedBlob = blob.type ? blob : blob.slice(0, blob.size, item.mimeType);
            assertCurrentSession(session);
            if (typedBlob.type.startsWith("image/")) {
                const image = await uploadImage(typedBlob);
                storageKeys.set(item.storageKey, image.storageKey);
            } else {
                const media = await uploadMediaFile(typedBlob);
                storageKeys.set(item.storageKey, media.storageKey);
            }
        }),
    );
    assertCurrentSession(session);
    return data.assets.map((asset) => {
        if (asset.kind === "text" || !asset.data.storageKey) return asset;
        const storageKey = storageKeys.get(asset.data.storageKey);
        if (asset.kind !== "image") return storageKey ? { ...asset, coverUrl: "", data: { ...asset.data, storageKey, url: mediaUrl(storageKey) } } : asset;
        return storageKey ? { ...asset, coverUrl: mediaUrl(storageKey), data: { ...asset.data, storageKey, dataUrl: mediaUrl(storageKey) } } : asset;
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

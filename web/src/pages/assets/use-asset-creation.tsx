import { useNavigate } from "react-router-dom";
import { useAddToCanvas } from "@/hooks/use-add-to-canvas";
import { useCreationDraftStore } from "@/stores/use-creation-draft-store";
import type { Asset } from "@/stores/use-asset-store";
import type { InsertAssetPayload } from "@/components/canvas/asset-picker-modal";

export function useAssetCreation(asset: Asset | null) {
    const navigate = useNavigate();
    const addToCanvas = useAddToCanvas();
    const create = (capability: "image" | "video" | "text") => {
        if (!asset) return;
        const references = asset.kind === "text" ? [] : [{ id: crypto.randomUUID(), name: asset.title, type: asset.data.mimeType, dataUrl: asset.kind === "image" ? asset.data.dataUrl : asset.data.url, storageKey: asset.data.storageKey }];
        useCreationDraftStore.getState().setDraft({ capability, prompt: asset.kind === "text" ? asset.data.content : "", references, sourceTitle: asset.title });
        navigate(`/${capability}`);
    };
    return asset ? [
        ...(asset.kind === "text" ? [{ key: "text", label: "带入文本对话", onClick: () => create("text") }] : []),
        ...(asset.kind === "text" || asset.kind === "image" ? [{ key: "image", label: asset.kind === "text" ? "用作生图提示词" : "用作生图参考", onClick: () => create("image") }] : []),
        { key: "video", label: asset.kind === "text" ? "用作视频提示词" : "用作视频参考", onClick: () => create("video") },
        { key: "canvas", label: "加入画布", onClick: () => addToCanvas([assetToCanvasPayload(asset)]) },
    ] : [];
}

function assetToCanvasPayload(asset: Asset): InsertAssetPayload {
    if (asset.kind === "text") return { kind: "text", content: asset.data.content, title: asset.title };
    if (asset.kind === "image") return { kind: "image", dataUrl: asset.data.dataUrl, storageKey: asset.data.storageKey, title: asset.title };
    if (asset.kind === "video") return { kind: "video", url: asset.data.url, storageKey: asset.data.storageKey, title: asset.title, width: asset.data.width, height: asset.data.height };
    return { kind: "audio", url: asset.data.url, storageKey: asset.data.storageKey, title: asset.title, bytes: asset.data.bytes, mimeType: asset.data.mimeType };
}

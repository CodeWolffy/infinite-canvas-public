import { create } from "zustand";

import { randomId } from "@/lib/utils";
import * as assetApi from "@/services/api/assets";
import { mediaId, mediaUrl } from "@/services/api/media";
import { assertCurrentSession, useUserStore } from "@/stores/use-user-store";

export type AssetKind = "text" | "image" | "video" | "audio";
export type AssetScope = "private" | "public";
export type TextAsset = AssetBase<"text"> & { data: { content: string } };
export type ImageAsset = AssetBase<"image"> & { data: { dataUrl: string; storageKey?: string; width: number; height: number; bytes: number; mimeType: string } };
export type VideoAsset = AssetBase<"video"> & { data: { url: string; storageKey?: string; width: number; height: number; bytes: number; mimeType: string } };
export type AudioAsset = AssetBase<"audio"> & { data: { url: string; storageKey?: string; width: number; height: number; bytes: number; mimeType: string } };
export type Asset = TextAsset | ImageAsset | VideoAsset | AudioAsset;

type AssetBase<T extends AssetKind> = {
    id: string;
    ownerId?: string;
    scope?: AssetScope;
    editable?: boolean;
    kind: T;
    title: string;
    coverUrl: string;
    tags: string[];
    source?: string;
    note?: string;
    createdAt: string;
    updatedAt: string;
    metadata?: Record<string, unknown>;
};

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
type AssetDraft = DistributiveOmit<Asset, "id" | "createdAt" | "updatedAt">;
type AssetStore = {
    hydrated: boolean;
    hydratedUserId: string;
    assets: Asset[];
    hydrateAssets: (userId: string, force?: boolean) => Promise<void>;
    addAsset: (asset: AssetDraft) => Promise<string>;
    updateAsset: (id: string, patch: Partial<Omit<Asset, "id" | "createdAt">>) => void;
    removeAsset: (id: string) => void;
    replaceAssets: (assets: Asset[]) => void;
    cleanupImages: (extra?: unknown) => void;
};

const hydratePromises = new Map<string, Promise<void>>();

function stringMetadata(metadata: Record<string, unknown>, key: string) {
    return typeof metadata[key] === "string" ? (metadata[key] as string) : "";
}

function numberMetadata(metadata: Record<string, unknown>, key: string) {
    return typeof metadata[key] === "number" ? (metadata[key] as number) : 0;
}

function normalizeAsset(record: assetApi.AssetRecord): Asset {
    const metadata = record.metadata || {};
    const user = useUserStore.getState().user;
    const common = {
        id: record.id,
        ownerId: record.ownerId,
        scope: record.scope,
        editable: Boolean(record.ownerId && record.ownerId === user?.id),
        title: record.title,
        coverUrl: stringMetadata(metadata, "coverUrl"),
        tags: Array.isArray(metadata.tags) ? (metadata.tags as string[]) : [],
        source: stringMetadata(metadata, "source"),
        note: stringMetadata(metadata, "note"),
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
        metadata,
    };
    if (record.type === "text") {
        return {
            ...common,
            kind: "text",
            coverUrl: "",
            data: { content: record.content || "" },
        };
    }
    const url = mediaUrl(record.mediaId || "");
    if (record.type === "audio") return { ...common, kind: "audio", coverUrl: "", data: { url, storageKey: `media:${record.mediaId}`, width: 0, height: 0, bytes: numberMetadata(metadata, "bytes"), mimeType: stringMetadata(metadata, "mimeType") || "audio/mpeg" } };
    if (record.type === "video") return { ...common, kind: "video", coverUrl: "", data: { url, storageKey: `media:${record.mediaId}`, width: numberMetadata(metadata, "width"), height: numberMetadata(metadata, "height"), bytes: numberMetadata(metadata, "bytes"), mimeType: stringMetadata(metadata, "mimeType") || "video/mp4" } };
    return {
        ...common,
        kind: "image",
        coverUrl: url,
        data: {
            dataUrl: url,
            storageKey: mediaId(record.mediaId || ""),
            width: numberMetadata(metadata, "width"),
            height: numberMetadata(metadata, "height"),
            bytes: numberMetadata(metadata, "bytes"),
            mimeType: stringMetadata(metadata, "mimeType") || "image/png",
        },
    };
}

function assetInput(asset: AssetDraft): assetApi.AssetInput {
    const { kind, title, tags, source, note, data, metadata } = asset;
    const commonMetadata = { ...metadata, ...(tags?.length ? { tags } : {}), ...(source ? { source } : {}), ...(note ? { note } : {}) };
    if (kind === "text") {
        return { scope: asset.scope || "private", type: "text", title, content: data.content, metadata: commonMetadata };
    }
    return {
        scope: asset.scope || "private",
        type: kind,
        title,
        mediaId: mediaId(data.storageKey || ("dataUrl" in data ? data.dataUrl : data.url)),
        metadata: {
            ...commonMetadata,
            width: data.width,
            height: data.height,
            bytes: data.bytes,
            mimeType: data.mimeType,
        },
    };
}

export const useAssetStore = create<AssetStore>()((set, get) => ({
    hydrated: false,
    hydratedUserId: "",
    assets: [],
    hydrateAssets: async (userId, force = false) => {
        const { sessionVersion, user } = useUserStore.getState();
        if (user?.id !== userId) return;
        if (!force && get().hydrated && get().hydratedUserId === userId) return;
        if (get().hydratedUserId !== userId) set({ assets: [], hydrated: false, hydratedUserId: userId });
        let request = hydratePromises.get(userId);
        if (!request) {
            request = assetApi.listAssets().then((records) => {
                if (useUserStore.getState().sessionVersion === sessionVersion) set({ assets: records.map(normalizeAsset), hydrated: true });
            }).finally(() => {
                if (useUserStore.getState().sessionVersion === sessionVersion) hydratePromises.delete(userId);
            });
            hydratePromises.set(userId, request);
        }
        await request;
    },
    addAsset: async (draft) => {
        const sessionVersion = useUserStore.getState().sessionVersion;
        const temporaryId = `pending-${randomId()}`;
        const now = new Date().toISOString();
        set((state) => ({ assets: [{ ...draft, id: temporaryId, createdAt: now, updatedAt: now } as Asset, ...state.assets] }));
        try {
            const record = await assetApi.createAsset(assetInput(draft));
            assertCurrentSession(sessionVersion);
            set((state) => ({ assets: state.assets.map((asset) => (asset.id === temporaryId ? normalizeAsset(record) : asset)) }));
            return record.id;
        } catch (error) {
            if (useUserStore.getState().sessionVersion === sessionVersion) set((state) => ({ assets: state.assets.filter((asset) => asset.id !== temporaryId) }));
            throw error;
        }
    },
    updateAsset: (id, patch) => {
        const sessionVersion = useUserStore.getState().sessionVersion;
        const current = get().assets.find((asset) => asset.id === id);
        if (!current || current.editable === false) return;
        const next = { ...current, ...patch, updatedAt: new Date().toISOString() } as Asset;
        set((state) => ({ assets: state.assets.map((asset) => (asset.id === id ? next : asset)) }));
        if (!id.startsWith("pending-")) void assetApi.updateAsset(id, assetInput(next)).then((record) => {
            if (useUserStore.getState().sessionVersion === sessionVersion) set((state) => ({ assets: state.assets.map((asset) => (asset.id === id ? normalizeAsset(record) : asset)) }));
        }).catch(() => {
            if (useUserStore.getState().sessionVersion === sessionVersion) set((state) => ({ assets: state.assets.map((asset) => (asset.id === id ? current : asset)) }));
        });
    },
    removeAsset: (id) => {
        const sessionVersion = useUserStore.getState().sessionVersion;
        const current = get().assets.find((asset) => asset.id === id);
        if (!current || current.editable === false) return;
        set((state) => ({ assets: state.assets.filter((asset) => asset.id !== id) }));
        if (!id.startsWith("pending-")) void assetApi.deleteAsset(id).catch(() => {
            if (useUserStore.getState().sessionVersion === sessionVersion) set((state) => ({ assets: [current, ...state.assets] }));
        });
    },
    replaceAssets: (assets) => set({ assets }),
    cleanupImages: () => {},
}));

useUserStore.subscribe((state, previous) => {
    if (state.sessionVersion === previous.sessionVersion) return;
    hydratePromises.clear();
    useAssetStore.setState({ hydrated: false, hydratedUserId: "", assets: [] });
});

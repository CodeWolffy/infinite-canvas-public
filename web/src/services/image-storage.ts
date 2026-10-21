import localforage from "localforage";
import i18n from "@/i18n";
import { createImageThumbnail } from "@/lib/image-thumbnail";
import { readImageMeta } from "@/lib/image-utils";
import { mediaUrl, readMedia, uploadMedia } from "@/services/api/media";
import { assertCurrentSession, useUserStore } from "@/stores/use-user-store";

export type UploadedImage = {
    url: string;
    storageKey: string;
    width: number;
    height: number;
    bytes: number;
    mimeType: string;
};

const previewStores = new Map<string, LocalForage>();
const previewUrls = new Map<string, string>();
const pendingPreviews = new Map<string, Promise<string | undefined>>();
const previewListeners = new Set<() => void>();
let previewRevision = 0;
let previewQueue: Promise<unknown> = Promise.resolve();
const IMAGE_PREVIEW_VERSION = 1;

type StoredImagePreview = { version: number; blob?: Blob };

function previewScope() {
    const { user, sessionVersion } = useUserStore.getState();
    if (!user) return undefined;
    let storage = previewStores.get(user.id);
    if (!storage) {
        storage = localforage.createInstance({ name: "infinite-canvas", storeName: `image_previews_${user.id.replaceAll("-", "_")}` });
        previewStores.set(user.id, storage);
    }
    return { storage, sessionVersion };
}

type PreviewScope = NonNullable<ReturnType<typeof previewScope>>;
const previewKey = (key: string) => key.replace(/^(?:image|media):/, "");

useUserStore.subscribe((state, prevState) => {
    if (state.sessionVersion !== prevState.sessionVersion) {
        previewUrls.forEach((url) => URL.revokeObjectURL(url));
        previewUrls.clear();
        pendingPreviews.clear();
        previewQueue = Promise.resolve();
        previewRevision += 1;
        previewListeners.forEach((listener) => listener());
    }
});

type ImageReadOptions = { signal?: AbortSignal };

export async function uploadImage(input: string | Blob, options?: ImageReadOptions): Promise<UploadedImage> {
    const sessionVersion = useUserStore.getState().sessionVersion;
    const scope = previewScope();
    if (options?.signal?.aborted) throw abortReason(options.signal);
    const blob = typeof input === "string" ? await fetchImageBlob(input, options) : input;
    const previewUrl = URL.createObjectURL(blob);
    const meta = await readImageMeta(previewUrl).finally(() => URL.revokeObjectURL(previewUrl));
    assertCurrentSession(sessionVersion);
    if (options?.signal?.aborted) throw abortReason(options.signal);
    const existingId = typeof input === "string" ? input.match(/\/api\/media\/([0-9a-f-]{36})(?:\b|\/|\?|#)/i)?.[1] : undefined;
    if (existingId) {
        const storageKey = `image:${existingId}`;
        await storeImagePreview(storageKey, blob, scope);
        assertCurrentSession(sessionVersion);
        return { url: mediaUrl(existingId), storageKey, width: meta.width, height: meta.height, bytes: blob.size, mimeType: blob.type || meta.mimeType };
    }
    const media = await uploadMedia(blob, input instanceof File ? input.name : `image.${meta.mimeType.split("/")[1] || "png"}`);
    const storageKey = `image:${media.id}`;
    await storeImagePreview(storageKey, blob, scope);
    assertCurrentSession(sessionVersion);
    return { url: media.url, storageKey, width: media.width || meta.width, height: media.height || meta.height, bytes: media.byteSize, mimeType: media.mimeType || meta.mimeType };
}

const IMAGE_DOWNLOAD_TIMEOUT_MS = 10 * 60_000;
const IMAGE_RESPONSE_ERROR = "ImageResponseError";
const IMAGE_TIMEOUT_ERROR = "ImageTimeoutError";

async function fetchImageBlob(url: string, options?: ImageReadOptions) {
    const sessionVersion = useUserStore.getState().sessionVersion;
    const controller = new AbortController();
    let timedOut = false;
    const abort = () => controller.abort();
    if (options?.signal?.aborted) abort();
    else options?.signal?.addEventListener("abort", abort, { once: true });
    const timer = window.setTimeout(() => {
        timedOut = true;
        controller.abort();
    }, IMAGE_DOWNLOAD_TIMEOUT_MS);
    try {
        const response = await fetch(url, { signal: controller.signal });
        if (!response.ok) throw namedError(IMAGE_RESPONSE_ERROR);
        const blob = await response.blob();
        assertCurrentSession(sessionVersion);
        return blob;
    } catch (error) {
        if (timedOut) throw namedError(IMAGE_TIMEOUT_ERROR);
        if (options?.signal?.aborted) throw abortReason(options.signal);
        throw error;
    } finally {
        window.clearTimeout(timer);
        options?.signal?.removeEventListener("abort", abort);
    }
}

function namedError(name: string) {
    const error = new Error(i18n.t("common.imageReadFailed"));
    error.name = name;
    return error;
}

function abortReason(signal: AbortSignal) {
    return signal.reason instanceof Error ? signal.reason : new DOMException("Aborted", "AbortError");
}

// 缩略图按图片的 storageKey 另存一份 WebP，只放在本地 IndexedDB 里，不写进节点数据，也不参与导出和 WebDAV 同步。
export function previewUrlFor(storageKey?: string) {
    return storageKey ? previewUrls.get(previewKey(storageKey)) : undefined;
}

// 缩略图在后台补，生成完成后再让用到它的界面重渲染一次。
export function subscribeImagePreviews(listener: () => void) {
    previewListeners.add(listener);
    return () => {
        previewListeners.delete(listener);
    };
}

export function getImagePreviewRevision() {
    return previewRevision;
}

export async function ensureImagePreview(storageKey?: string) {
    const scope = previewScope();
    if (!storageKey || !scope) return undefined;
    const key = previewKey(storageKey);
    const cached = previewUrls.get(key);
    if (cached) return cached;
    const pending = pendingPreviews.get(key);
    if (pending) return pending;
    const request = (async () => {
        const stored = await scope.storage.getItem<StoredImagePreview>(key).catch(() => null);
        assertCurrentSession(scope.sessionVersion);
        if (stored?.version === IMAGE_PREVIEW_VERSION) return stored.blob ? cacheImagePreview(key, stored.blob, scope) : undefined;
        return queueImagePreview(key, scope);
    })().catch(() => undefined).finally(() => {
        if (pendingPreviews.get(key) === request) pendingPreviews.delete(key);
    });
    pendingPreviews.set(key, request);
    return request;
}

// 缩略图生成排成一队，避免一次打开大量图片时同时解码。
function queueImagePreview(storageKey: string, scope: PreviewScope) {
    const request = previewQueue
        .then(async () => {
            assertCurrentSession(scope.sessionVersion);
            const original = await getImageBlob(storageKey);
            assertCurrentSession(scope.sessionVersion);
            if (original) return storeImagePreview(storageKey, original, scope);
        })
        .catch(() => undefined);
    previewQueue = request;
    return request;
}

async function storeImagePreview(storageKey: string, original: Blob, scope?: PreviewScope) {
    if (!scope) return undefined;
    const key = previewKey(storageKey);
    assertCurrentSession(scope.sessionVersion);
    const preview = await createImageThumbnail(original).catch(() => undefined);
    assertCurrentSession(scope.sessionVersion);
    await scope.storage.setItem<StoredImagePreview>(key, { version: IMAGE_PREVIEW_VERSION, blob: preview }).catch(() => undefined);
    assertCurrentSession(scope.sessionVersion);
    return preview ? cacheImagePreview(key, preview, scope) : undefined;
}

function cacheImagePreview(storageKey: string, preview: Blob, scope: PreviewScope) {
    assertCurrentSession(scope.sessionVersion);
    const previous = previewUrls.get(storageKey);
    if (previous) URL.revokeObjectURL(previous);
    const url = URL.createObjectURL(preview);
    previewUrls.set(storageKey, url);
    previewRevision += 1;
    previewListeners.forEach((listener) => listener());
    return url;
}

async function deleteImagePreview(key: string, scope: PreviewScope) {
    assertCurrentSession(scope.sessionVersion);
    const storageKey = previewKey(key);
    const url = previewUrls.get(storageKey);
    if (url) URL.revokeObjectURL(url);
    previewUrls.delete(storageKey);
    await scope.storage.removeItem(storageKey).catch(() => undefined);
}

export async function resolveImageUrl(storageKey?: string, fallback = "") {
    return storageKey ? mediaUrl(storageKey) : fallback;
}

export async function getImageBlob(storageKey: string) {
    return readMedia(storageKey);
}

export async function setImageBlob(_storageKey: string, blob: Blob) {
    return (await uploadImage(blob)).url;
}

export async function imageToDataUrl(image: { url?: string; dataUrl?: string; storageKey?: string }, options?: ImageReadOptions) {
    const url = image.dataUrl && !image.dataUrl.startsWith("blob:") ? image.dataUrl : await resolveImageUrl(image.storageKey, image.url || "");
    if (!url || url.startsWith("data:")) return url;
    return blobToDataUrl(await fetchImageBlob(url, options));
}

export async function deleteStoredImages(keys: Iterable<string>) {
    const scope = previewScope();
    if (scope) await Promise.all(Array.from(new Set(keys)).map((key) => deleteImagePreview(key, scope)));
}

export async function cleanupUnusedImages(usedData: unknown) {
    const scope = previewScope();
    if (!scope) return;
    const usedKeys = new Set([...collectImageStorageKeys(usedData)].map(previewKey));
    const orphanPreviews: string[] = [];
    await scope.storage.iterate((_value, key) => {
        if (!usedKeys.has(key)) orphanPreviews.push(key);
    });
    assertCurrentSession(scope.sessionVersion);
    await Promise.all(orphanPreviews.map((key) => deleteImagePreview(key, scope)));
}

export function collectImageStorageKeys(value: unknown, keys = new Set<string>()) {
    if (!value || typeof value !== "object") return keys;
    if ("storageKey" in value && typeof value.storageKey === "string" && value.storageKey.startsWith("image:")) keys.add(value.storageKey);
    Object.values(value).forEach((item) => (Array.isArray(item) ? item.forEach((child) => collectImageStorageKeys(child, keys)) : collectImageStorageKeys(item, keys)));
    return keys;
}

function blobToDataUrl(blob: Blob) {
    return new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ""));
        reader.onerror = () => reject(new Error(i18n.t("common.imageReadFailed")));
        reader.readAsDataURL(blob);
    });
}

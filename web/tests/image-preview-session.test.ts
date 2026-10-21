import { afterEach, beforeEach, expect, test, vi } from "vitest";

const state = vi.hoisted(() => ({ sessionVersion: 1, user: { id: "A" }, listeners: [] as Array<(next: { sessionVersion: number }, previous: { sessionVersion: number }) => void>, stores: new Map<string, { data: Map<string, unknown>; getItem: ReturnType<typeof vi.fn>; setItem: ReturnType<typeof vi.fn> }>() }));
vi.mock("@/stores/use-user-store", () => ({ useUserStore: { getState: () => state, subscribe: (callback: (next: typeof state, previous: typeof state) => void) => state.listeners.push(callback) }, assertCurrentSession: (version: number) => { if (version !== state.sessionVersion) throw new DOMException("会话已变更", "AbortError"); } }));
vi.mock("@/i18n", () => ({ default: { t: (key: string) => key } }));
vi.mock("@/lib/image-utils", () => ({ readImageMeta: vi.fn() }));
vi.mock("@/lib/image-thumbnail", () => ({ createImageThumbnail: vi.fn() }));
vi.mock("@/services/api/media", () => ({ mediaUrl: (id: string) => `/api/media/${id}`, readMedia: vi.fn(), uploadMedia: vi.fn() }));
vi.mock("localforage", () => ({ default: { createInstance: ({ storeName }: { storeName: string }) => {
    const data = new Map<string, unknown>();
    const store = { data, getItem: vi.fn(async (key: string) => data.get(key)), setItem: vi.fn(async (key: string, value: unknown) => { data.set(key, value); return value; }), removeItem: vi.fn(async (key: string) => data.delete(key)) };
    state.stores.set(storeName, store);
    return store;
} } }));

import { createImageThumbnail } from "@/lib/image-thumbnail";
import { readMedia } from "@/services/api/media";
import { ensureImagePreview, previewUrlFor } from "@/services/image-storage";

const switchAccount = (id: string) => { const previous = { sessionVersion: state.sessionVersion }; state.user = { id }; state.sessionVersion++; state.listeners.forEach((callback) => callback(state, previous)); };
beforeEach(() => {
    vi.stubGlobal("URL", { createObjectURL: vi.fn(() => `blob:${state.user.id}`), revokeObjectURL: vi.fn() });
    switchAccount(`user-${state.sessionVersion}`);
    vi.mocked(readMedia).mockReset().mockResolvedValue(new Blob(["image"]));
    vi.mocked(createImageThumbnail).mockReset().mockResolvedValue(new Blob(["thumbnail"]));
});
afterEach(() => vi.unstubAllGlobals());

test("同一媒体的不同 storageKey 共用一次读取和缩略图生成", async () => {
    const previews = await Promise.all([ensureImagePreview("image:media-id"), ensureImagePreview("media-id"), ensureImagePreview("media:media-id")]);
    expect(readMedia).toHaveBeenCalledTimes(1);
    expect(createImageThumbnail).toHaveBeenCalledTimes(1);
    expect(new Set(previews).size).toBe(1);
    expect(previewUrlFor("image:media-id")).toBe(previewUrlFor("media-id"));
});

test("切号后旧缩略图解码不能写回缓存，新账号使用独立存储", async () => {
    let resolve!: (blob: Blob) => void;
    vi.mocked(createImageThumbnail).mockImplementationOnce(() => new Promise((accept) => { resolve = accept; }));
    const originalUser = state.user.id;
    const pending = ensureImagePreview("private-image");
    await vi.waitFor(() => expect(createImageThumbnail).toHaveBeenCalledTimes(1));
    switchAccount("B");
    resolve(new Blob(["private A image"]));
    await pending;
    expect(previewUrlFor("private-image")).toBeUndefined();
    expect(state.stores.get(`image_previews_${originalUser.replaceAll("-", "_")}`)?.setItem).not.toHaveBeenCalled();
    await ensureImagePreview("private-image");
    expect(state.stores.get("image_previews_B")?.setItem).toHaveBeenCalledTimes(1);
    expect(previewUrlFor("private-image")).toBe("blob:B");
});

import { deleteMedia, mediaUrl, readMedia, uploadMedia } from "@/services/api/media";
import { assertCurrentSession, useUserStore } from "@/stores/use-user-store";

export type UploadedFile = { url: string; storageKey: string; bytes: number; mimeType: string; width?: number; height?: number; durationMs?: number };

export async function uploadMediaFile(input: string | Blob, prefix = "file"): Promise<UploadedFile> {
    const session = useUserStore.getState().sessionVersion;
    const response = typeof input === "string" ? await fetch(input, { credentials: "same-origin" }) : null;
    if (response && !response.ok) throw new Error("无法读取媒体文件");
    const blob = response ? await response.blob() : input as Blob;
    assertCurrentSession(session);
    const media = await uploadMedia(blob, `${prefix}.${blob.type.split("/")[1] || "bin"}`);
    assertCurrentSession(session);
    const meta = blob.type.startsWith("video/") ? await readVideoMeta(media.url) : blob.type.startsWith("audio/") ? await readAudioMeta(media.url) : {};
    assertCurrentSession(session);
    return { url: media.url, storageKey: `media:${media.id}`, bytes: media.byteSize, mimeType: media.mimeType, ...meta };
}

export async function resolveMediaUrl(storageKey?: string, fallback = "") {
    return storageKey ? mediaUrl(storageKey) : fallback;
}

export async function getMediaBlob(storageKey: string) {
    return readMedia(storageKey);
}

export async function setMediaBlob(_storageKey: string, blob: Blob) {
    return (await uploadMediaFile(blob)).url;
}

export async function deleteStoredMedia(keys: Iterable<string>) {
    await Promise.all(Array.from(new Set(keys)).map((key) => deleteMedia(key)));
}

export function readVideoMeta(url: string) {
    return new Promise<{ width: number; height: number; durationMs?: number }>((resolve) => {
        const video = document.createElement("video");
        const done = () => resolve({ width: video.videoWidth || 1280, height: video.videoHeight || 720, durationMs: Number.isFinite(video.duration) ? Math.round(video.duration * 1000) : undefined });
        video.onloadedmetadata = done;
        video.onerror = done;
        video.preload = "metadata";
        video.src = url;
    });
}

function readAudioMeta(url: string) {
    return new Promise<{ durationMs?: number }>((resolve) => {
        const audio = document.createElement("audio");
        const done = () => resolve({ durationMs: Number.isFinite(audio.duration) ? Math.round(audio.duration * 1000) : undefined });
        audio.onloadedmetadata = done;
        audio.onerror = done;
        audio.src = url;
    });
}

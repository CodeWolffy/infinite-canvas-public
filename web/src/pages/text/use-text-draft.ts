import { useCallback, useEffect, useRef, useState } from "react";
import localforage from "localforage";

import type { ReasoningEffort } from "@/lib/model-reasoning";
import { mediaId } from "@/services/api/media";
import { useUserStore } from "@/stores/use-user-store";
import type { ReferenceImage } from "@/types/image";

export type PendingTextFile = { file: File; url: string; reference?: never } | { file?: never; url: string; reference: ReferenceImage };
export type TextInputDraft = { prompt: string; modelId: string; systemPrompt: string; reasoningEffort: ReasoningEffort; files: PendingTextFile[]; action?: "edit" | "regenerate"; targetMessageId?: string; settingsDirty?: boolean; submission?: { id: string; fingerprint: string; mediaIds?: string[] } };
type StoredFile = { blob: Blob; name: string; lastModified: number; reference?: never } | { blob?: never; reference: ReferenceImage };
type StoredDraft = Omit<TextInputDraft, "files"> & { files: StoredFile[] };
const storage = localforage.createInstance({ name: "infinite-canvas", storeName: "text_drafts" });
const writes = new Map<string, Promise<void>>();

function queueWrite(key: string, write: () => Promise<void>) {
    const next = (writes.get(key) || Promise.resolve()).catch(() => undefined).then(write);
    writes.set(key, next);
    void next.finally(() => { if (writes.get(key) === next) writes.delete(key); }).catch(() => undefined);
    return next;
}

function serialize(value: TextInputDraft): StoredDraft {
    return { ...value, submission: value.submission ? { ...value.submission, mediaIds: value.submission.mediaIds?.slice() } : undefined, files: value.files.map((item) => item.file
        ? { blob: item.file, name: item.file.name, lastModified: item.file.lastModified }
        : { reference: { ...item.reference, dataUrl: item.reference.dataUrl.startsWith("blob:") ? "" : item.reference.dataUrl, url: item.reference.url?.startsWith("blob:") ? undefined : item.reference.url } }) };
}

function restore(value: StoredDraft): TextInputDraft {
    return { ...value, files: value.files.map((item) => {
        if (item.blob) {
            const file = new File([item.blob], item.name, { type: item.blob.type, lastModified: item.lastModified });
            return { file, url: URL.createObjectURL(file) };
        }
        return { reference: item.reference, url: item.reference.dataUrl || item.reference.url || `/api/media/${mediaId(item.reference.storageKey || "")}` };
    }) };
}

/** 页面输入改变前调用 markChanged；恢复的预览 URL 交由页面现有附件生命周期释放。 */
export function useTextDraft({ conversationId, value, onRestore }: { conversationId: string; value: TextInputDraft; onRestore: (draft: TextInputDraft) => void }) {
    const userId = useUserStore((state) => state.user?.id || "");
    const session = useUserStore((state) => state.sessionVersion);
    const key = JSON.stringify([userId, conversationId]);
    const [loaded, setLoaded] = useState("");
    const [error, setError] = useState("");
    const revision = useRef(0);
    const writeRevision = useRef(0);
    const readable = useRef(true);
    const mounted = useRef(false);
    const current = useRef({ value, onRestore, key });
    current.current = { value, onRestore, key };
    const markChanged = useCallback(() => { revision.current++; readable.current = true; }, []);
    const isSession = useCallback(() => useUserStore.getState().sessionVersion === session && (useUserStore.getState().user?.id || "") === userId, [session, userId]);
    const loadId = `${session}:${key}`;

    useEffect(() => {
        mounted.current = true;
        readable.current = true;
        let disposed = false;
        const inputRevision = revision.current;
        const input = current.current.value;
        const unchanged = () => {
            const next = current.current.value;
            return revision.current === inputRevision && next.prompt === input.prompt && next.modelId === input.modelId && next.systemPrompt === input.systemPrompt && next.reasoningEffort === input.reasoningEffort && next.files === input.files && next.action === input.action && next.targetMessageId === input.targetMessageId && next.settingsDirty === input.settingsDirty && next.submission?.id === input.submission?.id && next.submission?.fingerprint === input.submission?.fingerprint;
        };
        const valid = () => !disposed && isSession() && current.current.key === key;
        setError("");
        void (async () => {
            try {
                await writes.get(key)?.catch(() => undefined);
                if (!valid()) return;
                const saved = userId ? await storage.getItem<StoredDraft>(key) : null;
                if (!valid()) return;
                if (saved && unchanged() && !input.prompt && !input.files.length && !input.action && !input.settingsDirty && !input.submission) current.current.onRestore(restore(saved));
            } catch {
                if (valid()) { readable.current = !unchanged(); setError("草稿缓存读取失败，当前输入仍可使用。"); }
            } finally {
                if (valid()) setLoaded(loadId);
            }
        })();
        return () => { disposed = true; mounted.current = false; };
    }, [key, loadId, userId, isSession]);

    const ready = loaded === loadId;
    useEffect(() => {
        if (!ready || !userId || !isSession() || !readable.current) return;
        const snapshot = serialize(value);
        const version = ++writeRevision.current;
        void queueWrite(key, async () => {
            if (!isSession() || version !== writeRevision.current) return;
            if (snapshot.prompt || snapshot.files.length || snapshot.action || snapshot.settingsDirty) await storage.setItem(key, snapshot);
            else await storage.removeItem(key);
            if (mounted.current && isSession() && current.current.key === key && version === writeRevision.current) setError("");
        }).catch(() => { if (mounted.current && isSession()) setError("草稿未能保存到本机，刷新前请复制当前输入。"); });
    }, [ready, userId, key, value.prompt, value.modelId, value.systemPrompt, value.reasoningEffort, value.files, value.action, value.targetMessageId, value.settingsDirty, value.submission?.id, value.submission?.fingerprint, isSession]);

    const persistPending = useCallback(async (draft: TextInputDraft) => {
        if (!userId) return;
        const inputRevision = revision.current;
        const snapshot = serialize(draft);
        ++writeRevision.current;
        try {
            await queueWrite(key, async () => {
                if (!isSession() || inputRevision !== revision.current) throw new DOMException("输入或登录会话已变更", "AbortError");
                await storage.setItem(key, snapshot);
                if (!isSession() || inputRevision !== revision.current) throw new DOMException("输入或登录会话已变更", "AbortError");
            });
        } catch (error) {
            if (mounted.current && isSession() && !(error instanceof Error && error.name === "AbortError")) setError("提交前草稿保存失败，输入已保留，请重试。");
            throw error;
        }
    }, [key, userId, isSession]);

    const clear = useCallback(async (submissionId?: string) => {
        if (!submissionId) markChanged();
        const version = submissionId ? writeRevision.current : ++writeRevision.current;
        if (!userId || !isSession()) return;
        try {
            await queueWrite(key, async () => {
                if (!isSession()) return;
                if (submissionId) {
                    const saved = await storage.getItem<StoredDraft>(key);
                    if (!isSession() || saved?.submission?.id !== submissionId) return;
                } else if (version !== writeRevision.current) return;
                await storage.removeItem(key);
            });
        } catch {
            if (mounted.current && isSession()) setError("草稿缓存清除失败，请在刷新后核对输入。");
        }
    }, [key, userId, isSession, markChanged]);

    return { ready, error, markChanged, persistPending, clear };
}

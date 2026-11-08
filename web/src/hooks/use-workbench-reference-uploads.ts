import { useEffect, useRef, useState, type SetStateAction } from "react";
import { nanoid } from "nanoid";
import { uploadGenerationMedia } from "@/services/api/generation";
import { ensureImagePreview } from "@/services/image-storage";
import type { ReferenceImage } from "@/types/image";

type UploadSource = { name: string; type: string; blob?: Blob; prepare: () => Promise<Blob> };
export type ReferenceUpload = { id: string; name: string; status: "preparing" | "uploading" | "success" | "failed"; error?: string; retryable?: boolean };
export type StoredReferenceUpload = { id: string; name: string; type?: string; blob?: Blob; reference?: ReferenceImage; error?: string };
type UploadJob = ReferenceUpload & { source?: UploadSource; blob?: Blob; reference?: ReferenceImage; assertInput: () => void };
type Options = {
    initialReferences: ReferenceImage[];
    initialUploads?: StoredReferenceUpload[];
    sessionVersion: number;
    captureInputScope: () => () => void;
    onInputChange?: () => void;
    supportsType: (type: string) => boolean;
    unsupportedMessage: string;
    maxCount?: number;
};

export function useWorkbenchReferenceUploads(options: Options) {
    const [references, updateReferences] = useState(options.initialReferences);
    const [uploads, updateUploads] = useState<ReferenceUpload[]>([]);
    const referencesRef = useRef(references);
    const jobsRef = useRef<UploadJob[]>([]);
    const mountedRef = useRef(true);
    const sessionRef = useRef(options.sessionVersion);
    const optionsRef = useRef(options);
    optionsRef.current = options;

    const publish = () => updateUploads(jobsRef.current.map(({ id, name, status, error, retryable }) => ({ id, name, status, error, retryable })));
    const clearUploads = () => { jobsRef.current = []; publish(); };
    const restoreUploads = (saved: StoredReferenceUpload[]) => {
        const assertInput = optionsRef.current.captureInputScope();
        jobsRef.current = saved.map((item) => ({ ...item, status: "failed", retryable: Boolean(item.reference || item.blob && optionsRef.current.supportsType(item.type || item.blob.type)), assertInput,
            error: item.error || (item.blob || item.reference ? "上次上传未完成，请重试" : "上次素材读取未完成，请重新添加"),
            source: item.blob ? { name: item.name, type: item.type || item.blob.type, blob: item.blob, prepare: async () => item.blob! } : undefined,
        }));
        publish();
    };
    const setReferences = (next: SetStateAction<ReferenceImage[]>) => {
        optionsRef.current.onInputChange?.();
        if (typeof next !== "function") clearUploads();
        referencesRef.current = typeof next === "function" ? next(referencesRef.current) : next;
        updateReferences(referencesRef.current);
    };
    useEffect(() => {
        mountedRef.current = true;
        if (options.initialUploads?.length) restoreUploads(options.initialUploads);
        return () => { mountedRef.current = false; jobsRef.current = []; };
    }, []);
    useEffect(() => {
        if (sessionRef.current === options.sessionVersion) return;
        sessionRef.current = options.sessionVersion;
        setReferences([]);
    }, [options.sessionVersion]);

    const active = (job: UploadJob) => {
        try { job.assertInput(); return mountedRef.current && jobsRef.current.includes(job); }
        catch { return false; }
    };
    const occupied = () => referencesRef.current.length + jobsRef.current.filter((job) => job.status !== "failed").length;
    const full = (additional = 0) => optionsRef.current.maxCount !== undefined && occupied() + additional >= optionsRef.current.maxCount;
    const limitMessage = () => `最多添加 ${optionsRef.current.maxCount} 个参考素材，上传中的文件也占用名额；请移除素材后重试`;
    const drain = () => {
        const completed: UploadJob[] = [];
        for (const job of jobsRef.current) {
            if (job.status === "preparing" || job.status === "uploading") break;
            if (job.status === "success" && job.reference && active(job)) completed.push(job);
        }
        if (completed.length) {
            setReferences((current) => [...current, ...completed.map((job) => job.reference!)]);
            jobsRef.current = jobsRef.current.filter((job) => !completed.includes(job));
        }
        publish();
    };
    const run = async (job: UploadJob) => {
        if (!job.source || !active(job)) return;
        try {
            job.status = "preparing";
            job.error = undefined;
            publish();
            const blob = await job.source.prepare();
            if (!active(job)) return;
            job.blob = blob;
            job.status = "uploading";
            publish();
            const media = await uploadGenerationMedia(blob, job.name);
            if (!active(job)) return;
            job.reference = { id: job.id, name: job.name, type: media.mimeType, dataUrl: media.url, storageKey: media.id };
            job.status = "success";
            if (media.mimeType.startsWith("image/")) void ensureImagePreview(media.id);
        } catch (error) {
            if (!active(job)) return;
            job.status = "failed";
            job.error = error instanceof Error ? error.message : "参考素材上传失败";
            job.retryable = true;
        }
        if (active(job)) drain();
    };
    const addSources = (sources: UploadSource[], assertInput = optionsRef.current.captureInputScope(), placeholder?: UploadJob) => {
        assertInput();
        optionsRef.current.onInputChange?.();
        const index = placeholder ? jobsRef.current.indexOf(placeholder) : jobsRef.current.length;
        if (placeholder) jobsRef.current.splice(index, 1);
        const added: UploadJob[] = [];
        const accepted: UploadJob[] = [];
        for (const source of sources) {
            const supported = optionsRef.current.supportsType(source.type);
            const error = !supported ? optionsRef.current.unsupportedMessage : full(accepted.length) ? limitMessage() : undefined;
            const job: UploadJob = { id: nanoid(), name: source.name, source, blob: source.blob, assertInput, status: error ? "failed" : "preparing", error, retryable: supported };
            added.push(job);
            if (!error) accepted.push(job);
        }
        jobsRef.current.splice(index, 0, ...added);
        drain();
        accepted.forEach((job) => void run(job));
    };
    const addFiles = (files?: FileList | File[] | null) => {
        const assertInput = optionsRef.current.captureInputScope();
        addSources(Array.from(files || []).map((file) => ({ name: file.name, type: file.type, blob: file, prepare: async () => file })), assertInput);
    };
    const addClipboard = async () => {
        optionsRef.current.onInputChange?.();
        const assertInput = optionsRef.current.captureInputScope();
        const job: UploadJob = { id: nanoid(), name: "剪贴板素材", status: "preparing", assertInput };
        jobsRef.current.push(job);
        publish();
        try {
            assertInput();
            const items = await navigator.clipboard.read();
            if (!active(job)) return;
            const sources = items.flatMap((item) => item.types.filter((type) => type.startsWith("image/")).map((type) => ({ item, type }))).map(({ item, type }, index) => ({ name: `剪贴板图片-${index + 1}.${type.split("/")[1] || "png"}`, type, prepare: () => item.getType(type) }));
            if (!sources.length) throw new Error("剪贴板中没有可用图片，请复制图片后重新粘贴");
            addSources(sources, assertInput, job);
        } catch (error) {
            if (!active(job)) return;
            job.status = "failed";
            job.error = `${error instanceof Error ? error.message : "无法读取剪贴板"}；请检查浏览器权限后重新粘贴，或改用上传文件`;
            drain();
        }
    };
    const addReference = (reference: ReferenceImage) => {
        optionsRef.current.onInputChange?.();
        const assertInput = optionsRef.current.captureInputScope();
        assertInput();
        const error = full() ? limitMessage() : undefined;
        jobsRef.current.push({ id: nanoid(), name: reference.name, status: error ? "failed" : "success", error, reference, assertInput, retryable: true });
        drain();
    };
    const retry = (id: string) => {
        const job = jobsRef.current.find((item) => item.id === id);
        if (!job || job.status !== "failed" || !job.retryable || !active(job)) return;
        if (full()) { job.error = limitMessage(); publish(); return; }
        jobsRef.current = [...jobsRef.current.filter((item) => item !== job), job];
        if (job.reference) { job.status = "success"; job.error = undefined; drain(); }
        else void run(job);
    };
    const remove = (id: string) => { jobsRef.current = jobsRef.current.filter((job) => job.id !== id); drain(); };
    const hasPending = () => jobsRef.current.some((job) => job.status !== "failed");
    const hasFailures = () => jobsRef.current.some((job) => job.status === "failed");

    const storedUploads = () => jobsRef.current.map(({ id, name, source, blob, reference, error }) => ({ id, name, type: source?.type, blob, reference, error }));
    return { references, setReferences, uploads, addFiles, addSources, addClipboard, addReference, retry, remove, clearUploads, restoreUploads, storedUploads, hasPending, hasFailures };
}

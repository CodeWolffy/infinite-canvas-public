import { useEffect, useRef, useState } from "react";
import { getWorkbenchDraft, saveWorkbenchDraft } from "@/stores/use-workbench-draft-store";
import { readWorkbenchInput, writeWorkbenchInput } from "@/stores/workbench-input-storage";
import { assertCurrentSession, useUserStore } from "@/stores/use-user-store";
import type { AiConfig } from "@/stores/use-config-store";
import type { ReferenceImage } from "@/types/image";
import type { StoredReferenceUpload } from "./use-workbench-reference-uploads";

export const workbenchSettingKeys = {
    image: ["quality", "size", "count", "background"],
    video: ["size", "vquality", "videoSeconds", "videoGenerateAudio", "videoWatermark", "videoMode"],
} as const;

export type WorkbenchInput = { prompt: string; references: ReferenceImage[]; model: string; settings: Partial<AiConfig>; uploads?: StoredReferenceUpload[]; submitted?: string };

export function useWorkbenchInput(capability: "image" | "video", value: Omit<WorkbenchInput, "settings"> & { config: AiConfig }, _initialized: boolean, session: number, options: {
    restore: (input: WorkbenchInput) => void;
    captureInputScope: () => () => void;
}) {
    const memoryRef = useRef({ session, value: getWorkbenchDraft<WorkbenchInput>(capability) });
    if (memoryRef.current.session !== session) memoryRef.current = { session, value: getWorkbenchDraft<WorkbenchInput>(capability) };
    const memory = memoryRef.current.value;
    const submitted = useRef(memory?.submitted || "");
    const settings = Object.fromEntries(workbenchSettingKeys[capability].map((key) => [key, value.config[key]]));
    const input = { prompt: value.prompt, references: value.references, model: value.model, settings, uploads: value.uploads || [] };
    const fingerprint = JSON.stringify(input);
    const latest = useRef({ input, fingerprint, options });
    latest.current = { input, fingerprint, options };
    const mounted = useRef(false);
    const initialScope = useRef<(() => void) | null>(null);
    const [hydratedSession, setHydratedSession] = useState<number | null>(memory ? session : null);
    const hydrated = hydratedSession === session;
    const [loadError, setLoadError] = useState("");
    const [saveError, setSaveError] = useState("");
    const [loadAttempt, setLoadAttempt] = useState(0);
    const [saveAttempt, setSaveAttempt] = useState(0);
    const reading = useRef(!memory);
    const automaticInput = useRef({ prompt: value.prompt, references: value.references, uploads: input.uploads });
    const canRestore = () => {
        try {
            initialScope.current?.();
            const initial = automaticInput.current;
            return initial.prompt === latest.current.input.prompt && JSON.stringify(initial.references) === JSON.stringify(latest.current.input.references) && JSON.stringify(initial.uploads) === JSON.stringify(latest.current.input.uploads);
        }
        catch { return false; }
    };

    useEffect(() => {
        mounted.current = true;
        submitted.current = memory?.submitted || "";
        automaticInput.current = { prompt: latest.current.input.prompt, references: latest.current.input.references, uploads: latest.current.input.uploads };
        setLoadError("");
        setSaveError("");
        initialScope.current = latest.current.options.captureInputScope();
        return () => { mounted.current = false; };
    }, [session]);

    useEffect(() => {
        if (memory && !loadAttempt) return;
        let disposed = false;
        reading.current = true;
        setLoadError("");
        void readWorkbenchInput<WorkbenchInput>(capability, session).then((saved) => {
            if (disposed || useUserStore.getState().sessionVersion !== session) return;
            if (saved && canRestore()) {
                submitted.current = saved.submitted || "";
                latest.current.options.restore(saved);
            }
        }).catch((error) => {
            if (!disposed && useUserStore.getState().sessionVersion === session) setLoadError(`本机草稿读取失败：${error instanceof Error ? error.message : "请重试"}。当前输入仍保留。`);
        }).finally(() => {
            if (!disposed && useUserStore.getState().sessionVersion === session) { reading.current = false; setHydratedSession(session); }
        });
        return () => { disposed = true; };
    }, [capability, session, memory, loadAttempt]);

    useEffect(() => {
        if ((reading.current || !hydrated || loadError) && canRestore()) return;
        const current = { ...latest.current.input, submitted: submitted.current };
        saveWorkbenchDraft(capability, current, session);
        void writeWorkbenchInput(capability, current, session, () => {
            if (latest.current.fingerprint !== fingerprint) throw new DOMException("当前创作输入已改变", "AbortError");
        }).then(() => {
            if (mounted.current && useUserStore.getState().sessionVersion === session && latest.current.fingerprint === fingerprint) setSaveError("");
        }).catch((error) => {
            if (error instanceof DOMException && error.name === "AbortError") return;
            if (mounted.current && useUserStore.getState().sessionVersion === session && latest.current.fingerprint === fingerprint) setSaveError(`本机草稿保存失败：${error instanceof Error ? error.message : "请重试"}。输入仍在当前页面，请暂勿刷新。`);
        });
    }, [capability, fingerprint, hydrated, loadError, saveAttempt, session]);
    return {
        get dirty() { return Boolean(latest.current.input.prompt || latest.current.input.references.length || latest.current.input.uploads.length) && latest.current.fingerprint !== submitted.current; },
        fingerprint,
        isCurrent: (value: string) => latest.current.fingerprint === value,
        submitted: (value: string) => { assertCurrentSession(session); submitted.current = value; setSaveAttempt((attempt) => attempt + 1); },
        hydrated, loadError, saveError,
        retryLoad: () => setLoadAttempt((attempt) => attempt + 1),
        retrySave: () => setSaveAttempt((attempt) => attempt + 1),
    };
}

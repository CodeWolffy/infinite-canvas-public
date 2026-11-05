import { useEffect, useRef } from "react";
import { getWorkbenchDraft, saveWorkbenchDraft } from "@/stores/use-workbench-draft-store";
import type { AiConfig } from "@/stores/use-config-store";
import type { ReferenceImage } from "@/types/image";

export const workbenchSettingKeys = {
    image: ["quality", "size", "count", "background"],
    video: ["size", "vquality", "videoSeconds", "videoGenerateAudio", "videoWatermark", "videoMode"],
} as const;

export type WorkbenchInput = { prompt: string; references: ReferenceImage[]; model: string; settings: Partial<AiConfig>; submitted?: string };

export function useWorkbenchInput(capability: "image" | "video", value: Omit<WorkbenchInput, "settings"> & { config: AiConfig }, initialized: boolean, session: number) {
    const saved = useRef(getWorkbenchDraft<WorkbenchInput>(capability)).current;
    const submitted = useRef(saved?.submitted || "");
    const settings = Object.fromEntries(workbenchSettingKeys[capability].map((key) => [key, value.config[key]]));
    const input = { prompt: value.prompt, references: value.references, model: value.model, settings };
    const fingerprint = JSON.stringify(input);
    const latest = useRef({ input, fingerprint, initialized });
    latest.current = { input, fingerprint, initialized };
    useEffect(() => () => {
        if (latest.current.initialized || latest.current.input.prompt || latest.current.input.references.length) saveWorkbenchDraft(capability, { ...latest.current.input, submitted: submitted.current }, session);
    }, [capability, session]);
    return {
        get dirty() { return Boolean(latest.current.input.prompt || latest.current.input.references.length) && latest.current.fingerprint !== submitted.current; },
        fingerprint,
        submitted: (value: string) => { submitted.current = value; },
    };
}

import i18n from "@/i18n";

export const modelReasoningEfforts = ["low", "medium", "high", "xhigh", "max", "ultra"] as const;
export type ModelReasoningEffort = (typeof modelReasoningEfforts)[number];
export type ReasoningEffort = "auto" | ModelReasoningEffort;
export type ModelReasoning = { reasoningEfforts?: readonly ModelReasoningEffort[] };

export function reasoningEffortLabel(value: ReasoningEffort) {
    return i18n.t(`settingsPanels.common.${value}`);
}

export function modelReasoningOptions(model?: ModelReasoning) {
    return (["auto", ...(model?.reasoningEfforts || [])] as ReasoningEffort[]).map((value) => ({ value, label: reasoningEffortLabel(value) }));
}

export function resolveReasoningEffort(model: ModelReasoning | undefined, value: unknown): ReasoningEffort {
    return model?.reasoningEfforts?.find((effort) => effort === value) || "auto";
}

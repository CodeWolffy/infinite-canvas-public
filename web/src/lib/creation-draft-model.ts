import type { PublicModel } from "@/services/api/generation";
import type { CreationDraftInput } from "@/stores/use-creation-draft-store";

export function resolveCreationDraftModel(models: PublicModel[], input: Pick<CreationDraftInput, "modelId" | "modelName">) {
    const exactId = models.find((model) => model.id === input.modelId || `platform::${model.id}` === input.modelId);
    if (exactId) return { model: exactId, ambiguous: false };
    if (!input.modelName) return { model: undefined, ambiguous: false };
    const matches = [...new Map(models.filter((model) => model.displayName === input.modelName || model.name === input.modelName).map((model) => [model.id, model])).values()];
    return { model: matches.length === 1 ? matches[0] : undefined, ambiguous: matches.length > 1 };
}

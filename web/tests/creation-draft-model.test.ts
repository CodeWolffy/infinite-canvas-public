import { expect, test } from "vitest";

import { resolveCreationDraftModel } from "@/lib/creation-draft-model";
import type { PublicModel } from "@/services/api/generation";

const standard: PublicModel = { id: "standard", name: "same-upstream", displayName: "标准图像模型", capability: "image", price: "0.1", sortOrder: 0, description: null };
const highResolution: PublicModel = { ...standard, id: "4k", displayName: "4K 图像模型", price: "0.5" };

test("精确 ID 和显示名称可区分共用上游名称的价格变体", () => {
    expect(resolveCreationDraftModel([standard, highResolution], { modelId: "4k", modelName: "same-upstream" })).toEqual({ model: highResolution, ambiguous: false });
    expect(resolveCreationDraftModel([standard, highResolution], { modelId: "platform::standard" })).toEqual({ model: standard, ambiguous: false });
    expect(resolveCreationDraftModel([standard, highResolution], { modelName: "4K 图像模型" })).toEqual({ model: highResolution, ambiguous: false });
});

test("原始名称只有唯一匹配时自动带入，多项同名保留待选择状态", () => {
    expect(resolveCreationDraftModel([standard], { modelName: "same-upstream" })).toEqual({ model: standard, ambiguous: false });
    expect(resolveCreationDraftModel([standard, highResolution], { modelName: "same-upstream" })).toEqual({ model: undefined, ambiguous: true });
    expect(resolveCreationDraftModel([standard], { modelName: "SAME-UPSTREAM" })).toEqual({ model: undefined, ambiguous: false });
});

test("显示名与另一配置的原始名称碰撞时保留歧义，明确 ID 才能选择", () => {
    const named = { ...highResolution, displayName: "same-upstream" };
    expect(resolveCreationDraftModel([standard, named], { modelName: "same-upstream" })).toEqual({ model: undefined, ambiguous: true });
    expect(resolveCreationDraftModel([standard, named], { modelId: "4k", modelName: "same-upstream" })).toEqual({ model: named, ambiguous: false });
    expect(resolveCreationDraftModel([named, named], { modelName: "same-upstream" })).toEqual({ model: named, ambiguous: false });
});

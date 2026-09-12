import type { PublicModel } from "@/services/api/generation";

export type ModelPricing = Pick<PublicModel, "capability" | "price" | "pricePerImage" | "inputPricePerMillion" | "cachedPricePerMillion" | "outputPricePerMillion" | "pricePerSecond">;

export function modelPriceLabel(model: ModelPricing): string | null {
    if (model.inputPricePerMillion != null) {
        const cached = model.cachedPricePerMillion == null ? "" : ` / 缓存 ¥${model.cachedPricePerMillion}`;
        return `输入 ¥${model.inputPricePerMillion}${cached} / 输出 ¥${model.outputPricePerMillion} / 百万 token`;
    }
    if (model.pricePerSecond != null) return `¥${model.pricePerSecond} / 秒`;
    const price = model.price ?? model.pricePerImage;
    return price == null || price === "" ? null : `¥${price} / ${model.capability === "image" ? "张" : "次"}`;
}

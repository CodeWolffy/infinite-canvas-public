import { imageQualityOptions } from "@/components/image-settings-panel";
import { computeMediaSize, inferMediaRatio, inferMediaScale, mediaRatioOptions, mediaScaleOptions, parsePixelSize } from "@/lib/media-size";
import { platformImageParameters } from "@/services/api/image";
import type { CreationDraftInput } from "@/stores/use-creation-draft-store";
import type { AiConfig } from "@/stores/use-config-store";

export const IMAGE_WORKBENCH_MAX_COUNT = 20;

export function readImageDraftSettings(input: CreationDraftInput["settings"], config: AiConfig) {
    const settings: Partial<Pick<AiConfig, "size" | "quality" | "count" | "background">> = {};
    const warnings: string[] = [];
    if (input?.size !== undefined) {
        const raw = input.size.trim().toLowerCase();
        const pixels = parsePixelSize(raw);
        const ratio = inferMediaRatio(config.size);
        const size = raw === "auto" ? raw
            : mediaRatioOptions.some((item) => item.value === raw) ? computeMediaSize(inferMediaScale(config.size), raw)
            : mediaScaleOptions.includes(raw as (typeof mediaScaleOptions)[number]) ? computeMediaSize(raw, ratio === "auto" ? "1:1" : ratio)
            : pixels ? `${pixels.width}x${pixels.height}` : "";
        try {
            if (!size) throw new Error("invalid size");
            platformImageParameters({ ...config, size });
            settings.size = size;
        } catch {
            warnings.push("图片尺寸");
        }
    }
    if (input?.quality !== undefined) {
        if (imageQualityOptions.some((option) => option.value === input.quality)) settings.quality = input.quality;
        else warnings.push("图片质量");
    }
    if (input?.count !== undefined) {
        const count = Number(input.count);
        if (Number.isInteger(count) && count > 0 && count <= IMAGE_WORKBENCH_MAX_COUNT) settings.count = String(count);
        else warnings.push("生成张数");
    }
    if (input?.background !== undefined) {
        if (input.background === "" || input.background === "transparent") settings.background = input.background;
        else warnings.push("背景设置");
    }
    return { settings, warnings };
}

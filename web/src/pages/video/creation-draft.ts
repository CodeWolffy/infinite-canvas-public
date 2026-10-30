import { computeVideoSize, parsePixelSize, parseVideoResolution, VIDEO_SECONDS_MAX, VIDEO_SECONDS_MIN, videoRatioOptions } from "@/lib/media-size";
import type { CreationDraftInput } from "@/stores/use-creation-draft-store";
import type { AiConfig } from "@/stores/use-config-store";

export function readVideoDraftSettings(input: CreationDraftInput["settings"], config: AiConfig) {
    const settings: Partial<Pick<AiConfig, "size" | "vquality" | "videoSeconds" | "videoMode">> = {};
    const warnings: string[] = [];
    if (input?.vquality !== undefined) {
        const raw = input.vquality.trim().toLowerCase();
        const resolution = parseVideoResolution(raw);
        if (raw === resolution || raw === `${resolution}p`) settings.vquality = resolution;
        else warnings.push("视频分辨率");
    }
    if (input?.size !== undefined) {
        const raw = input.size.trim().toLowerCase();
        const pixels = parsePixelSize(raw);
        if (raw === "auto") settings.size = raw;
        else if (videoRatioOptions.some((item) => item.value === raw)) settings.size = computeVideoSize(settings.vquality || config.vquality, raw);
        else if (pixels && Number.isInteger(pixels.width) && Number.isInteger(pixels.height) && pixels.width > 0 && pixels.height > 0) settings.size = `${pixels.width}x${pixels.height}`;
        else warnings.push("视频尺寸");
    }
    if (input?.videoSeconds !== undefined) {
        const seconds = Number(input.videoSeconds);
        if (Number.isInteger(seconds) && seconds >= VIDEO_SECONDS_MIN && seconds <= VIDEO_SECONDS_MAX) settings.videoSeconds = String(seconds);
        else warnings.push("视频时长");
    }
    if (input?.videoMode !== undefined) {
        if (input.videoMode === "frames" || input.videoMode === "reference") settings.videoMode = input.videoMode;
        else warnings.push("视频模式");
    }
    return { settings, warnings };
}

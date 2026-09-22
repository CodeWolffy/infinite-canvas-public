import dayjs from "dayjs";

import i18n from "@/i18n";
import type { GenerationBatchListItem, PublicModel } from "@/services/api/generation";
import type { ReferenceImage } from "@/types/image";

/** 生图与视频工作台共享的生成记录结构，页面特有的字段为可选。 */
export type GenerationLog = {
    id: string;
    createdAt: number;
    title: string;
    prompt: string;
    time: string;
    model: string;
    modelId: string;
    config: Record<string, string>;
    references: ReferenceImage[];
    referenceMediaIds: string[];
    durationMs: number;
    status: "pending" | "success" | "failed";
    results: unknown[];
    successCount?: number;
    failCount?: number;
    imageCount?: number;
    size?: string;
    quality?: string;
    resolution?: string;
    seconds?: string;
    images?: Array<{ storageKey?: string; dataUrl: string }>;
    thumbnails?: string[];
    thumbnailMediaIds?: string[];
    video?: { url: string; storageKey?: string };
    error?: string;
};

export type GenerationLogBase = Pick<GenerationLog, "id" | "createdAt" | "title" | "prompt" | "time" | "model" | "modelId">;

/** 批次摘要转记录时两个工作台共用的基础字段。 */
export function summaryLogBase(batch: GenerationBatchListItem, models: PublicModel[]): GenerationLogBase {
    const model = models.find((item) => item.id === batch.modelId);
    return {
        id: batch.id,
        createdAt: new Date(batch.createdAt).getTime(),
        title: batch.prompt.slice(0, 12) || i18n.t("workbench.untitled"),
        prompt: batch.prompt,
        time: new Date(batch.createdAt).toLocaleString(i18n.resolvedLanguage, { hour12: false }),
        model: model?.displayName || model?.name || batch.modelId,
        modelId: batch.modelId,
    };
}

export function moveListItem<T>(items: T[], index: number, offset: number) {
    const targetIndex = index + offset;
    if (targetIndex < 0 || targetIndex >= items.length) return items;
    const next = [...items];
    [next[index], next[targetIndex]] = [next[targetIndex], next[index]];
    return next;
}

export function fileBaseName(text: string) {
    const cleaned = text.trim().replace(/[\\/:*?"<>|]+/g, "").replace(/\s+/g, "-").slice(0, 24);
    return `${cleaned || "image"}-${dayjs().format("YYYYMMDD-HHmmss")}`;
}

export function fileExtension(mimeType?: string) {
    return mimeType?.split("/")[1]?.replace("jpeg", "jpg") || "png";
}

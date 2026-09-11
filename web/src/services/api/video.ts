import { clampVideoSeconds, computeVideoSize } from "@/lib/media-size";
import { readVideoMeta, type UploadedFile } from "@/services/file-storage";
import { assertCurrentSession, useUserStore } from "@/stores/use-user-store";
import { boolConfig, type AiConfig } from "@/stores/use-config-store";
import type { ReferenceImage } from "@/types/image";
import type { ReferenceAudio, ReferenceVideo } from "@/types/media";
import { createGenerationBatch, getPublicModels } from "./generation";
import { ensurePlatformMedia, getGenerationTask, selectedPlatformModel, taskDelay } from "./tasks";

type RequestOptions = { signal?: AbortSignal };
type VideoMediaOptions = RequestOptions & { videos?: ReferenceVideo[]; audios?: ReferenceAudio[]; canvasProjectId?: string };
export type VideoGenerationResult = { blob?: Blob; url?: string; mimeType?: string; file?: UploadedFile };
export type VideoGenerationTask = { id: string; provider: "platform"; model: string };
export type VideoGenerationTaskState = { status: "pending" } | { status: "completed"; result: VideoGenerationResult } | { status: "failed"; error: string };

export async function requestVideoGeneration(config: AiConfig, prompt: string, references: ReferenceImage[] = [], options?: VideoMediaOptions) {
    return waitForVideoGenerationTask(config, await createVideoGenerationTask(config, prompt, references, options), options);
}

export async function createVideoGenerationTask(config: AiConfig, prompt: string, references: ReferenceImage[] = [], options?: VideoMediaOptions): Promise<VideoGenerationTask> {
    const session = useUserStore.getState().sessionVersion;
    const [models, referenceMediaIds] = await Promise.all([
        getPublicModels(),
        Promise.all([...references, ...(options?.videos || []), ...(options?.audios || [])].map((reference) => ensurePlatformMedia(reference, options?.signal))),
    ]);
    assertCurrentSession(session);
    if (options?.signal?.aborted) throw new DOMException("已停止准备", "AbortError");
    const modelId = selectedPlatformModel(models, config.model || config.videoModel, "video");
    const { tasks } = await createGenerationBatch({ modelId, prompt, count: 1, referenceMediaIds, canvasProjectId: options?.canvasProjectId, parameters: {
        seconds: clampVideoSeconds(config.videoSeconds), size: /^\d+x\d+$/.test(config.size) ? config.size : computeVideoSize(config.vquality, config.size), resolution_name: config.vquality,
        mode: config.videoMode, generate_audio: boolConfig(config.videoGenerateAudio, true), watermark: boolConfig(config.videoWatermark, false),
    } });
    assertCurrentSession(session);
    return { id: tasks[0].id, provider: "platform", model: modelId };
}

export async function pollVideoGenerationTask(_config: AiConfig, task: VideoGenerationTask, options?: RequestOptions): Promise<VideoGenerationTaskState> {
    const { task: current } = await getGenerationTask(task.id, options?.signal);
    if (current.status === "failed" || current.status === "canceled") return { status: "failed", error: current.errorMessage || "视频生成未完成" };
    if (current.status !== "succeeded" || !current.output) return { status: "pending" };
    const output = current.output;
    return { status: "completed", result: { url: output.url, mimeType: output.mimeType, file: { url: output.url, storageKey: `media:${output.mediaId}`, bytes: output.bytes, mimeType: output.mimeType, width: output.width ?? undefined, height: output.height ?? undefined } } };
}

export async function waitForVideoGenerationTask(config: AiConfig, task: VideoGenerationTask, options?: RequestOptions): Promise<VideoGenerationResult> {
    const session = useUserStore.getState().sessionVersion;
    for (;;) {
        assertCurrentSession(session);
        const state = await pollVideoGenerationTask(config, task, options);
        if (state.status === "completed") return state.result;
        if (state.status === "failed") { const error = new Error(state.error); error.name = "VideoTaskFailed"; throw error; }
        await taskDelay(options?.signal);
    }
}
export function isVideoTaskFailed(error: unknown) { return error instanceof Error && error.name === "VideoTaskFailed"; }
export async function storeGeneratedVideo(result: VideoGenerationResult): Promise<UploadedFile> {
    if (!result.file) throw new Error("视频结果缺少平台文件记录");
    const session = useUserStore.getState().sessionVersion;
    const metadata = await readVideoMeta(result.file.url);
    assertCurrentSession(session);
    return { ...result.file, ...metadata };
}

import { normalizeAudioFormatValue, normalizeAudioSpeedValue, normalizeAudioVoiceValue } from "@/lib/audio-generation";
import { type UploadedFile } from "@/services/file-storage";
import { assertCurrentSession, useUserStore } from "@/stores/use-user-store";
import type { AiConfig } from "@/stores/use-config-store";
import { createGenerationBatch, getPublicModels } from "./generation";
import { readMedia } from "./media";
import { selectedPlatformModel, waitForGenerationTask } from "./tasks";

const storedAudio = new WeakMap<Blob, UploadedFile>();

export async function requestAudioGeneration(config: AiConfig, prompt: string, options?: { signal?: AbortSignal; canvasProjectId?: string; onTaskCreated?: (id: string) => void }): Promise<Blob> {
    const session = useUserStore.getState().sessionVersion;
    const models = await getPublicModels();
    assertCurrentSession(session);
    if (options?.signal?.aborted) throw new DOMException("已停止准备", "AbortError");
    const modelId = selectedPlatformModel(models, config.model || config.audioModel, "audio");
    const { tasks } = await createGenerationBatch({ modelId, prompt, count: 1, referenceMediaIds: [], canvasProjectId: options?.canvasProjectId, parameters: {
        voice: normalizeAudioVoiceValue(config.audioVoice), response_format: normalizeAudioFormatValue(config.audioFormat), speed: Number(normalizeAudioSpeedValue(config.audioSpeed)), instructions: config.audioInstructions,
    } });
    assertCurrentSession(session);
    options?.onTaskCreated?.(tasks[0].id);
    const task = await waitForGenerationTask(tasks[0].id, options?.signal);
    if (!task.output) throw new Error("音频结果缺少平台文件记录");
    const output = task.output;
    const blob = await readMedia(output.mediaId);
    assertCurrentSession(session);
    storedAudio.set(blob, { url: output.url, storageKey: `media:${output.mediaId}`, bytes: output.bytes, mimeType: output.mimeType });
    return blob;
}

export async function storeGeneratedAudio(blob: Blob, _format = "mp3"): Promise<UploadedFile> {
    const file = storedAudio.get(blob);
    if (!file) throw new Error("音频结果缺少平台文件记录");
    return file;
}

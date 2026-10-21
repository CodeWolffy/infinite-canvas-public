import i18n from "@/i18n";
import { findChannelModel, modelOptionName, type AiConfig } from "@/stores/use-config-store";
import { createGenerationBatch, getGenerationBatch, uploadGenerationMedia, type GenerationBatchDetail } from "@/services/api/generation";
import { fetchPublicModels } from "@/hooks/use-public-models";
import { mediaId } from "@/services/api/media";
import { createTextConversation, createTextRequest } from "@/services/api/text";
import { buildImageReferencePromptText } from "@/lib/image-reference-prompt";
import { imageSizePresets, inferMediaScale } from "@/lib/media-size";
import type { ReferenceImage } from "@/types/image";
import { assertCurrentSession, useUserStore } from "@/stores/use-user-store";
import { resolveReasoningEffort } from "@/lib/model-reasoning";

const apiText = (key: string, options?: Record<string, unknown>) => i18n.t(`apiErrors.${key}`, options);

export type AiTextMessage = {
    role: "system" | "user" | "assistant";
    content: string | Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }>;
};

type RequestOptions = {
    signal?: AbortSignal;
    canvasProjectId?: string;
    conversationId?: string;
    onConversationCreated?: (conversationId: string) => void;
    onTextRequestPrepared?: (requestId: string, conversationId: string) => void;
    onTextRequestSkipped?: () => void;
    onBatchCreated?: (detail: GenerationBatchDetail) => void;
    onTasksUpdated?: (detail: GenerationBatchDetail) => void;
};

const IMAGE_QUALITY_VALUES = ["low", "medium", "high", "xhigh", "max"];
const DEFAULT_IMAGE_SHORT_SIDE = 1024;
const IMAGE_SIZE_STEP = 16;
const IMAGE_MIN_PIXELS = 655360;
const IMAGE_MAX_PIXELS = 8294400;
const IMAGE_MAX_EDGE = 3840;
const IMAGE_MAX_RATIO = 3;
const BATCH_POLL_BASE_MS = 700;
const BATCH_POLL_MAX_MS = 3000;
const BATCH_MAX_WAIT_MS = 10 * 60 * 1000;

function normalizeQuality(quality: string) {
    const value = quality.trim().toLowerCase();
    return IMAGE_QUALITY_VALUES.includes(value) ? value : undefined;
}

/** Only "transparent" is forwarded; any other value (incl. empty) means keep the default opaque background. */
function normalizeBackground(background: string | undefined) {
    return background?.trim().toLowerCase() === "transparent" ? "transparent" : undefined;
}

/** Map a bare ratio to a 1K size; quality is independent of resolution. */
function resolveSize(ratio: string): string {
    const parsedRatio = parseImageRatio(ratio);
    const preset = imageSizePresets["1k"][ratio];
    if (preset) return preset;
    const isLandscape = parsedRatio.width >= parsedRatio.height;
    const longRatio = isLandscape ? parsedRatio.width / parsedRatio.height : parsedRatio.height / parsedRatio.width;
    const shortSide = DEFAULT_IMAGE_SHORT_SIDE;
    const longSide = Math.round((shortSide * longRatio) / IMAGE_SIZE_STEP) * IMAGE_SIZE_STEP;
    const width = isLandscape ? longSide : shortSide;
    const height = isLandscape ? shortSide : longSide;
    validateImageSize(width, height);
    return `${width}x${height}`;
}

function parseRatioValue(value: string) {
    const parts = value.split(":");
    if (parts.length !== 2) throw new Error(apiText("invalidImageSizeFormat"));
    const w = Number(parts[0]);
    const h = Number(parts[1]);
    if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) throw new Error(apiText("positiveImageRatio"));
    return { width: w, height: h };
}

function parseImageRatio(value: string) {
    const ratio = parseRatioValue(value);
    if (Math.max(ratio.width, ratio.height) / Math.min(ratio.width, ratio.height) > IMAGE_MAX_RATIO) throw new Error(apiText("imageRatioLimit"));
    return ratio;
}

function parseImageDimensions(value: string) {
    const match = value.match(/^(\d+)x(\d+)$/i);
    if (!match) return null;
    return { width: Number(match[1]), height: Number(match[2]) };
}

function validateImageSize(width: number, height: number) {
    if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) throw new Error(apiText("positiveImageDimensions"));
    if (width % IMAGE_SIZE_STEP !== 0 || height % IMAGE_SIZE_STEP !== 0) throw new Error(apiText("imageDimensionStep"));
    if (Math.max(width, height) > IMAGE_MAX_EDGE) throw new Error(apiText("imageEdgeLimit"));
    if (Math.max(width, height) / Math.min(width, height) > IMAGE_MAX_RATIO) throw new Error(apiText("imageRatioLimit"));
    const pixels = width * height;
    if (pixels < IMAGE_MIN_PIXELS || pixels > IMAGE_MAX_PIXELS) throw new Error(apiText("imagePixelLimit"));
}

function resolveRequestSize(size: string) {
    const value = size.trim();
    if (!value || value.toLowerCase() === "auto") return undefined;
    const dimensions = parseImageDimensions(value);
    if (dimensions) {
        validateImageSize(dimensions.width, dimensions.height);
        return `${dimensions.width}x${dimensions.height}`;
    }
    if (value.includes(":")) return resolveSize(value);
    throw new Error(apiText("invalidImageSizeFormat"));
}

export async function requestGeneration(config: AiConfig, prompt: string, options?: RequestOptions) {
    const n = Math.max(1, Math.min(15, Math.floor(Math.abs(Number(config.count)) || 1)));
    return requestPlatformImages(config, prompt, [], n, options);
}

export async function requestEdit(config: AiConfig, prompt: string, references: ReferenceImage[], options?: RequestOptions) {
    const n = Math.max(1, Math.min(15, Math.floor(Math.abs(Number(config.count)) || 1)));
    const requestPrompt = buildImageReferencePromptText(prompt, references);
    return requestPlatformImages(config, requestPrompt, references, n, options);
}

export async function requestImageQuestion(config: AiConfig, messages: AiTextMessage[], onDelta: (text: string) => void, options?: RequestOptions) {
    const sessionVersion = useUserStore.getState().sessionVersion;
    const throwIfAborted = () => {
        assertCurrentSession(sessionVersion);
        if (!options?.signal?.aborted) return;
        options.onTextRequestSkipped?.();
        throw new DOMException("Aborted", "AbortError");
    };
    throwIfAborted();
    let conversationId = options?.conversationId;
    if (!conversationId) {
        conversationId = (await createTextConversation({ canvasProjectId: options?.canvasProjectId, title: textMessageContent(messages.at(-1)?.content || "新对话").slice(0, 80) || "新对话" })).id;
        throwIfAborted();
        options?.onConversationCreated?.(conversationId);
    }
    throwIfAborted();
    const inputMessages = messages.filter((message) => message.role !== "system");
    const requestMessages = options?.conversationId ? inputMessages.slice(-1) : inputMessages;
    const content = requestMessages.map((message) => textMessageContent(message.content)).join("\n\n");
    const systemPrompt = [config.systemPrompt, ...messages.filter((message) => message.role === "system").map((message) => textMessageContent(message.content))].filter(Boolean).join("\n\n");
    const [attachmentMediaIds, modelId] = await Promise.all([
        Promise.all(
            requestMessages.flatMap((message) =>
                Array.isArray(message.content)
                    ? message.content.flatMap((item, index) =>
                          item.type === "image_url"
                              ? [ensureReferenceMedia({ id: `${index}`, name: `attachment-${index + 1}.png`, type: "image/png", dataUrl: item.image_url.url })]
                              : [],
                      )
                    : [],
            ),
        ),
        resolvePlatformModelId(config.model || config.textModel, "text"),
    ]);
    throwIfAborted();
    const requestId = crypto.randomUUID();
    options?.onTextRequestPrepared?.(requestId, conversationId);
    const effort = resolveReasoningEffort(findChannelModel(config, config.model || config.textModel)?.model, config.reasoningEffort);
    const request = createTextRequest({
        requestId,
        conversationId,
        modelId,
        canvasProjectId: options?.canvasProjectId,
        content,
        systemPrompt,
        attachmentMediaIds,
        parameters: effort === "auto" ? {} : { reasoningEffort: effort },
    }, options?.signal, onDelta);
    const response = options?.signal ? await waitForTextRequest(request, options.signal) : await request;
    assertCurrentSession(sessionVersion);
    if (options?.signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const answer = response.message.content || apiText("noContent");
    onDelta(answer);
    return answer;
}

function waitForTextRequest<T>(request: Promise<T>, signal: AbortSignal) {
    return new Promise<T>((resolve, reject) => {
        const onAbort = () => {
            signal.removeEventListener("abort", onAbort);
            reject(new DOMException("Aborted", "AbortError"));
        };
        if (signal.aborted) return onAbort();
        signal.addEventListener("abort", onAbort, { once: true });
        request.then(
            (value) => {
                signal.removeEventListener("abort", onAbort);
                resolve(value);
            },
            (error) => {
                signal.removeEventListener("abort", onAbort);
                reject(error);
            },
        );
    });
}

function sleepWithSignal(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) {
            reject(new DOMException("Aborted", "AbortError"));
            return;
        }
        const timer = window.setTimeout(() => {
            if (signal) signal.removeEventListener("abort", onAbort);
            resolve();
        }, ms);
        const onAbort = () => {
            window.clearTimeout(timer);
            reject(new DOMException("Aborted", "AbortError"));
        };
        if (signal) {
            signal.addEventListener("abort", onAbort, { once: true });
        }
    });
}

async function requestPlatformImages(config: AiConfig, prompt: string, references: ReferenceImage[], count: number, options?: RequestOptions) {
    const sessionVersion = useUserStore.getState().sessionVersion;
    const throwIfAborted = () => {
        assertCurrentSession(sessionVersion);
        if (options?.signal?.aborted) throw new DOMException("Aborted", "AbortError");
    };
    throwIfAborted();
    const [referenceMediaIds, modelId] = await Promise.all([
        Promise.all(references.map(ensureReferenceMedia)),
        resolvePlatformModelId(config.model || config.imageModel, "image"),
    ]);
    throwIfAborted();
    const created = await createGenerationBatch({
        modelId,
        canvasProjectId: options?.canvasProjectId,
        prompt,
        count,
        referenceMediaIds,
        parameters: platformImageParameters(config),
    });
    assertCurrentSession(sessionVersion);
    options?.onBatchCreated?.({ ...created, referenceMediaIds });
    const pollStartedAt = Date.now();
    let pollInterval = BATCH_POLL_BASE_MS;
    let consecutiveNetworkErrors = 0;
    for (;;) {
        throwIfAborted();
        let detail: GenerationBatchDetail | undefined;
        try {
            detail = await getGenerationBatch(created.batch.id);
            throwIfAborted();
            consecutiveNetworkErrors = 0;
        } catch (error) {
            throwIfAborted();
            consecutiveNetworkErrors += 1;
            if (consecutiveNetworkErrors >= 20) throw error;
        }
        if (detail) {
            options?.onTasksUpdated?.(detail);
            if (detail.tasks.every((task) => task.status !== "reviewing" && task.status !== "queued" && task.status !== "running")) {
                const images = detail.tasks.flatMap((task) => (task.status === "succeeded" && task.image ? [{
                    id: task.id,
                    dataUrl: task.image.url,
                    storageKey: task.image.mediaId,
                    width: task.image.width || undefined,
                    height: task.image.height || undefined,
                    bytes: task.image.bytes || undefined,
                    mimeType: task.image.mimeType,
                }] : []));
                if (images.length) return images;
                throw new Error(detail.tasks.find((task) => task.errorMessage)?.errorMessage || apiText("requestFailed"));
            }
        }
        if (Date.now() - pollStartedAt > BATCH_MAX_WAIT_MS) {
            throw new Error("生成等待超时，任务仍在后台执行，请稍后在生成记录中查看结果");
        }
        await sleepWithSignal(pollInterval, options?.signal);
        pollInterval = Math.min(pollInterval + 500, BATCH_POLL_MAX_MS);
    }
}

export function platformImageParameters(config: AiConfig) {
    const size = resolveRequestSize(config.size || "auto");
    const quality = normalizeQuality(config.quality || "");
    const background = normalizeBackground(config.background);
    return { ...(size ? { size } : {}), resolution: inferMediaScale(config.size), ...(quality ? { quality } : {}), ...(background ? { background } : {}) };
}

async function ensureReferenceMedia(image: ReferenceImage) {
    const sessionVersion = useUserStore.getState().sessionVersion;
    const existing = image.storageKey ? mediaId(image.storageKey) : mediaIdFromUrl(image.dataUrl || image.url || "")[0];
    if (existing) return existing;
    const blob = await (await fetch(image.dataUrl || image.url || "")).blob();
    assertCurrentSession(sessionVersion);
    return (await uploadGenerationMedia(blob, image.name || "reference.png")).id;
}

function mediaIdFromUrl(url: string) {
    const match = url.match(/\/api\/media\/([0-9a-f-]{36})/i);
    return match?.[1] ? [match[1]] : [];
}

function textMessageContent(content: AiTextMessage["content"]) {
    if (!Array.isArray(content)) return content;
    return content.map((item) => (item.type === "text" ? item.text : "[图片附件]")).join("\n");
}

async function resolvePlatformModelId(value: string, capability: "image" | "text") {
    const models = await fetchPublicModels();
    const name = modelOptionName(value);
    const model = models.find((item) => item.capability === capability && (item.id === value || item.id === name));
    if (!model) throw new Error(capability === "image" ? "暂无可用图片模型" : "暂无可用文本模型");
    return model.id;
}

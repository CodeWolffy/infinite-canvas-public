import { lookup } from "node:dns";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP, type LookupFunction } from "node:net";
import { fileTypeFromBuffer } from "file-type";
import type { ChannelCandidate } from "./channel-scheduler.js";
import { UpstreamError } from "./channel-scheduler.js";
import { config } from "./config.js";

type ReferenceImage = { buffer: Buffer; mimeType: string; filename: string };
type TextImage = { buffer: Buffer; mimeType: string };
type TextMessage = { role: string; content: string; images?: TextImage[] };
const geminiAspectRatios = ["1:1", "1:4", "1:8", "2:3", "3:2", "3:4", "4:1", "4:3", "4:5", "5:4", "8:1", "9:16", "16:9", "21:9"];
const maxGeneratedMb = Math.round(config.MAX_GENERATED_BYTES / (1024 * 1024));

function decodeBase64Image(value: string) {
  if (value.length > Math.ceil(config.MAX_GENERATED_BYTES * 4 / 3) + 16) {
    throw new UpstreamError(`生成图片超过 ${maxGeneratedMb}MB`, "image_too_large", undefined, "never");
  }
  return Buffer.from(value, "base64");
}

function endpoint(baseUrl: string, path: string) {
  return `${baseUrl.replace(/\/$/, "")}/${path.replace(/^\//, "")}`;
}

function geminiEndpoint(baseUrl: string, path: string) {
  let base = baseUrl.replace(/\/$/, "");
  if (!base.includes("/v1beta") && !base.includes("/v1")) {
    base = `${base}/v1beta`;
  }
  return `${base}/${path.replace(/^\//, "")}`;
}

function geminiHeaders(apiKey?: string): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (!apiKey) return headers;
  headers["x-goog-api-key"] = apiKey;
  // 针对 NewAPI / OneAPI 等中转站分配的 sk- 令牌，同时兼容 Authorization: Bearer 头
  if (apiKey.startsWith("sk-")) {
    headers["Authorization"] = `Bearer ${apiKey}`;
  }
  return headers;
}

function openAIParameters(parameters: Record<string, unknown>, reserved: string[]) {
  return Object.fromEntries(Object.entries(parameters).filter(([key]) => !reserved.includes(key)));
}

function closestGeminiAspectRatio(width: number, height: number) {
  const target = width / height;
  return geminiAspectRatios.reduce((best, item) => {
    const ratio = (value: string) => value.split(":").map(Number).reduce((left, right) => left / right);
    return Math.abs(ratio(item) - target) < Math.abs(ratio(best) - target) ? item : best;
  });
}

/** Gemini only accepts the 1K/2K/4K tokens, so an explicit pixel size has to be mapped onto them. */
function geminiImageSizeFromEdge(edge: number) {
  if (edge <= 1536) return "1K";
  if (edge <= 3072) return "2K";
  return "4K";
}

/**
 * Resolve generationConfig.imageConfig.imageSize. Quality wins when it is set, otherwise the
 * requested pixel dimensions decide the tier — without this, an explicit 2048x2048 request would
 * only carry its aspect ratio and Gemini would fall back to its 1K default.
 */
function resolveGeminiImageSize(quality: unknown, dimensions: { width: number; height: number } | null) {
  const value = typeof quality === "string" ? quality.trim().toLowerCase() : "";
  if (value === "low" || value === "standard" || value === "1k") return "1K";
  if (value === "medium" || value === "hd" || value === "2k") return "2K";
  if (value === "high" || value === "4k") return "4K";
  return dimensions ? geminiImageSizeFromEdge(Math.max(dimensions.width, dimensions.height)) : undefined;
}

/**
 * imageConfig.imageSize is only supported by the Gemini 3 image models; older ones reject it.
 * Relay gateways often rename these, so the nano-banana aliases are matched too.
 */
function supportsGeminiImageSize(model: string) {
  const value = model.toLowerCase();
  return value.includes("gemini-3") || value.includes("3.1") || value.includes("3-pro") || value.includes("nano-banana");
}

function upstreamMessage(message: string, apiKey?: string) {
  const redact = (text: string) => apiKey
    ? text.replaceAll(JSON.stringify(apiKey).slice(1, -1), "[REDACTED]").replaceAll(apiKey, "[REDACTED]")
    : text;
  try {
    const value = JSON.parse(message) as { error?: { message?: unknown } | unknown; message?: unknown };
    const error = value?.error;
    const nested = error && typeof error === "object" ? (error as { message?: unknown }).message : undefined;
    const text = nested ?? value?.message;
    if (typeof text === "string" && text.trim()) return redact(text).trim().slice(0, 1000);
    message = JSON.stringify(value);
  } catch {
    // Keep plain-text upstream responses as-is.
  }
  return redact(message).slice(0, 2000).trim().replace(/\s+/g, " ").slice(0, 1000);
}

const contentPolicyReasons = new Set(["SAFETY", "IMAGE_SAFETY", "IMAGE_PROHIBITED_CONTENT", "PROHIBITED_CONTENT", "BLOCKLIST", "SPII", "RECITATION", "CONTENT_POLICY_VIOLATION", "CONTENT_FILTER", "MODERATION_BLOCKED"]);

function hasContentPolicyRefusal(value: unknown) {
  if (!value || typeof value !== "object") return false;
  const payload = value as {
    error?: { code?: unknown; type?: unknown };
    promptFeedback?: { blockReason?: unknown };
    candidates?: Array<{ finishReason?: string }>;
    choices?: Array<{ finish_reason?: string; message?: { refusal?: unknown } }>;
  };
  const blockReason = payload.promptFeedback?.blockReason;
  return [payload.error?.code, payload.error?.type].some((code) => typeof code === "string" && contentPolicyReasons.has(code.toUpperCase()))
    || (typeof blockReason === "string" && Boolean(blockReason) && blockReason !== "BLOCK_REASON_UNSPECIFIED")
    || (Array.isArray(payload.candidates) && payload.candidates.some((candidate) => candidate && contentPolicyReasons.has(candidate.finishReason || "")))
    || (Array.isArray(payload.choices) && payload.choices.some((choice) => choice?.finish_reason === "content_filter" || (typeof choice?.message?.refusal === "string" && Boolean(choice.message.refusal.trim()))));
}

function contentPolicyError(status: number) {
  return new UpstreamError("内容审核拒绝：上游判定提示词或参考图不安全，请修改后重试", "content_policy", status, "never");
}

function classifyHttp(status: number, message: string, apiKey?: string) {
  const detail = upstreamMessage(message, apiKey);
  const lower = detail.toLowerCase();
  let structuredRefusal = false;
  try {
    structuredRefusal = hasContentPolicyRefusal(JSON.parse(message));
  } catch {
    // Plain-text errors are classified by their explicit refusal wording below.
  }
  const contentPolicy =
    status === 451 ||
    structuredRefusal ||
    (/content[ _-](?:policy|safety|moderation)|safety system/.test(lower) && /\b(?:violation|unsafe|rejected|rejection|blocked|refused)\b/.test(lower)) ||
    lower.includes("prompt is considered unsafe") ||
    lower.includes("prompt considered unsafe") ||
    lower.includes("cannot be used to generate content");
  if (contentPolicy) {
    return contentPolicyError(status);
  }
  if (status === 429 || status >= 500 || status === 401 || status === 403) {
    return new UpstreamError(`上游返回 HTTP ${status}${detail ? `：${detail}` : ""}`, `http_${status}`, status, "always");
  }
  if (status >= 400 && status < 500) {
    return new UpstreamError(`上游返回 HTTP ${status}${detail ? `：${detail}` : ""}`, "invalid_request", status, "never");
  }
  return new UpstreamError(`上游响应异常${detail ? `：${detail}` : ""}`, "upstream_error", status, "once");
}

async function upstreamJson(candidate: ChannelCandidate, url: string, init: RequestInit) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), candidate.timeoutMs);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    if (!response.ok) {
      throw classifyHttp(response.status, await response.text(), candidate.apiKey);
    }
    const payload = await response.json();
    if (hasContentPolicyRefusal(payload)) throw contentPolicyError(response.status);
    return payload;
  } catch (error) {
    if (error instanceof UpstreamError) throw error;
    if (error instanceof SyntaxError) throw new UpstreamError("上游响应不是有效 JSON", "invalid_response", undefined, "once");
    if (error instanceof Error && error.name === "AbortError") {
      throw new UpstreamError("上游请求超时", "timeout", undefined, "always");
    }
    throw new UpstreamError("无法连接上游", "network", undefined, "always");
  } finally {
    clearTimeout(timeout);
  }
}

async function decodeImageResponse(value: unknown) {
  if (!value || typeof value !== "object") throw new UpstreamError("上游未返回图片", "invalid_response", undefined, "once");
  const data = (value as { data?: unknown }).data;
  if (Array.isArray(data) && data[0] && typeof data[0] === "object") {
    const first = data[0] as { b64_json?: unknown; url?: unknown };
    if (typeof first.b64_json === "string") return decodeBase64Image(first.b64_json);
    if (typeof first.url === "string") return downloadImage(first.url);
  }
  const candidates = (value as { candidates?: unknown }).candidates;
  if (Array.isArray(candidates)) {
    for (const candidate of candidates) {
      const parts = (candidate as { content?: { parts?: unknown } })?.content?.parts;
      if (!Array.isArray(parts)) continue;
      for (const part of parts) {
        const inline = (part as { inlineData?: { data?: unknown }; inline_data?: { data?: unknown } }).inlineData ??
          (part as { inline_data?: { data?: unknown } }).inline_data;
        if (inline && typeof inline.data === "string") return decodeBase64Image(inline.data);
        const fileData = (part as { fileData?: { fileUri?: unknown }; file_data?: { file_uri?: unknown } }).fileData ??
          (part as { file_data?: { file_uri?: unknown } }).file_data;
        const fileUri = fileData && ("fileUri" in fileData ? fileData.fileUri : "file_uri" in fileData ? fileData.file_uri : undefined);
        if (typeof fileUri === "string") return downloadImage(fileUri);
      }
    }
  }
  throw new UpstreamError("上游未返回图片", "invalid_response", undefined, "once");
}

export async function readStreamWithLimit(
  stream: NodeJS.ReadableStream | AsyncIterable<Uint8Array | Buffer>,
  maxBytes: number,
  errorMessage: string,
  errorCategory = "media_too_large",
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for await (const chunk of stream) {
      total += chunk.length;
      if (total > maxBytes) {
        if ("destroy" in stream && typeof (stream as { destroy?: () => void }).destroy === "function") {
          (stream as { destroy: () => void }).destroy();
        }
        throw new UpstreamError(errorMessage, errorCategory, undefined, "never");
      }
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks, total);
  } catch (error) {
    if ("destroy" in stream && typeof (stream as { destroy?: () => void }).destroy === "function") {
      (stream as { destroy: () => void }).destroy();
    }
    throw error;
  }
}

const blockedImageAddresses = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["127.0.0.0", 8], ["169.254.0.0", 16],
  ["172.16.0.0", 12], ["192.168.0.0", 16], ["100.64.0.0", 10], ["198.18.0.0", 15], ["224.0.0.0", 3],
] as const) blockedImageAddresses.addSubnet(address, prefix, "ipv4");
blockedImageAddresses.addAddress("::", "ipv6");
blockedImageAddresses.addAddress("::1", "ipv6");
for (const [address, prefix] of [["fc00::", 7], ["fe80::", 10], ["ff00::", 8]] as const) {
  blockedImageAddresses.addSubnet(address, prefix, "ipv6");
}

function isBlockedAddress(address: string) {
  const family = isIP(address);
  return !family || blockedImageAddresses.check(address, family === 6 ? "ipv6" : "ipv4");
}

function blockedImageHost() {
  return new UpstreamError("生成图片地址指向内网，已拒绝下载", "blocked_image_host", undefined, "never");
}

// Validate the addresses passed to the socket so DNS cannot change between validation and connection.
const lookupImageHost: LookupFunction = (hostname, options, callback) => {
  lookup(hostname, { ...options, all: true }, (error, addresses) => {
    if (error) return callback(error, []);
    if (!addresses.length || (!config.ALLOW_PRIVATE_IMAGE_HOSTS && addresses.some(({ address }) => isBlockedAddress(address)))) {
      return callback(blockedImageHost(), []);
    }
    callback(null, options.all ? addresses : addresses[0]!.address, addresses[0]!.family);
  });
};

function requestImage(target: URL, signal: AbortSignal) {
  if ((target.protocol !== "https:" && target.protocol !== "http:") || target.username || target.password) {
    throw new UpstreamError("生成图片地址协议或凭据不受支持", "invalid_image_url", undefined, "never");
  }
  const hostname = target.hostname.replace(/^\[|\]$/g, "");
  if (!config.ALLOW_PRIVATE_IMAGE_HOSTS && isIP(hostname) && isBlockedAddress(hostname)) throw blockedImageHost();
  return new Promise<IncomingMessage>((resolve, reject) => {
    const request = (target.protocol === "https:" ? httpsRequest : httpRequest)(target, {
      signal,
      lookup: lookupImageHost,
      headers: { "Accept-Encoding": "identity" },
    }, resolve);
    request.on("error", reject);
    request.end();
  });
}

export async function downloadImage(url: string) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120000);
  let response: IncomingMessage | undefined;
  try {
    // 手动跟随跳转并逐跳校验，避免 302 指向内网绕过主机检查。
    let target = new URL(url);
    for (let hop = 0; hop < 4 && !response; hop += 1) {
      const hopResponse = await requestImage(target, controller.signal);
      const status = hopResponse.statusCode ?? 0;
      const location = status >= 300 && status < 400 ? hopResponse.headers.location : undefined;
      if (!location) {
        response = hopResponse;
        break;
      }
      hopResponse.destroy();
      target = new URL(location, target);
    }
    if (!response) throw new UpstreamError("生成图片跳转次数过多", "image_download", undefined, "once");
    const status = response.statusCode ?? 0;
    if (status < 200 || status >= 300) throw new UpstreamError("生成图片下载失败", "image_download", status, "once");
    const length = Number(response.headers["content-length"] ?? 0);
    if (length > config.MAX_GENERATED_BYTES) throw new UpstreamError(`生成图片超过 ${maxGeneratedMb}MB`, "image_too_large", undefined, "never");
    return await readStreamWithLimit(response, config.MAX_GENERATED_BYTES, `生成图片超过 ${maxGeneratedMb}MB`, "image_too_large");
  } finally {
    clearTimeout(timeout);
    response?.destroy();
  }
}

export async function validateGeneratedImage(buffer: Buffer) {
  if (!buffer.length || buffer.length > config.MAX_GENERATED_BYTES) {
    throw new UpstreamError("生成图片大小无效", "image_too_large", undefined, "never");
  }
  const detected = await fileTypeFromBuffer(buffer);
  if (!detected || !["image/png", "image/jpeg", "image/webp"].includes(detected.mime)) {
    throw new UpstreamError("生成结果不是受支持的图片", "invalid_image", undefined, "once");
  }
  return detected;
}

export async function generateImage(
  candidate: ChannelCandidate,
  prompt: string,
  parameters: Record<string, unknown>,
  references: ReferenceImage[],
) {
  if (candidate.protocol === "openai") {
    const safeParameters = openAIParameters(parameters, ["model", "prompt", "n", "response_format", "image", "image[]"]);
    const headers = candidate.apiKey ? { Authorization: `Bearer ${candidate.apiKey}` } : undefined;
    if (references.length) {
      const isGptImage = /^gpt-image/i.test(candidate.upstreamModel);
      const form = new FormData();
      for (const [key, value] of Object.entries(safeParameters)) {
        if (value !== undefined && value !== null) form.set(key, String(value));
      }
      form.set("model", candidate.upstreamModel);
      form.set("prompt", prompt);
      form.set("n", "1");
      if (!isGptImage) {
        form.set("response_format", "b64_json");
      }
      for (const reference of references) {
        form.append("image", new Blob([new Uint8Array(reference.buffer)], { type: reference.mimeType }), reference.filename);
      }
      const response = await upstreamJson(candidate, endpoint(candidate.baseUrl, "images/edits"), {
        method: "POST",
        headers,
        body: form,
      });
      return decodeImageResponse(response);
    }
    const isGptImage = /^gpt-image/i.test(candidate.upstreamModel);
    const response = await upstreamJson(candidate, endpoint(candidate.baseUrl, "images/generations"), {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify({
        ...safeParameters,
        model: candidate.upstreamModel,
        prompt,
        n: 1,
        ...(isGptImage ? {} : { response_format: "b64_json" }),
      }),
    });
    return decodeImageResponse(response);
  }

  const parts: Array<Record<string, unknown>> = [{ text: prompt }];
  for (const reference of references) {
    parts.push({ inlineData: { mimeType: reference.mimeType, data: reference.buffer.toString("base64") } });
  }
  const url = new URL(geminiEndpoint(candidate.baseUrl, `models/${encodeURIComponent(candidate.upstreamModel)}:generateContent`));
  const { size, quality, background: _background, ...geminiParameters } = parameters;
  const match = typeof size === "string" ? size.match(/^(\d+)x(\d+)$/) : null;
  const dimensions = match ? { width: Number(match[1]), height: Number(match[2]) } : null;
  const qualitySize = supportsGeminiImageSize(candidate.upstreamModel)
    ? resolveGeminiImageSize(quality, dimensions)
    : undefined;
  const image = {
    ...(dimensions ? { aspectRatio: closestGeminiAspectRatio(dimensions.width, dimensions.height) } : {}),
    ...(qualitySize ? { imageSize: qualitySize } : {}),
  };
  const response = await upstreamJson(candidate, url.toString(), {
    method: "POST",
    headers: geminiHeaders(candidate.apiKey),
    body: JSON.stringify({
      contents: [{ role: "user", parts }],
      generationConfig: {
        ...geminiParameters,
        ...(Object.keys(image).length ? { imageConfig: image } : {}),
        responseModalities: ["TEXT", "IMAGE"],
      },
    }),
  });
  return decodeImageResponse(response);
}

export async function generateText(
  candidate: ChannelCandidate,
  messages: TextMessage[],
  parameters: Record<string, unknown>,
) {
  const { reasoningEffort, ...textParameters } = parameters;
  if (candidate.protocol === "openai") {
    const safeParameters = openAIParameters(textParameters, ["model", "messages", "stream"]);
    const upstreamMessages = messages.map((message) =>
      message.images?.length
        ? {
            role: message.role,
            content: [
              { type: "text", text: message.content },
              ...message.images.map((image) => ({
                type: "image_url",
                image_url: { url: `data:${image.mimeType};base64,${image.buffer.toString("base64")}` },
              })),
            ],
          }
        : { role: message.role, content: message.content },
    );
    const value = (await upstreamJson(candidate, endpoint(candidate.baseUrl, "chat/completions"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(candidate.apiKey ? { Authorization: `Bearer ${candidate.apiKey}` } : {}),
      },
      body: JSON.stringify({
        ...safeParameters,
        ...(typeof reasoningEffort === "string" ? { reasoning_effort: reasoningEffort } : {}),
        model: candidate.upstreamModel,
        messages: upstreamMessages,
        stream: false,
      }),
    })) as { choices?: Array<{ message?: { content?: unknown } }> } | null;
    const content = Array.isArray(value?.choices) ? value.choices[0]?.message?.content : undefined;
    if (typeof content !== "string") throw new UpstreamError("上游未返回文本", "invalid_response", undefined, "once");
    return content;
  }

  const system = messages.filter((item) => item.role === "system").map((item) => item.content).join("\n");
  const contents = messages
    .filter((item) => item.role !== "system")
    .map((item) => ({
      role: item.role === "assistant" ? "model" : "user",
      parts: [
        { text: item.content },
        ...(item.images ?? []).map((image) => ({
          inlineData: { mimeType: image.mimeType, data: image.buffer.toString("base64") },
        })),
      ],
    }));
  const url = new URL(geminiEndpoint(candidate.baseUrl, `models/${encodeURIComponent(candidate.upstreamModel)}:generateContent`));
  const value = (await upstreamJson(candidate, url.toString(), {
    method: "POST",
    headers: geminiHeaders(candidate.apiKey),
    body: JSON.stringify({
      contents,
      ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
      generationConfig: textParameters,
    }),
  })) as { candidates?: Array<{ content?: { parts?: Array<{ text?: unknown }> } }> } | null;
  const parts = Array.isArray(value?.candidates) ? value.candidates[0]?.content?.parts : undefined;
  const content = Array.isArray(parts) ? parts.map((part) => part?.text).filter((text): text is string => typeof text === "string").join("") : "";
  if (!content) throw new UpstreamError("上游未返回文本", "invalid_response", undefined, "once");
  return content;
}

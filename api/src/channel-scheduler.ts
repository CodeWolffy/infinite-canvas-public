import { and, desc, eq, isNotNull, isNull, lt, lte, or } from "drizzle-orm";
import { decryptSecret } from "./crypto.js";
import { db } from "./db/client.js";
import { channels, modelChannels } from "./db/schema.js";

export type ChannelCandidate = {
  channelId: string;
  channelName: string;
  protocol: "openai" | "gemini";
  baseUrl: string;
  apiKey?: string;
  timeoutMs: number;
  maxConcurrency: number;
  cooldownSeconds: number;
  upstreamModel: string;
  priority: number;
  weight: number;
};

export class UpstreamError extends Error {
  constructor(
    message: string,
    readonly category: string,
    readonly httpStatus?: number,
    readonly failover: "always" | "once" | "never" = "never",
  ) {
    super(message);
  }
}

export async function hasChannelCandidates(modelId: string, channelId?: string) {
  const [row] = await db
    .select({ id: channels.id })
    .from(modelChannels)
    .innerJoin(channels, eq(channels.id, modelChannels.channelId))
    .where(
      and(
        eq(modelChannels.modelId, modelId),
        channelId ? eq(channels.id, channelId) : undefined,
        eq(modelChannels.enabled, true),
        eq(channels.status, "active"),
        or(isNull(channels.cooldownUntil), lte(channels.cooldownUntil, new Date())),
      ),
    )
    .limit(1);
  return Boolean(row);
}

function weightedShuffle(candidates: ChannelCandidate[]) {
  return candidates
    .map((candidate) => ({ candidate, key: -Math.log(Math.random() || Number.EPSILON) / candidate.weight }))
    .sort((a, b) => a.key - b.key)
    .map(({ candidate }) => candidate);
}

export async function getChannelCandidates(modelId: string) {
  const rows = await db
    .select({
      channelId: channels.id,
      channelName: channels.name,
      protocol: channels.protocol,
      baseUrl: channels.baseUrl,
      encryptedApiKey: channels.encryptedApiKey,
      timeoutMs: channels.timeoutMs,
      maxConcurrency: channels.maxConcurrency,
      cooldownSeconds: channels.cooldownSeconds,
      upstreamModel: modelChannels.upstreamModel,
      priority: modelChannels.priority,
      weight: modelChannels.weight,
    })
    .from(modelChannels)
    .innerJoin(channels, eq(channels.id, modelChannels.channelId))
    .where(
      and(
        eq(modelChannels.modelId, modelId),
        eq(modelChannels.enabled, true),
        eq(channels.status, "active"),
        or(isNull(channels.cooldownUntil), lte(channels.cooldownUntil, new Date())),
      ),
    )
    .orderBy(desc(modelChannels.priority));

  const groups = new Map<number, ChannelCandidate[]>();
  for (const row of rows) {
    let apiKey: string | undefined;
    if (row.encryptedApiKey) {
      try {
        apiKey = decryptSecret(row.encryptedApiKey);
      } catch (err) {
        console.warn(`[ChannelScheduler] 渠道 ${row.channelName} (${row.channelId}) 密钥解密失败，已跳过:`, err);
        continue;
      }
    }
    const candidate: ChannelCandidate = {
      ...row,
      apiKey,
    };
    const group = groups.get(row.priority) ?? [];
    group.push(candidate);
    groups.set(row.priority, group);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => b - a)
    .flatMap(([, candidates]) => weightedShuffle(candidates));
}

/**
 * 进程内渠道并发限流器。
 * 注意：当前限流基于单实例内存 Map 控制。当 API 服务横向多实例扩容时，各实例独立计数，
 * 总体并发上限将被实例数放大（例如 maxConcurrency=5，在 3 个副本下理论允许 15 并发）。
 * 若业务后续对上游渠道有严格的全局频控要求，建议在反向代理层收敛流量或迁移至分布式锁（Postgres Advisory Lock / Redis）。
 */
class ChannelConcurrencyLimiter {
  private running = new Map<string, number>();
  private waiters = new Map<string, Array<() => void>>();

  async acquire(channelId: string, maxConcurrency: number, timeoutMs: number): Promise<() => void> {
    const current = this.running.get(channelId) ?? 0;
    if (current < Math.max(1, maxConcurrency)) {
      this.running.set(channelId, current + 1);
      return () => this.release(channelId);
    }

    return new Promise<() => void>((resolve, reject) => {
      const timer = setTimeout(() => {
        const queue = this.waiters.get(channelId);
        if (queue) {
          const idx = queue.indexOf(onAvailable);
          if (idx !== -1) queue.splice(idx, 1);
          if (queue.length === 0) this.waiters.delete(channelId);
        }
        reject(new UpstreamError("渠道并发槽位等待超时", "channel_busy", undefined, "always"));
      }, timeoutMs);

      const onAvailable = () => {
        clearTimeout(timer);
        this.running.set(channelId, (this.running.get(channelId) ?? 0) + 1);
        resolve(() => this.release(channelId));
      };

      const queue = this.waiters.get(channelId) ?? [];
      queue.push(onAvailable);
      this.waiters.set(channelId, queue);
    });
  }

  private release(channelId: string) {
    const current = this.running.get(channelId) ?? 1;
    if (current <= 1) {
      this.running.delete(channelId);
    } else {
      this.running.set(channelId, current - 1);
    }

    const queue = this.waiters.get(channelId);
    if (queue && queue.length > 0) {
      const next = queue.shift()!;
      if (queue.length === 0) this.waiters.delete(channelId);
      next();
    }
  }
}

const limiter = new ChannelConcurrencyLimiter();

export async function withChannelSlot<T>(candidate: ChannelCandidate, action: () => Promise<T>) {
  const timeoutMs = Math.max(Math.floor(candidate.timeoutMs / 2), 1000);
  const release = await limiter.acquire(candidate.channelId, candidate.maxConcurrency, timeoutMs);
  try {
    return await action();
  } finally {
    release();
  }
}

export async function markChannelResult(candidate: ChannelCandidate, error?: UpstreamError, startedAt = new Date()) {
  const now = new Date();
  const onWriteFailure = () => console.warn("[ChannelScheduler] 渠道健康状态写入失败", { channelId: candidate.channelId, result: error?.category ?? "success" });
  if (!error) {
    // 仅在渠道先前处于异常（有错误码或处于冷却中）需要恢复时落盘更新，
    // 避免高并发健康调用下所有 worker 在同一行 channels 上加排他行锁排队等待。
    await db
      .update(channels)
      .set({ lastSuccessAt: now, lastErrorCode: null, cooldownUntil: null, updatedAt: now })
      .where(
        and(
          eq(channels.id, candidate.channelId),
          or(isNotNull(channels.lastErrorCode), isNotNull(channels.cooldownUntil)),
          or(isNull(channels.lastFailureAt), lt(channels.lastFailureAt, startedAt)),
        ),
      ).catch(onWriteFailure);
    return;
  }

  const isRequestRejection = error.category === "content_policy" || error.category === "invalid_request";
  const isAuthError = !isRequestRejection && (error.httpStatus === 401 || error.httpStatus === 403);
  const isChannelFault = !isRequestRejection && (
    error.category === "timeout" ||
    error.category === "network" ||
    error.category === "channel_busy" ||
    error.httpStatus === 429 ||
    (typeof error.httpStatus === "number" && error.httpStatus >= 500));

  const configuredCooldownMs = Math.max(0, (candidate.cooldownSeconds ?? 120)) * 1000;
  // 鉴权错误通常持续较长（如额度耗尽或密钥失效），保留至少 5 分钟或管理员配置的更长冷却期
  const cooldownMs = isAuthError
    ? Math.max(configuredCooldownMs, 300 * 1000)
    : isChannelFault
      ? configuredCooldownMs
      : 0;

  await db
    .update(channels)
    .set({
      lastFailureAt: now,
      lastErrorCode: error.category,
      ...(cooldownMs > 0 ? { cooldownUntil: new Date(now.getTime() + cooldownMs) } : {}),
      updatedAt: now,
    })
    .where(eq(channels.id, candidate.channelId))
    .catch(onWriteFailure);
}

export async function runWithFailover<T>(
  modelId: string,
  action: (candidate: ChannelCandidate, attempt: number) => Promise<T>,
) {
  const candidates = await getChannelCandidates(modelId);
  if (!candidates.length) throw new UpstreamError("没有可用渠道", "no_channel", undefined, "never");
  let ambiguousRetryPending = false;
  let ambiguousSourceChannelId: string | undefined;
  let lastError: UpstreamError | undefined;
  let attempt = 0;
  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index]!;
    let attempted = false;
    try {
      const completed = await withChannelSlot(candidate, async () => {
        if (!(await hasChannelCandidates(modelId, candidate.channelId))) return;
        const startedAt = new Date();
        attempted = true;
        try {
          const result = await action(candidate, ++attempt);
          await markChannelResult(candidate, undefined, startedAt);
          return { result };
        } catch (error) {
          const upstream = error instanceof UpstreamError ? error : new UpstreamError("上游请求失败", "unknown", undefined, "once");
          // Publish health before releasing the slot so queued requests see the cooldown.
          await markChannelResult(candidate, upstream, startedAt);
          throw upstream;
        }
      });
      if (!completed) continue;
      return { result: completed.result, candidate };
    } catch (error) {
      if (!(error instanceof UpstreamError)) throw error;
      const upstream = error;
      lastError = upstream;
      if (!attempted) await markChannelResult(candidate, upstream);
      if (ambiguousRetryPending && candidate.channelId !== ambiguousSourceChannelId) throw upstream;
      if (upstream.failover === "never") throw upstream;
      if (upstream.failover === "once") {
        ambiguousRetryPending = true;
        ambiguousSourceChannelId = candidate.channelId;
      }
    }
  }
  throw lastError ?? new UpstreamError("没有可用渠道", "no_channel");
}

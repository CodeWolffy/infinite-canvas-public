import localforage from "localforage";
import stringify from "fast-json-stable-stringify";

import { createGenerationBatch, type GenerationBatchDetail } from "./generation";
import { ApiError } from "./request";
import { ensurePlatformMedia } from "./tasks";
import { assertCurrentSession, useUserStore } from "@/stores/use-user-store";
import type { ReferenceImage } from "@/types/image";

type Submission = Parameters<typeof createGenerationBatch>[0] & { requestId: string };
type PendingSubmission = { input: Submission; referenceMedia: GenerationBatchDetail["referenceMedia"] };
type WorkbenchSubmission = {
    capability: "image" | "video";
    modelId: string;
    prompt: string;
    count: number;
    parameters: Record<string, unknown>;
    references: ReferenceImage[];
};
const storage = localforage.createInstance({ name: "infinite-canvas", storeName: "generation_submissions" });
const inFlight = new Map<string, Promise<GenerationBatchDetail & { submissionWarning?: string }>>();
let tabIdentity: Promise<string> | undefined;

function getSubmissionTabId() {
    if (tabIdentity) return tabIdentity;
    tabIdentity = new Promise<string>((resolve, reject) => {
        const claim = (id: string) => {
            void navigator.locks.request(`generation-tab:${id}`, { ifAvailable: true }, (lock) => {
                if (!lock) { claim(crypto.randomUUID()); return; }
                sessionStorage.setItem("infinite-canvas:generation-tab", id);
                resolve(id);
                // 浏览器在页面离开时释放锁；复制标签页继承的 sessionStorage 标识不能同时被占用。
                return new Promise<void>(() => {});
            }).catch(reject);
        };
        claim(sessionStorage.getItem("infinite-canvas:generation-tab") || crypto.randomUUID());
    }).catch((error) => { tabIdentity = undefined; throw error; });
    return tabIdentity;
}

export class GenerationSubmissionUncertainError extends Error {
    constructor() {
        super("生成提交结果尚未确认。保持输入不变并再次点击生成，将使用原请求核对结果。");
        this.name = "GenerationSubmissionUncertainError";
    }
}

/** 只保留未确认的提交；同一输入恢复原请求，确认成功后再次生成才创建新编号。 */
export async function submitWorkbenchGeneration(value: WorkbenchSubmission, assertInput: () => void) {
    const { user, sessionVersion } = useUserStore.getState();
    const assertScope = () => { assertCurrentSession(sessionVersion); assertInput(); };
    assertScope();
    if (!user) throw new DOMException("登录会话已变更", "AbortError");
    // 预览 URL 和前端附件 id 不影响生成；媒体来源、顺序及全部生成参数参与匹配。
    const fingerprint = stringify({ ...value, prompt: value.prompt.trim(), references: value.references.map((item) => item.storageKey || item.url || item.dataUrl) });
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(fingerprint));
    assertScope();
    let tabId: string;
    try { tabId = await getSubmissionTabId(); }
    catch { throw new Error("标签页恢复标识保存失败，本次未发起生成，请重试。"); }
    assertScope();
    const keyParts = [user.id, value.capability, Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")];
    const key = JSON.stringify(keyParts);
    const ownKey = JSON.stringify([...keyParts, tabId]);
    const flightKey = `${sessionVersion}:${key}`;
    const current = inFlight.get(flightKey);
    if (current) return current;
    const operation = (async () => {
        // 标签各自保留未确认编号；共享编号仅用于合并首次并发提交，不能代替标签自己的恢复记录。
        const pending = await navigator.locks.request(`generation:${key}`, async () => {
            assertScope();
            let saved: PendingSubmission | null;
            try { saved = await storage.getItem<PendingSubmission>(ownKey); }
            catch { throw new Error("提交记录读取失败，本次未发起生成，请重试。"); }
            assertScope();
            if (saved) return saved;
            try { saved = await storage.getItem<PendingSubmission>(key); }
            catch { throw new Error("提交记录读取失败，本次未发起生成，请重试。"); }
            assertScope();
            if (!saved) {
                const referenceMediaIds = await Promise.all(value.references.map((item) => ensurePlatformMedia(item, undefined, assertScope)));
                assertScope();
                saved = {
                    input: { requestId: crypto.randomUUID(), modelId: value.modelId, prompt: value.prompt.trim(), count: value.count, parameters: value.parameters, referenceMediaIds },
                    referenceMedia: value.references.map((item, index) => ({ mediaId: referenceMediaIds[index], mimeType: item.type, originalName: item.name })),
                };
                try { await storage.setItem(key, saved); }
                catch { throw new Error("提交记录保存失败，本次未发起生成，输入已保留，请重试。"); }
                assertScope();
            }
            try { await storage.setItem(ownKey, saved); }
            catch { throw new Error("提交记录保存失败，本次未发起生成，输入已保留，请重试。"); }
            assertScope();
            return saved;
        });
        assertScope();
        let created: Awaited<ReturnType<typeof createGenerationBatch>>;
        try { created = await createGenerationBatch(pending.input); }
        catch (error) {
            assertCurrentSession(sessionVersion);
            if (error instanceof ApiError && error.status < 500) throw error;
            throw new GenerationSubmissionUncertainError();
        }
        assertCurrentSession(sessionVersion);
        let submissionWarning: string | undefined;
        try {
            await navigator.locks.request(`generation:${key}`, async () => {
                for (const recordKey of [ownKey, key]) {
                    assertCurrentSession(sessionVersion);
                    const saved = await storage.getItem<PendingSubmission>(recordKey);
                    assertCurrentSession(sessionVersion);
                    if (saved?.input.requestId === pending.input.requestId) await storage.removeItem(recordKey);
                }
            });
        } catch {
            assertCurrentSession(sessionVersion);
            submissionWarning = "生成已受理，但本机提交记录清理失败；再次提交相同输入可能返回本次结果，请先核对生成记录。";
        }
        assertCurrentSession(sessionVersion);
        return { ...created, referenceMediaIds: pending.input.referenceMediaIds, referenceMedia: pending.referenceMedia, submissionWarning };
    })();
    inFlight.set(flightKey, operation);
    try { return await operation; }
    finally { if (inFlight.get(flightKey) === operation) inFlight.delete(flightKey); }
}

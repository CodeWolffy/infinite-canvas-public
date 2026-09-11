import { ApiError, apiRequest } from "@/services/api/request";
import { taskDelay } from "./tasks";
import { assertCurrentSession, useUserStore } from "@/stores/use-user-store";

export type TextMessage = { id: string; role: "system" | "user" | "assistant"; content: string; createdAt: string };
export type TextRequestState = { id: string; conversationId: string; responseMessageId: string | null; status: "queued" | "running" | "succeeded" | "failed" | "canceled"; errorCode: string | null; errorMessage?: string | null; createdAt: string; finishedAt: string | null; partialText?: string; streamSequence?: number; run?: number; billed?: string; price?: string };
export type TextRequestDetail = { request: TextRequestState; message: TextMessage | null };

export function watchTextRequest(id: string, onChange: (detail: TextRequestDetail) => void, signal?: AbortSignal, onError?: (error: Error) => void) {
    const session = useUserStore.getState().sessionVersion;
    const controller = new AbortController();
    let closed = false;
    let polling = false;
    let source: EventSource | null = null;
    let unsubscribe = () => {};
    let lastRun = -1;
    let lastSequence = -1;
    const cleanup = () => { if (closed) return; closed = true; source?.close(); controller.abort(); unsubscribe(); signal?.removeEventListener("abort", aborted); };
    const fail = (error: Error) => { cleanup(); onError?.(error); };
    const aborted = () => fail(new DOMException("已停止等待", "AbortError"));
    const receive = (detail: TextRequestDetail) => {
        if (closed) return;
        assertCurrentSession(session);
        if (detail.request.id.toLowerCase() !== id.toLowerCase()) return;
        const run = detail.request.run || 1;
        const sequence = detail.request.streamSequence || 0;
        if (run < lastRun || run === lastRun && sequence < lastSequence) return;
        lastRun = run; lastSequence = sequence;
        onChange(detail);
        if (!["queued", "running"].includes(detail.request.status)) cleanup();
    };
    const poll = async () => {
        while (!closed) {
            try { receive(await getTextRequest(id)); }
            catch (error) {
                if (error instanceof DOMException && error.name === "AbortError" || error instanceof ApiError && error.status < 500) { fail(error as Error); return; }
            }
            if (!closed) await taskDelay(controller.signal).catch(() => undefined);
        }
    };
    unsubscribe = useUserStore.subscribe((state) => { if (state.sessionVersion !== session) aborted(); });
    signal?.addEventListener("abort", aborted, { once: true });
    if (signal?.aborted) { aborted(); return cleanup; }
    source = new EventSource(`/api/text/requests/${id}/events`, { withCredentials: true });
    source.addEventListener("snapshot", (event) => {
        try { receive(JSON.parse((event as MessageEvent<string>).data) as TextRequestDetail); }
        catch (error) { fail(error instanceof Error ? error : new Error("流式消息读取失败")); }
    });
    source.addEventListener("expired", () => { if (!closed && useUserStore.getState().sessionVersion === session) window.dispatchEvent(new Event("auth:unauthorized")); aborted(); });
    source.addEventListener("unavailable", () => fail(new Error("文本请求暂时不可读取，请刷新重试")));
    source.onerror = () => { if (closed || polling) return; polling = true; source?.close(); source = null; void poll(); };
    return cleanup;
}

export async function createTextConversation(input: { canvasProjectId?: string; title?: string }) {
    return (await apiRequest<{ conversation: { id: string; title: string; canvasProjectId: string | null } }>("/api/text/conversations", { method: "POST", body: input })).conversation;
}

export async function createTextRequest(input: {
    requestId: string;
    conversationId?: string;
    canvasProjectId?: string;
    title?: string;
    modelId: string;
    content: string;
    systemPrompt?: string;
    attachmentMediaIds?: string[];
    parameters?: Record<string, unknown>;
}, signal?: AbortSignal, onProgress?: (text: string) => void) {
    const session = useUserStore.getState().sessionVersion;
    const accepted = await queueTextRequest(input, signal);
    assertCurrentSession(session);
    return new Promise<{ conversationId: string; requestId: string; message: TextMessage }>((resolve, reject) => {
        watchTextRequest(accepted.requestId, (result) => {
            if (result.request.partialText) onProgress?.(result.request.partialText);
            if (result.request.status === "succeeded" && result.message) resolve({ ...accepted, message: result.message });
            else if (result.request.status === "failed" || result.request.status === "canceled") reject(new Error(result.request.errorMessage || "文本生成未完成，冻结余额已退回"));
        }, signal, reject);
    });
}

export function queueTextRequest(input: Parameters<typeof createTextRequest>[0], signal?: AbortSignal) {
    return apiRequest<{ conversationId: string; requestId: string }>("/api/text/requests", { method: "POST", body: input, signal });
}

export async function listTextConversations() {
    return (await apiRequest<{ conversations: Array<{ id: string; title: string; canvasProjectId: string | null; createdAt: string; updatedAt: string }> }>("/api/text/conversations")).conversations;
}

export async function getTextConversation(id: string) {
    return apiRequest<{
        conversation: { id: string; title: string; canvasProjectId: string | null };
        messages: TextMessage[];
        latestRequest: TextRequestState | null;
    }>(`/api/text/conversations/${id}`);
}

export async function getTextRequest(id: string) {
    return apiRequest<TextRequestDetail>(`/api/text/requests/${id}`);
}

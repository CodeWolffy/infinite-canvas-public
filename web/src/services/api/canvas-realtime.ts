import { ApiError, apiRequest } from "@/services/api/request";
import type { CanvasProjectDetail } from "@/services/api/canvas-projects";
import { useUserStore } from "@/stores/use-user-store";

export type CanvasOnlineMember = { userId: string; username: string; displayName: string };
export type CanvasConnectionStatus = "connecting" | "online" | "reconnecting" | "unavailable";

export function watchCanvas(id: string, callbacks: { snapshot: (project: CanvasProjectDetail) => void; presence: (members: CanvasOnlineMember[]) => void; status: (status: CanvasConnectionStatus) => void; unavailable: () => void }) {
    const session = useUserStore.getState().sessionVersion;
    const clientId = crypto.randomUUID();
    const controller = new AbortController();
    let stopped = false;
    let unsubscribe = () => {};
    const current = () => !stopped && useUserStore.getState().sessionVersion === session;
    const source = new EventSource(`/api/canvas-projects/${id}/events`, { withCredentials: true });
    const cleanup = () => {
        if (stopped) return;
        stopped = true;
        source.close();
        controller.abort();
        clearInterval(heartbeat);
        unsubscribe();
        if (useUserStore.getState().sessionVersion === session) void apiRequest(`/api/canvas-projects/${id}/presence/${clientId}`, { method: "DELETE", keepalive: true }).catch(() => undefined);
    };
    const unavailable = () => { if (!current()) return; callbacks.status("unavailable"); callbacks.unavailable(); cleanup(); };
    const renew = async () => {
        try { await apiRequest(`/api/canvas-projects/${id}/presence`, { method: "POST", body: { clientId }, signal: controller.signal }); }
        catch (error) {
            if (!current()) return;
            if (error instanceof ApiError && [401, 403, 404].includes(error.status)) unavailable();
            else callbacks.status("reconnecting");
        }
    };
    const heartbeat = setInterval(() => void renew(), 30000);
    source.addEventListener("snapshot", (event) => {
        if (!current()) return;
        try {
            const { project } = JSON.parse((event as MessageEvent<string>).data) as { project: CanvasProjectDetail };
            if (project.id !== id) return;
            callbacks.snapshot(project);
            callbacks.status("online");
        } catch { callbacks.status("reconnecting"); }
    });
    source.addEventListener("presence", (event) => {
        if (!current()) return;
        try { callbacks.presence((JSON.parse((event as MessageEvent<string>).data) as { members: CanvasOnlineMember[] }).members); }
        catch { callbacks.status("reconnecting"); }
    });
    source.addEventListener("unavailable", unavailable);
    source.addEventListener("expired", unavailable);
    source.onopen = () => { if (current()) void renew(); };
    source.onerror = () => { if (current()) callbacks.status("reconnecting"); };
    unsubscribe = useUserStore.subscribe((state) => { if (state.sessionVersion !== session) cleanup(); });
    return cleanup;
}

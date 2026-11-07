import { useCallback, useEffect, useRef, useState } from "react";
import { App, Button, Spin, Typography } from "antd";
import { Check, Mail, RefreshCw, X } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { listCanvasInvitations, respondCanvasInvitation, type CanvasInvitation } from "@/services/api/canvas-collaboration";
import { useUserStore } from "@/stores/use-user-store";

export function CanvasInvitations() {
    const { message } = App.useApp();
    const navigate = useNavigate();
    const sessionVersion = useUserStore((state) => state.sessionVersion);
    const mounted = useRef(false);
    const requestVersion = useRef(0);
    const busyRef = useRef(false);
    const [result, setResult] = useState<{ session: number; items: CanvasInvitation[] } | null>(null);
    const [loading, setLoading] = useState(true);
    const [pending, setPending] = useState<{ id: string; accept: boolean } | null>(null);
    const [error, setError] = useState("");
    const invitations = result?.session === sessionVersion ? result.items : [];
    const isCurrent = useCallback((session: number) => mounted.current && useUserStore.getState().sessionVersion === session, []);

    const reload = useCallback(async () => {
        const session = useUserStore.getState().sessionVersion;
        const request = ++requestVersion.current;
        setLoading(true);
        setError("");
        try {
            const items = await listCanvasInvitations();
            if (isCurrent(session) && request === requestVersion.current) setResult({ session, items });
        } catch (cause) {
            if (isCurrent(session) && request === requestVersion.current) setError(cause instanceof Error ? cause.message : "加载画布邀请失败");
        } finally {
            if (isCurrent(session) && request === requestVersion.current) setLoading(false);
        }
    }, [isCurrent]);

    useEffect(() => {
        mounted.current = true;
        busyRef.current = false;
        setPending(null);
        setResult(null);
        void reload();
        return () => { mounted.current = false; requestVersion.current++; };
    }, [sessionVersion, reload]);

    const respond = async (invitation: CanvasInvitation, accept: boolean) => {
        const session = sessionVersion;
        if (!isCurrent(session) || busyRef.current) return;
        busyRef.current = true;
        requestVersion.current++;
        setLoading(false);
        setPending({ id: invitation.projectId, accept });
        try {
            await respondCanvasInvitation(invitation.projectId, accept);
            if (!isCurrent(session)) return;
            setResult((previous) => previous?.session === session ? { session, items: previous.items.filter((item) => item.projectId !== invitation.projectId) } : previous);
            if (accept) navigate(`/canvas/${invitation.projectId}`);
            else { message.success("已拒绝画布邀请"); await reload(); }
        } catch (cause) {
            if (isCurrent(session)) message.error(cause instanceof Error ? cause.message : "处理邀请失败");
        } finally {
            if (isCurrent(session)) { busyRef.current = false; setPending(null); }
        }
    };

    return (
        <section aria-label="画布邀请" className="space-y-3">
            <div className="flex items-center justify-between gap-3">
                <h2 className="flex items-center gap-2 text-sm font-semibold"><Mail className="size-4" />画布邀请{invitations.length ? `（${invitations.length}）` : ""}</h2>
                <Button type="text" size="small" aria-label="刷新画布邀请" icon={<RefreshCw className="size-3.5" />} loading={loading} disabled={!!pending} onClick={() => void reload()}>刷新</Button>
            </div>
            {error ? <Typography.Text type="danger" className="text-xs">{error}</Typography.Text> : null}
            {loading && !result ? <Spin size="small" /> : !error && !invitations.length ? <Typography.Text type="secondary" className="text-xs">暂无待处理的画布邀请</Typography.Text> : null}
            {invitations.map((invitation) => (
                <div key={invitation.projectId} className="flex flex-wrap items-center justify-between gap-3 py-1">
                    <div className="min-w-0">
                        <div className="truncate text-sm font-medium">{invitation.title}</div>
                        <Typography.Text type="secondary" className="block text-xs">{invitation.invitedBy?.displayName || invitation.invitedBy?.username || "原邀请者"} 邀请你 · {invitation.role === "editor" ? "可编辑" : "可查看"} · 接受后生效</Typography.Text>
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                        <Button type="text" size="small" icon={<X className="size-3.5" />} loading={pending?.id === invitation.projectId && !pending.accept} disabled={!!pending} onClick={() => void respond(invitation, false)}>拒绝</Button>
                        <Button type="text" size="small" icon={<Check className="size-3.5" />} loading={pending?.id === invitation.projectId && pending.accept} disabled={!!pending} onClick={() => void respond(invitation, true)}>接受并打开</Button>
                    </div>
                </div>
            ))}
        </section>
    );
}

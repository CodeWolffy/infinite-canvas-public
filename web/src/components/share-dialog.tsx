import { useEffect, useRef, useState } from "react";
import { App, Button, Input, Modal, Popconfirm, Select, Space, Spin, Typography } from "antd";
import { Copy, Globe, History, Link2, LockKeyhole, RotateCcw, Trash2, UserPlus } from "lucide-react";
import dayjs from "dayjs";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";

import { createShareLink, getShareLink, resetShareLink, revokeShareLink, sharePageUrl, type ShareKind, type ShareLink, type SharingUser } from "@/services/api/sharing";
import { getCanvasAccessLog, getCanvasCollaboration, inviteCanvasMember, removeCanvasMember, updateCanvasMember, type CanvasAccessLog, type CanvasCollaboration, type CanvasMemberRole } from "@/services/api/canvas-collaboration";
import { useCopyText } from "@/hooks/use-copy-text";
import { useUserStore } from "@/stores/use-user-store";

const ROLE_OPTIONS = [{ label: "可查看", value: "viewer" }, { label: "可编辑", value: "editor" }];
const ROLE_LABEL = { owner: "所有者", editor: "可编辑", viewer: "可查看" };
const SOURCE_LABEL = { owner: "画布所有者", workspace: "工作区继承", direct: "单独邀请" };
const LOG_LABEL: Record<string, string> = {
    view: "访问画布", public_view: "通过只读链接访问", share_created: "启用匿名只读链接", share_revoked: "撤销匿名只读链接", share_reset: "重置匿名只读链接",
    member_invited: "邀请成员", member_role_changed: "调整成员权限", member_removed: "移除单独邀请", invitation_accepted: "接受邀请", invitation_rejected: "拒绝邀请",
};
const displayUser = (user: SharingUser) => user.displayName || user.username || user.userId;
type DialogData = { key: string; share: ShareLink | null; collaboration?: CanvasCollaboration };

/** 默认只复制受账号权限保护的画布地址，匿名访问必须由所有者主动启用。 */
export function ShareDialog({ kind, targetId, open, onClose }: { kind: ShareKind; targetId: string; open: boolean; onClose: () => void }) {
    const { message } = App.useApp();
    const { t } = useTranslation();
    const copyText = useCopyText();
    const sessionVersion = useUserStore((state) => state.sessionVersion);
    const key = `${sessionVersion}:${kind}:${targetId}:${open}`;
    const currentKey = useRef(key);
    currentKey.current = key;
    const requestVersion = useRef(0);
    const busyRef = useRef(false);
    const [result, setResult] = useState<DialogData | null>(null);
    const [error, setError] = useState<{ key: string; text: string } | null>(null);
    const [reload, setReload] = useState(0);
    const [busy, setBusy] = useState("");
    const [username, setUsername] = useState("");
    const [role, setRole] = useState<CanvasMemberRole>("viewer");
    const [logsOpen, setLogsOpen] = useState(false);
    const [logs, setLogs] = useState<{ items: CanvasAccessLog[]; total: number } | null>(null);
    const [logsLoading, setLogsLoading] = useState(false);
    const logRequest = useRef(0);
    const data = result?.key === key ? result : null;
    const collaboration = data?.collaboration;
    const share = data?.share;
    const canManage = kind === "asset" || collaboration?.canManage === true;
    const isCurrent = (version: number) => currentKey.current === key && requestVersion.current === version && useUserStore.getState().sessionVersion === sessionVersion;

    useEffect(() => {
        const version = ++requestVersion.current;
        let active = true;
        const current = () => active && currentKey.current === key && requestVersion.current === version && useUserStore.getState().sessionVersion === sessionVersion;
        setResult(null);
        setError(null);
        setBusy("");
        busyRef.current = false;
        setUsername("");
        setRole("viewer");
        setLogsOpen(false);
        setLogs(null);
        setLogsLoading(false);
        logRequest.current++;
        if (open) {
            const load = kind === "canvas"
                ? getCanvasCollaboration(targetId).then((value) => ({ key, collaboration: value, share: value.share }))
                : getShareLink(kind, targetId).then((value) => ({ key, share: value.share }));
            void load.then((value) => { if (current()) setResult(value); }).catch((cause) => {
                if (current()) setError({ key, text: cause instanceof Error ? cause.message : "加载分享信息失败" });
            });
        }
        return () => { active = false; requestVersion.current++; };
    }, [key, kind, targetId, open, sessionVersion, reload]);

    const run = async (action: string, task: (current: () => boolean) => Promise<void>) => {
        const version = requestVersion.current;
        if (!open || !data || !canManage || busyRef.current || !isCurrent(version)) return;
        const current = () => isCurrent(version);
        busyRef.current = true;
        setBusy(action);
        try {
            await task(current);
        } catch (cause) {
            if (current()) message.error(cause instanceof Error ? cause.message : "操作失败，请重试");
        } finally {
            if (current()) { busyRef.current = false; setBusy(""); }
        }
    };
    const changeMember = (action: string, request: () => Promise<void>) => run(action, async (current) => {
        await request();
        if (!current()) return;
        if (action === "invite") { setUsername(""); setRole("viewer"); message.success("邀请已发送，对方接受后生效"); }
        const value = await getCanvasCollaboration(targetId);
        if (current()) setResult({ key, collaboration: value, share: value.share });
    });
    const invite = () => {
        const name = username.trim();
        if (name) void changeMember("invite", () => inviteCanvasMember(targetId, name, role));
    };
    const changeShare = (action: "create" | "reset" | "revoke") => run(action, async (current) => {
        let value: ShareLink | null = null;
        if (action === "revoke") await revokeShareLink(kind, targetId);
        else value = (await (action === "reset" ? resetShareLink(kind, targetId) : createShareLink(kind, targetId))).share;
        if (!current()) return;
        setResult((previous) => previous?.key === key ? { ...previous, share: value } : previous);
        if (action === "revoke") message.success("匿名只读链接已撤销，原链接已失效");
        if (action === "reset") message.success("链接已重置，原链接已失效，请重新复制");
    });
    const loadLogs = async (offset = 0) => {
        const version = requestVersion.current;
        if (!isCurrent(version) || !collaboration?.canManage) return;
        const request = ++logRequest.current;
        setLogsLoading(true);
        try {
            const value = await getCanvasAccessLog(targetId, offset);
            if (isCurrent(version) && request === logRequest.current) setLogs((previous) => ({ ...value, items: offset ? [...(previous?.items || []), ...value.items] : value.items }));
        } catch (cause) {
            if (isCurrent(version) && request === logRequest.current) message.error(cause instanceof Error ? cause.message : "加载访问记录失败");
        } finally {
            if (isCurrent(version) && request === logRequest.current) setLogsLoading(false);
        }
    };
    const url = share ? sharePageUrl(share.token) : "";
    const canvasUrl = `${window.location.origin}/canvas/${targetId}`;
    const close = () => { requestVersion.current++; onClose(); };

    return (
        <Modal title={kind === "canvas" ? "分享与协作" : t("share.title")} open={open} onCancel={close} footer={null} width={kind === "canvas" ? 640 : 480} style={{ top: 24 }} styles={{ body: { maxHeight: "calc(100dvh - 136px)", overflowY: "auto" } }} destroyOnHidden>
            {error?.key === key ? (
                <div className="space-y-3 py-5"><Typography.Text type="danger">{error.text}</Typography.Text><Button type="text" onClick={() => setReload((value) => value + 1)}>重新加载</Button></div>
            ) : !data ? <div className="flex justify-center py-12"><Spin /></div> : (
                <div className="space-y-6 pt-3">
                    {collaboration ? (
                        <>
                            <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
                                <Typography.Text>所有者：{displayUser(collaboration.owner)}{collaboration.owner.username ? ` @${collaboration.owner.username}` : ""}</Typography.Text>
                                {collaboration.workspace ? <Link to={`/user/workspaces?id=${collaboration.workspace.id}`} onClick={close}>{collaboration.workspace.name} · 工作区权限</Link> : null}
                            </div>
                            <section aria-label="画布成员">
                                <h3 className="mb-3 text-sm font-semibold">成员与权限</h3>
                                <div className="max-h-64 space-y-4 overflow-y-auto">
                                    {collaboration.members.map((member) => (
                                        <div key={`${member.userId}:${member.source}`} className="flex items-center justify-between gap-3">
                                            <div className="min-w-0">
                                                <div className="truncate text-sm">{displayUser(member)}{member.username ? <Typography.Text type="secondary"> @{member.username}</Typography.Text> : null}</div>
                                                <Typography.Text type="secondary" className="block text-xs">
                                                    {SOURCE_LABEL[member.source]}{member.status === "pending" ? " · 待接受" : ""}{member.invitedBy ? ` · ${displayUser(member.invitedBy)} 邀请` : ""}
                                                </Typography.Text>
                                            </div>
                                            <div className="flex shrink-0 items-center gap-1">
                                                {canManage && member.source === "direct" && member.role !== "owner" ? (
                                                    <>
                                                        <Select aria-label={`${displayUser(member)}的权限`} size="small" variant="borderless" value={member.role} options={ROLE_OPTIONS} className="w-24" disabled={!!busy} onChange={(value: CanvasMemberRole) => void changeMember(`role:${member.userId}`, () => updateCanvasMember(targetId, member.userId, value))} />
                                                        <Popconfirm title={member.status === "pending" ? "撤销这条邀请？" : "移除这项单独邀请权限？"} description="工作区继承的访问权限仍由工作区管理。" okText="移除" cancelText="取消" onConfirm={() => changeMember(`remove:${member.userId}`, () => removeCanvasMember(targetId, member.userId))}>
                                                            <Button type="text" size="small" danger disabled={!!busy} aria-label={`移除${displayUser(member)}的单独邀请`} icon={<Trash2 className="size-3.5" />} />
                                                        </Popconfirm>
                                                    </>
                                                ) : <Typography.Text type="secondary" className="text-xs">{ROLE_LABEL[member.role]}</Typography.Text>}
                                            </div>
                                        </div>
                                    ))}
                                </div>
                                {canManage ? (
                                    <div className="mt-5 space-y-2">
                                        <div className="flex flex-wrap items-center gap-2">
                                            <div className="w-full sm:min-w-36 sm:flex-1"><Input aria-label="受邀账号" value={username} onChange={(event) => setUsername(event.target.value)} onPressEnter={invite} placeholder="输入对方的平台账号" disabled={!!busy} /></div>
                                            <Select aria-label="邀请权限" value={role} onChange={setRole} options={ROLE_OPTIONS} disabled={!!busy} className="w-24" />
                                            <Button type="text" icon={<UserPlus className="size-4" />} loading={busy === "invite"} disabled={!username.trim() || !!busy} onClick={invite}>邀请</Button>
                                        </div>
                                        <Typography.Text type="secondary" className="block text-xs">默认可查看，对方接受后获得权限；工作区继承权限需前往工作区调整。</Typography.Text>
                                    </div>
                                ) : null}
                            </section>
                            <section aria-label="账号访问链接" className="space-y-2">
                                <h3 className="flex items-center gap-2 text-sm font-semibold"><LockKeyhole className="size-4" />仅有权限的账号可访问</h3>
                                <Typography.Text type="secondary" className="block text-xs">复制此地址不会新增访问权限。受邀账号需先在画布列表或个人中心接受邀请。</Typography.Text>
                                <Space.Compact style={{ width: "100%" }}>
                                    <Input aria-label="画布账号访问地址" readOnly value={canvasUrl} onFocus={(event) => event.target.select()} />
                                    <Button type="text" icon={<Copy className="size-4" />} onClick={() => copyText(canvasUrl, "画布地址已复制")}>复制</Button>
                                </Space.Compact>
                            </section>
                        </>
                    ) : <Typography.Text type="secondary" className="block text-sm">{t("share.assetHint")}</Typography.Text>}

                    <section aria-label="匿名只读链接" className="space-y-3">
                        {kind === "canvas" ? <h3 className="flex items-center gap-2 text-sm font-semibold"><Globe className="size-4" />匿名只读链接</h3> : null}
                        {share ? (
                            <>
                                <Typography.Text type="secondary" className="block text-xs">任何持链接的人可查看，无需登录，无法编辑{kind === "canvas" ? "画布" : "素材"}或使用你的账号生成内容。</Typography.Text>
                                <Space.Compact style={{ width: "100%" }}>
                                    <Input aria-label="匿名只读地址" readOnly value={url} onFocus={(event) => event.target.select()} />
                                    <Button type="text" icon={<Copy className="size-4" />} onClick={() => copyText(url, t("share.copied"))}>{t("common.copy")}</Button>
                                </Space.Compact>
                                <div className="flex flex-wrap items-center justify-between gap-2">
                                    <Typography.Text type="secondary" className="text-xs">
                                        {share.createdBy ? `创建者：${displayUser(share.createdBy)}` : t("share.readOnly")}
                                        {share.expiresAt ? ` · ${t("share.expiresAt", { date: dayjs(share.expiresAt).format("YYYY-MM-DD HH:mm") })}` : ""}
                                    </Typography.Text>
                                    {canManage ? (
                                        <div className="flex items-center gap-1">
                                            <Popconfirm title="重置匿名只读链接？" description="原链接会立即失效，已有成员权限不变。" okText="重置" cancelText="取消" onConfirm={() => changeShare("reset")}>
                                                <Button type="text" size="small" icon={<RotateCcw className="size-3.5" />} loading={busy === "reset"} disabled={!!busy}>重置链接</Button>
                                            </Popconfirm>
                                            <Popconfirm title="撤销匿名只读链接？" description="原链接会立即失效，已有成员权限不变。" okText="撤销" cancelText="取消" okButtonProps={{ danger: true }} onConfirm={() => changeShare("revoke")}>
                                                <Button danger type="text" size="small" icon={<Trash2 className="size-3.5" />} loading={busy === "revoke"} disabled={!!busy}>{t("share.revoke")}</Button>
                                            </Popconfirm>
                                        </div>
                                    ) : null}
                                </div>
                            </>
                        ) : (
                            <>
                                <Typography.Text type="secondary" className="block text-xs">{kind === "canvas" ? "尚未启用。只有已有权限的账号可以访问此画布。" : "尚未创建匿名只读链接。"}</Typography.Text>
                                {canManage ? (
                                    <Popconfirm title="允许任何持链接的人查看？" description="链接可被转发，访客无需登录；仅可查看，不能编辑。" okText="启用只读链接" cancelText="取消" onConfirm={() => changeShare("create")}>
                                        <Button type="text" icon={<Link2 className="size-4" />} loading={busy === "create"} disabled={!!busy}>{kind === "canvas" ? "开启任何持链接的人可查看" : t("share.create")}</Button>
                                    </Popconfirm>
                                ) : null}
                            </>
                        )}
                    </section>

                    {collaboration?.canManage ? (
                        <section>
                            <Button type="text" size="small" icon={<History className="size-3.5" />} onClick={() => { setLogsOpen(!logsOpen); if (!logsOpen && !logs) void loadLogs(); }}>{logsOpen ? "收起访问与权限记录" : "访问与权限记录"}</Button>
                            {logsOpen ? (
                                <div className="mt-3 space-y-3">
                                    <div className="flex justify-between text-xs"><Typography.Text type="secondary">{logs ? `共 ${logs.total} 条记录` : "访问与权限变更"}</Typography.Text><Button type="text" size="small" disabled={logsLoading} onClick={() => void loadLogs()}>刷新</Button></div>
                                    <div className="max-h-52 space-y-3 overflow-y-auto">
                                        {logs?.items.map((item) => <div key={item.id} className="flex justify-between gap-3 text-xs"><span>{item.actor ? displayUser(item.actor) : "匿名访客"} · {LOG_LABEL[item.action] || item.action}</span><Typography.Text type="secondary" className="shrink-0 text-xs">{dayjs(item.createdAt).format("MM-DD HH:mm")}</Typography.Text></div>)}
                                        {logs?.total === 0 ? <Typography.Text type="secondary" className="text-xs">暂无访问记录</Typography.Text> : null}
                                    </div>
                                    {logsLoading ? <Spin size="small" /> : logs && logs.items.length < logs.total ? <Button type="text" size="small" onClick={() => void loadLogs(logs.items.length)}>加载更多</Button> : null}
                                </div>
                            ) : null}
                        </section>
                    ) : null}
                </div>
            )}
        </Modal>
    );
}

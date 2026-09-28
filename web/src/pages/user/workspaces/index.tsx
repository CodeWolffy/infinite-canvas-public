import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { App, Button, Empty, Input, List, Modal, Popconfirm, Select, Spin, Table, Tag } from "antd";
import { LogOut, Plus, Trash2, Users } from "lucide-react";
import { useTranslation } from "react-i18next";

import { addWorkspaceMember, createWorkspace, deleteWorkspace, getWorkspace, listWorkspaces, removeWorkspaceMember, updateWorkspace, updateWorkspaceMember, type Workspace, type WorkspaceDetail, type WorkspaceMember, type WorkspaceRole } from "@/services/api/workspaces";
import { createCanvasProject } from "@/services/api/canvas-projects";
import { useCanvasStore } from "@/stores/canvas/use-canvas-store";
import { useUserStore } from "@/stores/use-user-store";

const ROLE_LABEL: Record<WorkspaceRole, string> = { owner: "workspace.roles.owner", editor: "workspace.roles.editor", viewer: "workspace.roles.viewer" };

export default function WorkspacesPage() {
    const { message } = App.useApp();
    const { t } = useTranslation();
    const navigate = useNavigate();
    const [searchParams, setSearchParams] = useSearchParams();
    const user = useUserStore((state) => state.user);
    const sessionVersion = useUserStore((state) => state.sessionVersion);
    const adoptProject = useCanvasStore((state) => state.adoptProject);
    const [workspaceResult, setWorkspaceResult] = useState<{ session: number; items: Workspace[] } | null>(null);
    const workspaces = workspaceResult?.session === sessionVersion ? workspaceResult.items : [];
    const [loadingSession, setLoadingSession] = useState<number | null>(null);
    const loading = loadingSession !== sessionVersion || workspaceResult?.session !== sessionVersion;
    const [detailResult, setDetailResult] = useState<{ session: number; value: WorkspaceDetail } | null>(null);
    const [detailLoadingKey, setDetailLoadingKey] = useState("");
    const listRequest = useRef(0);
    const detailRequest = useRef(0);
    const [creating, setCreating] = useState(false);
    const [name, setName] = useState("");
    const [renameOpen, setRenameOpen] = useState(false);
    const [renameDraft, setRenameDraft] = useState("");
    const [renaming, setRenaming] = useState(false);
    const [memberName, setMemberName] = useState("");
    const [memberRole, setMemberRole] = useState<"editor" | "viewer">("editor");
    const [memberSaving, setMemberSaving] = useState(false);
    const selectedId = searchParams.get("id") || workspaces[0]?.id || "";
    const detailLoading = detailLoadingKey === `${sessionVersion}:${selectedId}`;
    const detail = detailResult?.session === sessionVersion && detailResult.value.workspace.id === selectedId ? detailResult.value : null;
    const selectedIdRef = useRef(selectedId);
    selectedIdRef.current = selectedId;
    const isCurrent = useCallback((session: number, id?: string) =>
        useUserStore.getState().sessionVersion === session && (id === undefined || selectedIdRef.current === id), []);

    const reloadList = useCallback(async () => {
        const session = useUserStore.getState().sessionVersion;
        const request = ++listRequest.current;
        const items = await listWorkspaces();
        if (isCurrent(session) && request === listRequest.current) setWorkspaceResult({ session, items });
        return items;
    }, [isCurrent]);
    const reloadDetail = useCallback(async (id: string) => {
        const session = useUserStore.getState().sessionVersion;
        const request = ++detailRequest.current;
        setDetailResult(null);
        if (!id) {
            setDetailLoadingKey("");
            return;
        }
        setDetailLoadingKey(`${session}:${id}`);
        try {
            const value = await getWorkspace(id);
            if (isCurrent(session, id) && request === detailRequest.current) setDetailResult({ session, value });
        } catch (error) {
            if (isCurrent(session, id) && request === detailRequest.current) message.error(error instanceof Error ? error.message : t("workspace.loadFailed"));
        } finally {
            if (isCurrent(session, id) && request === detailRequest.current) setDetailLoadingKey("");
        }
    }, [isCurrent, message, t]);

    useEffect(() => {
        const session = sessionVersion;
        setLoadingSession(null);
        setDetailResult(null);
        reloadList()
            .catch((error) => {
                if (isCurrent(session)) {
                    setWorkspaceResult({ session, items: [] });
                    message.error(error instanceof Error ? error.message : t("workspace.loadFailed"));
                }
            })
            .finally(() => { if (isCurrent(session)) setLoadingSession(session); });
    }, [sessionVersion, reloadList, isCurrent, message, t]);
    useEffect(() => {
        void reloadDetail(selectedId);
    }, [selectedId, sessionVersion, reloadDetail]);

    const select = (id: string) => {
        selectedIdRef.current = id;
        detailRequest.current++;
        setDetailResult(null);
        setSearchParams(id ? { id } : {});
    };
    const isOwner = detail?.workspace.myRole === "owner" || (detail ? detail.workspace.ownerId === user?.id : false);

    const create = async () => {
        const trimmed = name.trim();
        if (!trimmed || creating) return;
        const session = useUserStore.getState().sessionVersion;
        const selected = selectedId;
        setCreating(true);
        try {
            const workspace = await createWorkspace(trimmed);
            if (!isCurrent(session, selected)) return;
            setName("");
            select(workspace.id);
            await reloadList();
            if (isCurrent(session, workspace.id)) message.success(t("workspace.created"));
        } catch (error) {
            if (isCurrent(session, selected)) message.error(error instanceof Error ? error.message : t("workspace.createFailed"));
        } finally {
            if (isCurrent(session)) setCreating(false);
        }
    };
    const addMember = async () => {
        const username = memberName.trim();
        if (!username || !detail || memberSaving) return;
        const session = useUserStore.getState().sessionVersion;
        const id = detail.workspace.id;
        setMemberSaving(true);
        try {
            await addWorkspaceMember(id, username, memberRole);
            if (!isCurrent(session, id)) return;
            setMemberName("");
            await reloadDetail(id);
            if (isCurrent(session, id)) message.success(t("workspace.memberAdded"));
        } catch (error) {
            if (isCurrent(session, id)) message.error(error instanceof Error ? error.message : t("workspace.memberAddFailed"));
        } finally {
            if (isCurrent(session)) setMemberSaving(false);
        }
    };
    const openRename = () => {
        if (!detail) return;
        setRenameDraft(detail.workspace.name);
        setRenameOpen(true);
    };
    const saveRename = async () => {
        if (!detail || renaming) return;
        const next = renameDraft.trim();
        if (!next) return;
        if (next === detail.workspace.name) {
            setRenameOpen(false);
            return;
        }
        const session = useUserStore.getState().sessionVersion;
        const id = detail.workspace.id;
        setRenaming(true);
        try {
            await updateWorkspace(id, next);
            if (!isCurrent(session, id)) return;
            setRenameOpen(false);
            await Promise.all([reloadList(), reloadDetail(id)]);
            if (isCurrent(session, id)) message.success(t("workspace.moved"));
        } catch (error) {
            if (isCurrent(session, id)) message.error(error instanceof Error ? error.message : t("workspace.renameFailed"));
        } finally {
            if (isCurrent(session)) setRenaming(false);
        }
    };
    const removeWorkspace = async () => {
        if (!detail) return;
        const session = useUserStore.getState().sessionVersion;
        const id = detail.workspace.id;
        try {
            await deleteWorkspace(id);
            if (!isCurrent(session, id)) return;
            select("");
            setDetailResult(null);
            await reloadList();
            if (isCurrent(session)) message.success(t("workspace.deleted"));
        } catch (error) {
            if (isCurrent(session, id)) message.error(error instanceof Error ? error.message : t("workspace.deleteFailed"));
        }
    };
    const leave = async () => {
        if (!detail || !user) return;
        const session = useUserStore.getState().sessionVersion;
        const id = detail.workspace.id;
        try {
            await removeWorkspaceMember(id, user.id);
            if (!isCurrent(session, id)) return;
            select("");
            setDetailResult(null);
            await reloadList();
            if (isCurrent(session)) message.success(t("workspace.left"));
        } catch (error) {
            if (isCurrent(session, id)) message.error(error instanceof Error ? error.message : t("workspace.leaveFailed"));
        }
    };
    const createCanvas = async () => {
        if (!detail) return;
        const session = useUserStore.getState().sessionVersion;
        const id = detail.workspace.id;
        try {
            const record = await createCanvasProject({ title: t("canvas.project.untitled"), snapshot: { nodes: [], connections: [] }, workspaceId: id });
            if (!isCurrent(session, id)) return;
            adoptProject(record);
            navigate(`/canvas/${record.id}`);
        } catch (error) {
            if (isCurrent(session, id)) message.error(error instanceof Error ? error.message : t("workspace.createCanvasFailed"));
        }
    };

    return (
        <div className="mx-auto flex h-full max-w-6xl flex-col gap-6 overflow-auto px-6 py-8">
            <header className="flex flex-wrap items-center justify-between gap-4">
                <div>
                    <p className="text-xs text-stone-500">{t("userCenter.navWorkspaces")}</p>
                    <h1 className="mt-1 text-2xl font-semibold">{t("workspace.title")}</h1>
                </div>
                <div className="flex items-center gap-2">
                    <Input value={name} onChange={(event) => setName(event.target.value)} onPressEnter={() => void create()} placeholder={t("workspace.namePlaceholder")} className="w-56" maxLength={80} />
                    <Button type="primary" icon={<Plus className="size-4" />} loading={creating} onClick={() => void create()}>
                        {t("workspace.create")}
                    </Button>
                </div>
            </header>

            {loading ? (
                <div className="flex min-h-40 items-center justify-center">
                    <Spin />
                </div>
            ) : !workspaces.length ? (
                <Empty description={t("workspace.empty")} className="py-16" />
            ) : (
                <div className="grid min-h-0 gap-6 lg:grid-cols-[240px_minmax(0,1fr)]">
                    <List
                        dataSource={workspaces}
                        renderItem={(item) => (
                            <button
                                type="button"
                                key={item.id}
                                onClick={() => select(item.id)}
                                className={`mb-2 flex w-full flex-col rounded-xl border px-4 py-3 text-left transition ${item.id === selectedId ? "border-stone-900 bg-stone-950/5 dark:border-stone-200 dark:bg-white/10" : "border-stone-200 hover:bg-black/5 dark:border-stone-800 dark:hover:bg-white/10"}`}
                            >
                                <span className="flex items-center justify-between gap-2">
                                    <span className="truncate text-sm font-medium">{item.name}</span>
                                    <Tag className="m-0 shrink-0 text-[11px]">{t(ROLE_LABEL[item.myRole || "viewer"])}</Tag>
                                </span>
                                <span className="mt-1 text-xs text-stone-500">{t("workspace.stats", { members: item.memberCount ?? 0, projects: item.projectCount ?? 0, assets: item.assetCount ?? 0 })}</span>
                            </button>
                        )}
                    />

                    <section className="min-w-0">
                        {detailLoading || !detail ? (
                            <div className="flex min-h-40 items-center justify-center">{detailLoading ? <Spin /> : null}</div>
                        ) : (
                            <div className="flex flex-col gap-8">
                                <div className="flex flex-wrap items-center justify-between gap-3">
                                    <div>
                                        <h2 className="flex items-center gap-2 text-xl font-semibold">
                                            <Users className="size-5" />
                                            {detail.workspace.name}
                                        </h2>
                                        <p className="mt-1 text-xs text-stone-500">{t("workspace.myRole", { role: t(ROLE_LABEL[detail.workspace.myRole || "viewer"]) })}</p>
                                    </div>
                                    <div className="flex items-center gap-2">
                                        {isOwner ? (
                                            <>
                                                <Button size="small" onClick={openRename}>
                                                    {t("workspace.rename")}
                                                </Button>
                                                <Popconfirm title={t("workspace.deleteConfirm")} okText={t("common.delete")} okButtonProps={{ danger: true }} onConfirm={() => void removeWorkspace()}>
                                                    <Button size="small" danger icon={<Trash2 className="size-3.5" />}>
                                                        {t("common.delete")}
                                                    </Button>
                                                </Popconfirm>
                                            </>
                                        ) : (
                                            <Popconfirm title={t("workspace.leaveConfirm")} okText={t("workspace.leave")} onConfirm={() => void leave()}>
                                                <Button size="small" icon={<LogOut className="size-3.5" />}>
                                                    {t("workspace.leave")}
                                                </Button>
                                            </Popconfirm>
                                        )}
                                    </div>
                                </div>

                                <section>
                                    <h3 className="mb-3 text-sm font-semibold">{t("workspace.members")}</h3>
                                    <Table<WorkspaceMember>
                                        size="small"
                                        rowKey="userId"
                                        pagination={false}
                                        dataSource={detail.members}
                                        columns={[
                                            { title: t("workspace.member"), render: (_, member) => `${member.displayName || member.username || member.userId}${member.username ? ` @${member.username}` : ""}` },
                                            {
                                                title: t("workspace.role"),
                                                width: 140,
                                                render: (_, member) =>
                                                    isOwner && member.role !== "owner" ? (
                                                        <Select
                                                            size="small"
                                                            value={member.role}
                                                            className="w-28"
                                                            options={[
                                                                { label: t("workspace.roles.editor"), value: "editor" },
                                                                { label: t("workspace.roles.viewer"), value: "viewer" },
                                                            ]}
                                                            onChange={(role) => {
                                                                const session = useUserStore.getState().sessionVersion;
                                                                const id = detail.workspace.id;
                                                                void updateWorkspaceMember(id, member.userId, role)
                                                                    .then(() => { if (isCurrent(session, id)) return reloadDetail(id); })
                                                                    .catch((error) => { if (isCurrent(session, id)) message.error(error instanceof Error ? error.message : t("workspace.roleFailed")); });
                                                            }}
                                                        />
                                                    ) : (
                                                        <Tag className="m-0">{t(ROLE_LABEL[member.role])}</Tag>
                                                    ),
                                            },
                                            {
                                                title: "",
                                                width: 60,
                                                render: (_, member) =>
                                                    member.role !== "owner" && (isOwner || member.userId === user?.id) ? (
                                                        <Button
                                                            size="small"
                                                            type="text"
                                                            danger
                                                            icon={<Trash2 className="size-3.5" />}
                                                            aria-label={t("workspace.removeMember")}
                                                            onClick={() => {
                                                                const session = useUserStore.getState().sessionVersion;
                                                                const id = detail.workspace.id;
                                                                void removeWorkspaceMember(id, member.userId)
                                                                    .then(async () => {
                                                                        if (!isCurrent(session, id)) return;
                                                                        await Promise.all([reloadDetail(id), reloadList()]);
                                                                    })
                                                                    .catch((error) => { if (isCurrent(session, id)) message.error(error instanceof Error ? error.message : t("workspace.removeFailed")); });
                                                            }}
                                                        />
                                                    ) : null,
                                            },
                                        ]}
                                    />
                                    {isOwner ? (
                                        <div className="mt-3 flex items-center gap-2">
                                            <Input value={memberName} onChange={(event) => setMemberName(event.target.value)} onPressEnter={() => void addMember()} placeholder={t("workspace.usernamePlaceholder")} className="w-56" maxLength={64} />
                                            <Select
                                                value={memberRole}
                                                className="w-28"
                                                options={[
                                                    { label: t("workspace.roles.editor"), value: "editor" },
                                                    { label: t("workspace.roles.viewer"), value: "viewer" },
                                                ]}
                                                onChange={setMemberRole}
                                            />
                                            <Button icon={<Plus className="size-4" />} loading={memberSaving} onClick={() => void addMember()}>
                                                {t("workspace.addMember")}
                                            </Button>
                                        </div>
                                    ) : null}
                                </section>

                                <section>
                                    <div className="mb-3 flex items-center justify-between">
                                        <h3 className="text-sm font-semibold">{t("workspace.projects")}</h3>
                                        {detail.workspace.myRole === "owner" || detail.workspace.myRole === "editor" ? (
                                            <Button size="small" icon={<Plus className="size-3.5" />} onClick={() => void createCanvas()}>
                                                {t("workspace.createCanvas")}
                                            </Button>
                                        ) : null}
                                    </div>
                                    {detail.projects.length ? (
                                        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                                            {detail.projects.map((project) => (
                                                <button key={project.id} type="button" className="rounded-xl border border-stone-200 px-4 py-3 text-left transition hover:bg-black/5 dark:border-stone-800 dark:hover:bg-white/10" onClick={() => navigate(`/canvas/${project.id}`)}>
                                                    <div className="truncate text-sm font-medium">{project.title}</div>
                                                    <div className="mt-1 text-xs text-stone-500">
                                                        {t("canvas.project.stats", { nodes: project.nodeCount, connections: project.connectionCount })}
                                                        {project.ownerName ? ` · ${project.ownerName}` : ""}
                                                    </div>
                                                </button>
                                            ))}
                                        </div>
                                    ) : (
                                        <Empty description={t("workspace.noProjects")} image={Empty.PRESENTED_IMAGE_SIMPLE} />
                                    )}
                                </section>

                                <section>
                                    <h3 className="mb-3 text-sm font-semibold">{t("workspace.assets")}</h3>
                                    {detail.assets.length ? (
                                        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                                            {detail.assets.map((asset) => (
                                                <div key={asset.id} className="rounded-xl border border-stone-200 px-4 py-3 dark:border-stone-800">
                                                    <div className="truncate text-sm font-medium">{asset.title}</div>
                                                    <div className="mt-1 text-xs text-stone-500">
                                                        {t(`assets.kinds.${asset.type}`)}
                                                        {asset.ownerName ? ` · ${asset.ownerName}` : ""}
                                                    </div>
                                                </div>
                                            ))}
                                        </div>
                                    ) : (
                                        <Empty description={t("workspace.noAssets")} image={Empty.PRESENTED_IMAGE_SIMPLE} />
                                    )}
                                </section>
                            </div>
                        )}
                    </section>
                </div>
            )}
            <Modal
                title={t("workspace.rename")}
                open={renameOpen}
                onCancel={() => !renaming && setRenameOpen(false)}
                onOk={() => void saveRename()}
                confirmLoading={renaming}
                okText={t("common.save")}
                cancelText={t("common.cancel")}
                destroyOnHidden
            >
                <div className="pt-2">
                    <Input
                        value={renameDraft}
                        onChange={(e) => setRenameDraft(e.target.value)}
                        onPressEnter={() => void saveRename()}
                        maxLength={80}
                        placeholder={t("workspace.namePlaceholder")}
                        autoFocus
                    />
                </div>
            </Modal>
        </div>
    );
}

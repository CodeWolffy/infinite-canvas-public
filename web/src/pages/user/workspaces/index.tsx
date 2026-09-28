import { useCallback, useEffect, useState } from "react";
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
    const adoptProject = useCanvasStore((state) => state.adoptProject);
    const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
    const [loading, setLoading] = useState(true);
    const [detail, setDetail] = useState<WorkspaceDetail | null>(null);
    const [detailLoading, setDetailLoading] = useState(false);
    const [creating, setCreating] = useState(false);
    const [name, setName] = useState("");
    const [renameOpen, setRenameOpen] = useState(false);
    const [renameDraft, setRenameDraft] = useState("");
    const [renaming, setRenaming] = useState(false);
    const [memberName, setMemberName] = useState("");
    const [memberRole, setMemberRole] = useState<"editor" | "viewer">("editor");
    const [memberSaving, setMemberSaving] = useState(false);
    const selectedId = searchParams.get("id") || workspaces[0]?.id || "";

    const reloadList = useCallback(async () => {
        const items = await listWorkspaces();
        setWorkspaces(items);
        return items;
    }, []);
    const reloadDetail = useCallback(async (id: string) => {
        if (!id) {
            setDetail(null);
            return;
        }
        setDetailLoading(true);
        try {
            setDetail(await getWorkspace(id));
        } catch (error) {
            message.error(error instanceof Error ? error.message : t("workspace.loadFailed"));
            setDetail(null);
        } finally {
            setDetailLoading(false);
        }
    }, [message, t]);

    useEffect(() => {
        setLoading(true);
        reloadList()
            .catch((error) => message.error(error instanceof Error ? error.message : t("workspace.loadFailed")))
            .finally(() => setLoading(false));
    }, [reloadList, message, t]);
    useEffect(() => {
        void reloadDetail(selectedId);
    }, [selectedId, reloadDetail]);

    const select = (id: string) => setSearchParams(id ? { id } : {});
    const isOwner = detail?.workspace.myRole === "owner" || (detail ? detail.workspace.ownerId === user?.id : false);

    const create = async () => {
        const trimmed = name.trim();
        if (!trimmed) return;
        setCreating(true);
        try {
            const workspace = await createWorkspace(trimmed);
            setName("");
            await reloadList();
            select(workspace.id);
            message.success(t("workspace.created"));
        } catch (error) {
            message.error(error instanceof Error ? error.message : t("workspace.createFailed"));
        } finally {
            setCreating(false);
        }
    };
    const addMember = async () => {
        const username = memberName.trim();
        if (!username || !detail) return;
        setMemberSaving(true);
        try {
            await addWorkspaceMember(detail.workspace.id, username, memberRole);
            setMemberName("");
            await reloadDetail(detail.workspace.id);
            message.success(t("workspace.memberAdded"));
        } catch (error) {
            message.error(error instanceof Error ? error.message : t("workspace.memberAddFailed"));
        } finally {
            setMemberSaving(false);
        }
    };
    const openRename = () => {
        if (!detail) return;
        setRenameDraft(detail.workspace.name);
        setRenameOpen(true);
    };
    const saveRename = async () => {
        if (!detail) return;
        const next = renameDraft.trim();
        if (!next) return;
        if (next === detail.workspace.name) {
            setRenameOpen(false);
            return;
        }
        setRenaming(true);
        try {
            await updateWorkspace(detail.workspace.id, next);
            setRenameOpen(false);
            await Promise.all([reloadList(), reloadDetail(detail.workspace.id)]);
            message.success(t("workspace.moved"));
        } catch (error) {
            message.error(error instanceof Error ? error.message : t("workspace.renameFailed"));
        } finally {
            setRenaming(false);
        }
    };
    const removeWorkspace = async () => {
        if (!detail) return;
        try {
            await deleteWorkspace(detail.workspace.id);
            select("");
            await reloadList();
            setDetail(null);
            message.success(t("workspace.deleted"));
        } catch (error) {
            message.error(error instanceof Error ? error.message : t("workspace.deleteFailed"));
        }
    };
    const leave = async () => {
        if (!detail || !user) return;
        try {
            await removeWorkspaceMember(detail.workspace.id, user.id);
            select("");
            await reloadList();
            setDetail(null);
            message.success(t("workspace.left"));
        } catch (error) {
            message.error(error instanceof Error ? error.message : t("workspace.leaveFailed"));
        }
    };
    const createCanvas = async () => {
        if (!detail) return;
        try {
            const record = await createCanvasProject({ title: t("canvas.project.untitled"), snapshot: { nodes: [], connections: [] }, workspaceId: detail.workspace.id });
            adoptProject(record);
            navigate(`/canvas/${record.id}`);
        } catch (error) {
            message.error(error instanceof Error ? error.message : t("workspace.createCanvasFailed"));
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
                                                            onChange={(role) => void updateWorkspaceMember(detail.workspace.id, member.userId, role).then(() => reloadDetail(detail.workspace.id)).catch((error) => message.error(error instanceof Error ? error.message : t("workspace.roleFailed")))}
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
                                                            onClick={() => void removeWorkspaceMember(detail.workspace.id, member.userId).then(() => reloadDetail(detail.workspace.id)).then(reloadList).catch((error) => message.error(error instanceof Error ? error.message : t("workspace.removeFailed")))}
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

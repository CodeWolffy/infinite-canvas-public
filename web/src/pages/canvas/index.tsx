import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { App, Button, Input, Select, Spin } from "antd";
import { Download, FileUp, LayoutTemplate, Plus } from "lucide-react";
import { useTranslation } from "react-i18next";

import { readZip } from "@/lib/zip";
import { uploadMediaFile } from "@/services/file-storage";
import { uploadImage } from "@/services/image-storage";
import { mediaUrl } from "@/services/api/media";
import type { CanvasProjectQuery } from "@/services/api/canvas-projects";
import { listWorkspaces, type Workspace } from "@/services/api/workspaces";
import { CanvasDeleteProjectsDialog } from "@/components/canvas/canvas-delete-projects-dialog";
import { CanvasProjectCard } from "@/components/canvas/canvas-project-card";
import { TemplatePickerModal } from "@/pages/canvas/template-picker-modal";
import type { CanvasExportFile } from "@/types/canvas-export";
import { useCanvasStore } from "@/stores/canvas/use-canvas-store";
import { useCanvasUiStore } from "@/stores/canvas/use-canvas-ui-store";
import { assertCurrentSession, useUserStore } from "@/stores/use-user-store";
import { exportCanvasProjects } from "@/lib/canvas/canvas-export";
import { hasAgentUrlBootstrap } from "@/lib/agent/agent-url-bootstrap";

export default function CanvasPage() {
    const { message } = App.useApp();
    const { t } = useTranslation();
    const navigate = useNavigate();
    const [searchParams, setSearchParams] = useSearchParams();
    const inputRef = useRef<HTMLInputElement>(null);
    const autoOpenRef = useRef(false);
    const [templatesOpen, setTemplatesOpen] = useState(Boolean(searchParams.get("templateKeyword")));
    const [loadingAllProjects, setLoadingAllProjects] = useState(false);
    const [keywordInput, setKeywordInput] = useState("");
    const [keyword, setKeyword] = useState("");
    const [workspaceId, setWorkspaceId] = useState("");
    const [sort, setSort] = useState<NonNullable<CanvasProjectQuery["sort"]>>("updated_desc");
    const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
    const [refreshRequest, setRefreshRequest] = useState(0);
    const sessionVersion = useUserStore((state) => state.sessionVersion);
    const hydrated = useCanvasStore((state) => state.hydrated);
    const projects = useCanvasStore((state) => state.projects);
    const projectListIds = useCanvasStore((state) => state.projectListIds);
    const projectListLoading = useCanvasStore((state) => state.projectListLoading);
    const projectListError = useCanvasStore((state) => state.projectListError);
    const projectTotal = useCanvasStore((state) => state.projectTotal);
    const loadMoreProjects = useCanvasStore((state) => state.loadMoreProjects);
    const refreshProjectList = useCanvasStore((state) => state.refreshProjectList);
    const createProject = useCanvasStore((state) => state.createProject);
    const adoptProject = useCanvasStore((state) => state.adoptProject);
    const importProject = useCanvasStore((state) => state.importProject);
    const loadProjects = useCanvasStore((state) => state.loadProjects);
    const selectedIds = useCanvasUiStore((state) => state.selectedProjectIds);
    const setDeleteIds = useCanvasUiStore((state) => state.setDeleteProjectIds);

    const listedProjects = useMemo(() => {
        const byId = new Map(projects.map((project) => [project.id, project]));
        return projectListIds.flatMap((id) => byId.get(id) || []);
    }, [projects, projectListIds]);
    const deletableSelectedIds = selectedIds.filter((id) => projects.some((project) => project.id === id && project.canDelete));
    const filtered = Boolean(keyword || workspaceId);
    useEffect(() => { setLoadingAllProjects(false); setKeywordInput(""); setKeyword(""); setWorkspaceId(""); setSort("updated_desc"); }, [sessionVersion]);

    const mode = searchParams.get("mode");
    const agentMode = mode === "new" || mode === "recent" || mode === "choose";
    const agentQuery = agentMode ? `?${searchParams.toString()}` : "";
    const templateKeyword = searchParams.get("templateKeyword") || "";
    useEffect(() => { autoOpenRef.current = false; }, [mode, sessionVersion]);
    useEffect(() => { if (templateKeyword) setTemplatesOpen(true); }, [templateKeyword]);
    useEffect(() => {
        if (!hydrated || mode === "new" || mode === "recent") return;
        void refreshProjectList({ keyword, workspaceId, sort }).catch(() => undefined);
    }, [hydrated, keyword, mode, refreshProjectList, refreshRequest, sessionVersion, sort, workspaceId]);
    useEffect(() => {
        let active = true;
        setWorkspaces([]);
        void listWorkspaces()
            .then((items) => { if (active && useUserStore.getState().sessionVersion === sessionVersion) setWorkspaces(items); })
            .catch((error: unknown) => { if (active && useUserStore.getState().sessionVersion === sessionVersion) message.error(error instanceof Error ? error.message : "工作区加载失败"); });
        return () => { active = false; };
    }, [message, sessionVersion]);
    const enterProject = (id: string) => {
        const agentHash = hasAgentUrlBootstrap(window.location.hash) ? window.location.hash : "";
        navigate(`/canvas/${id}${agentQuery}${agentHash}`, { replace: Boolean(agentHash) });
    };
    const createAndEnter = async () => {
        const sessionVersion = useUserStore.getState().sessionVersion;
        try {
            const id = await createProject(t("canvas.defaultTitle", { count: projects.length + 1 }));
            assertCurrentSession(sessionVersion);
            enterProject(id);
        } catch (error) {
            if (useUserStore.getState().sessionVersion === sessionVersion) message.error(error instanceof Error ? error.message : t("common.requestFailed"));
        }
    };
    // 列表只有元数据，导出前先把选中项目的完整快照拉回来。
    const exportSelected = async () => {
        const sessionVersion = useUserStore.getState().sessionVersion;
        const loaded = await loadProjects(selectedIds);
        assertCurrentSession(sessionVersion);
        await exportCanvasProjects(loaded, `${t("canvas.title")}-${selectedIds.length}`);
    };
    const selectAllForDeletion = async () => {
        const sessionVersion = useUserStore.getState().sessionVersion;
        const query = useCanvasStore.getState().projectQuery;
        setLoadingAllProjects(true);
        try {
            while (useCanvasStore.getState().projectListIds.length < useCanvasStore.getState().projectTotal) {
                const before = useCanvasStore.getState().projectListIds.length;
                await loadMoreProjects();
                assertCurrentSession(sessionVersion);
                if (useCanvasStore.getState().projectQuery !== query || useCanvasStore.getState().projectListIds.length <= before) throw new Error(t("common.requestFailed"));
            }
            assertCurrentSession(sessionVersion);
            const state = useCanvasStore.getState();
            const listed = new Set(state.projectListIds);
            const deletableIds = state.projects.filter((project) => listed.has(project.id) && project.canDelete).map((project) => project.id);
            if (deletableIds.length) setDeleteIds(deletableIds);
        } catch (error) {
            if (useUserStore.getState().sessionVersion === sessionVersion) message.error(error instanceof Error ? error.message : t("common.requestFailed"));
        } finally {
            if (useUserStore.getState().sessionVersion === sessionVersion) setLoadingAllProjects(false);
        }
    };
    const importCanvas = async (file?: File) => {
        if (!file) return;
        const sessionVersion = useUserStore.getState().sessionVersion;
        try {
            const zip = await readZip(file);
            const projectFile = zip.get("projects.json");
            if (!projectFile) throw new Error("missing projects.json");
            const data = JSON.parse(await projectFile.text()) as CanvasExportFile;
            assertCurrentSession(sessionVersion);
            const storageKeys = new Map<string, string>();
            await Promise.all(
                data.projects.flatMap((project) =>
                    project.files.map(async (item) => {
                        assertCurrentSession(sessionVersion);
                        const blob = zip.get(item.path);
                        if (!blob) return;
                        const typedBlob = blob.type ? blob : blob.slice(0, blob.size, item.mimeType);
                        if (typedBlob.type.startsWith("image/")) {
                            const image = await uploadImage(typedBlob);
                            assertCurrentSession(sessionVersion);
                            storageKeys.set(item.storageKey, image.storageKey);
                            storageKeys.set(mediaUrl(item.storageKey), image.url);
                        } else {
                            const media = await uploadMediaFile(typedBlob);
                            assertCurrentSession(sessionVersion);
                            storageKeys.set(item.storageKey, media.storageKey);
                            storageKeys.set(mediaUrl(item.storageKey), media.url);
                        }
                    }),
                ),
            );
            assertCurrentSession(sessionVersion);
            const replaceStorageKeys = (value: unknown): unknown => {
                if (typeof value === "string") return storageKeys.get(value) || value;
                if (Array.isArray(value)) return value.map(replaceStorageKeys);
                if (!value || typeof value !== "object") return value;
                return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, replaceStorageKeys(item)]));
            };
            await Promise.all(data.projects.map((item) => { assertCurrentSession(sessionVersion); return importProject(replaceStorageKeys(item.project) as typeof item.project); }));
            assertCurrentSession(sessionVersion);
            message.success(t("canvas.imported", { count: data.projects.length }));
            void refreshProjectList(useCanvasStore.getState().projectQuery).catch(() => undefined);
        } catch {
            if (useUserStore.getState().sessionVersion !== sessionVersion) return;
            message.error(t("canvas.importFailed"));
        } finally {
            if (useUserStore.getState().sessionVersion === sessionVersion && inputRef.current) inputRef.current.value = "";
        }
    };

    useEffect(() => {
        if (!hydrated || autoOpenRef.current || (mode !== "new" && mode !== "recent")) return;
        autoOpenRef.current = true;
        const sessionVersion = useUserStore.getState().sessionVersion;
        void (async () => {
            try {
                if (mode === "recent") await refreshProjectList({});
                assertCurrentSession(sessionVersion);
                const id = mode === "recent" && useCanvasStore.getState().projectListIds[0] || await createProject(t("canvas.defaultTitle", { count: useCanvasStore.getState().projects.length + 1 }));
                assertCurrentSession(sessionVersion);
                enterProject(id);
            } catch (error) {
                if (useUserStore.getState().sessionVersion === sessionVersion) message.error(error instanceof Error ? error.message : t("common.requestFailed"));
            }
        })();
    }, [createProject, hydrated, message, mode, refreshProjectList, sessionVersion, t]);

    if (hydrated && (mode === "new" || mode === "recent")) return <main className="flex h-full items-center justify-center bg-background text-sm text-muted-foreground">{t("canvas.opening")}</main>;

    const closeTemplates = () => {
        setTemplatesOpen(false);
        if (searchParams.has("templateKeyword")) {
            const next = new URLSearchParams(searchParams);
            next.delete("templateKeyword");
            setSearchParams(next, { replace: true });
        }
    };
    const resetFilters = () => { setKeywordInput(""); setKeyword(""); setWorkspaceId(""); setSort("updated_desc"); };
    const loadMore = async () => {
        const sessionVersion = useUserStore.getState().sessionVersion;
        try { await loadMoreProjects(); } catch (error) { if (useUserStore.getState().sessionVersion === sessionVersion) message.error(error instanceof Error ? error.message : t("common.requestFailed")); }
    };

    return (
        <main className="h-full overflow-auto bg-background text-foreground">
            <div className="mx-auto flex w-full max-w-6xl flex-col gap-8 px-6 py-10">
                <header className="flex flex-wrap items-end justify-between gap-4 border-b border-border pb-6">
                    <div>
                        <p className="text-xs text-muted-foreground">{t("canvas.library")}</p>
                        <h1 className="mt-3 text-3xl font-semibold">{t("canvas.title")}</h1>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                        {selectedIds.length ? (
                            <>
                                <Button disabled={!hydrated} icon={<Download className="size-4" />} onClick={() => void exportSelected()}>
                                    {t("canvas.exportSelected")}
                                </Button>
                                <Button disabled={!hydrated || !deletableSelectedIds.length} onClick={() => setDeleteIds(deletableSelectedIds)}>
                                    {deletableSelectedIds.length < selectedIds.length ? "删除可删除的选中项" : t("canvas.deleteSelected")}
                                </Button>
                            </>
                        ) : null}
                        {listedProjects.some((project) => project.canDelete) ? (
                            <Button disabled={!hydrated || projectListLoading || loadingAllProjects} loading={loadingAllProjects} onClick={() => void selectAllForDeletion()}>
                                {filtered ? "删除筛选结果" : t("canvas.deleteAll")}
                            </Button>
                        ) : null}
                        <Button disabled={!hydrated} icon={<FileUp className="size-4" />} onClick={() => inputRef.current?.click()}>
                            {t("canvas.import")}
                        </Button>
                        <Button disabled={!hydrated} icon={<LayoutTemplate className="size-4" />} onClick={() => setTemplatesOpen(true)}>
                            {t("templates.createFromTemplate")}
                        </Button>
                        <Button disabled={!hydrated} type="primary" icon={<Plus className="size-4" />} onClick={() => void createAndEnter()}>
                            {t("canvas.create")}
                        </Button>
                    </div>
                </header>

                <section aria-label="搜索和筛选画布" className="flex flex-col gap-3">
                    <div className="flex flex-wrap items-center gap-3">
                        <Input.Search aria-label="按标题搜索画布" placeholder="按标题搜索全部画布" value={keywordInput} allowClear disabled={loadingAllProjects} onChange={(event) => { setKeywordInput(event.target.value); if (!event.target.value) setKeyword(""); }} onSearch={(value) => setKeyword(value.trim())} className="min-w-48 flex-1 sm:max-w-sm" />
                        <Select aria-label="筛选所属工作区" value={workspaceId} disabled={loadingAllProjects} onChange={setWorkspaceId} className="min-w-40" options={[{ value: "", label: "所有画布" }, { value: "personal", label: "个人画布" }, ...workspaces.map((workspace) => ({ value: workspace.id, label: workspace.name }))]} />
                        <Select aria-label="画布排序" value={sort} disabled={loadingAllProjects} onChange={setSort} className="min-w-36" options={[{ value: "updated_desc", label: "最近更新" }, { value: "created_desc", label: "最新创建" }, { value: "created_asc", label: "最早创建" }, { value: "title_asc", label: "标题顺序" }]} />
                        {filtered ? <Button type="text" disabled={loadingAllProjects} onClick={resetFilters}>清空筛选</Button> : null}
                    </div>
                    <p aria-live="polite" className="text-xs text-muted-foreground">{projectListLoading && !listedProjects.length ? "正在搜索…" : `${filtered ? "匹配" : "共"} ${projectTotal} 个画布 · 已显示 ${listedProjects.length} 个`}</p>
                </section>

                {!hydrated || projectListLoading && !listedProjects.length ? (
                    <section className="flex min-h-[360px] items-center justify-center text-sm text-muted-foreground"><Spin /></section>
                ) : projectListError ? (
                    <section className="flex min-h-60 flex-col items-center justify-center gap-4 text-sm text-muted-foreground"><p>{projectListError}</p><Button onClick={() => setRefreshRequest((value) => value + 1)}>重新加载</Button></section>
                ) : listedProjects.length ? (
                    <div className="flex flex-col gap-6">
                        <div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-3">
                            {listedProjects.map((project) => (
                                <CanvasProjectCard key={project.id} project={project} />
                            ))}
                        </div>
                        {projectTotal > projectListIds.length ? (
                            <Button className="mx-auto" type="text" disabled={!hydrated || loadingAllProjects} loading={projectListLoading} onClick={() => void loadMore()}>
                                {t("canvas.loadMore")}
                            </Button>
                        ) : null}
                    </div>
                ) : (
                    <section className="flex min-h-[360px] flex-col items-center justify-center border-y border-border text-center">
                        <h2 className="text-xl font-medium">{filtered ? "没有找到匹配的画布" : t("canvas.empty")}</h2>
                        <p className="mt-3 text-sm text-muted-foreground">{filtered ? "试试其他标题关键词或工作区。" : t("canvas.emptyDescription")}</p>
                        {filtered ? <Button type="text" className="mt-6" onClick={resetFilters}>查看全部画布</Button> : <Button type="primary" className="mt-6" icon={<Plus className="size-4" />} onClick={() => void createAndEnter()}>{t("canvas.create")}</Button>}
                    </section>
                )}
            </div>

            <input ref={inputRef} type="file" accept="application/zip,.zip" className="hidden" onChange={(event) => void importCanvas(event.target.files?.[0])} />
            <CanvasDeleteProjectsDialog />
            <TemplatePickerModal
                open={templatesOpen}
                initialKeyword={templateKeyword}
                onClose={closeTemplates}
                onCreated={(project) => {
                    setTemplatesOpen(false);
                    // 模板生成的画布已由服务端创建，直接落入本地列表后跳转。
                    navigate(`/canvas/${adoptProject(project)}`);
                }}
            />
        </main>
    );
}

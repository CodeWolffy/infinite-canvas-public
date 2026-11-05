import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { App, Button, Empty, Input, Modal, Spin, theme } from "antd";
import { Check, LayoutGrid, Plus } from "lucide-react";

import { listCanvasProjects, type CanvasProjectSummary } from "@/services/api/canvas-projects";
import { useCanvasHandoffStore } from "@/stores/canvas/use-canvas-handoff-store";
import { useCanvasStore } from "@/stores/canvas/use-canvas-store";

export function AddToCanvasModal() {
    const request = useCanvasHandoffStore((state) => state.request);
    const navigate = useNavigate();
    const { message } = App.useApp();
    const { token } = theme.useToken();
    const [keyword, setKeyword] = useState("");
    const [projects, setProjects] = useState<CanvasProjectSummary[]>([]);
    const [total, setTotal] = useState(0);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState("");
    const [selectedId, setSelectedId] = useState<string | null>(null);
    const [newCanvas, setNewCanvas] = useState(false);
    const [title, setTitle] = useState("");
    const [creating, setCreating] = useState(false);
    const creatingRef = useRef(false);
    const loadingRef = useRef(false);
    const loadVersion = useRef(0);
    const requestId = request?.id;

    useEffect(() => {
        const version = ++loadVersion.current;
        let disposed = false;
        setLoading(true);
        loadingRef.current = true;
        setError("");
        setProjects([]);
        setTotal(0);
        setSelectedId(null);
        void listCanvasProjects(0, { keyword }).then((result) => {
            if (disposed || version !== loadVersion.current || !requestId || !useCanvasHandoffStore.getState().isCurrent(requestId)) return;
            setProjects(result.projects);
            setTotal(result.total);
        }).catch((error: unknown) => {
            if (!disposed && requestId && useCanvasHandoffStore.getState().isCurrent(requestId)) setError(error instanceof Error ? error.message : "画布加载失败");
        }).finally(() => {
            if (!disposed && version === loadVersion.current) { setLoading(false); loadingRef.current = false; }
        });
        return () => { disposed = true; };
    }, [keyword, requestId]);

    if (!request || request.projectId) return null;
    const current = () => useCanvasHandoffStore.getState().isCurrent(request.id);
    const cancel = () => useCanvasHandoffStore.getState().cancel(request.id);
    const loadMore = async () => {
        if (loadingRef.current || !current()) return;
        const version = loadVersion.current;
        loadingRef.current = true;
        setLoading(true);
        setError("");
        try {
            const result = await listCanvasProjects(projects.length, { keyword });
            if (!current() || version !== loadVersion.current) return;
            setProjects((previous) => [...previous, ...result.projects]);
            setTotal(result.total);
        } catch (error) {
            if (current() && version === loadVersion.current) setError(error instanceof Error ? error.message : "画布加载失败");
        } finally {
            if (current() && version === loadVersion.current) { setLoading(false); loadingRef.current = false; }
        }
    };
    const confirm = async () => {
        if (creatingRef.current || !current()) return;
        const selected = projects.find((project) => project.id === selectedId);
        if (!newCanvas && selected?.accessRole !== "owner" && selected?.accessRole !== "editor") return;
        creatingRef.current = true;
        setCreating(true);
        try {
            const projectId = newCanvas ? await useCanvasStore.getState().createProject(title.trim() || "未命名画布") : selected!.id;
            if (!current() || !useCanvasHandoffStore.getState().target(request.id, projectId)) return;
            navigate(`/canvas/${projectId}`, { state: { canvasHandoffId: request.id } });
        } catch (error) {
            if (current()) message.error(error instanceof Error ? error.message : "创建画布失败");
        } finally {
            creatingRef.current = false;
            if (current()) setCreating(false);
        }
    };

    return (
        <Modal open title="加入画布" onCancel={cancel} onOk={() => void confirm()} okText={newCanvas ? "创建并加入" : "加入所选画布"} cancelText="取消" okButtonProps={{ loading: creating, disabled: !newCanvas && !selectedId }} width={560}>
            <p className="mb-4 text-sm" style={{ color: token.colorTextSecondary }}>将 {request.items.length} 项内容加入画布，继续编排与创作。</p>
            <button type="button" className="mb-4 flex w-full items-center gap-3 rounded-lg px-3 py-3 text-left transition hover:bg-black/5 dark:hover:bg-white/10" style={{ color: token.colorText, outline: newCanvas ? `1px solid ${token.colorPrimary}` : undefined }} onClick={() => { setNewCanvas(true); setSelectedId(null); }}>
                <Plus className="size-5" /><span className="flex-1">新建画布</span>{newCanvas ? <Check className="size-4" style={{ color: token.colorPrimary }} /> : null}
            </button>
            {newCanvas ? <Input className="mb-4" value={title} onChange={(event) => setTitle(event.target.value)} placeholder="画布名称（可选）" aria-label="新画布名称" /> : null}
            <Input.Search allowClear placeholder="搜索全部画布" aria-label="搜索全部画布" onSearch={setKeyword} />
            <div className="mt-3 max-h-72 space-y-1 overflow-y-auto">
                {projects.map((project) => {
                    const editable = project.accessRole === "owner" || project.accessRole === "editor";
                    const selected = selectedId === project.id;
                    return <button key={project.id} type="button" disabled={!editable} title={!editable ? "此画布没有编辑权限" : project.title} className="flex w-full items-center gap-3 rounded-lg px-3 py-3 text-left transition enabled:hover:bg-black/5 disabled:cursor-not-allowed disabled:opacity-50 dark:enabled:hover:bg-white/10" style={{ background: selected ? token.controlItemBgActive : undefined }} onClick={() => { setSelectedId(project.id); setNewCanvas(false); }}>
                        <LayoutGrid className="size-5 shrink-0" style={{ color: token.colorTextSecondary }} />
                        <span className="min-w-0 flex-1"><span className="block truncate">{project.title}</span><span className="mt-0.5 block text-xs" style={{ color: token.colorTextSecondary }}>{project.workspaceName || "个人画布"} · {project.nodeCount} 个节点{!editable ? " · 只读" : ""}</span></span>
                        {selected ? <Check className="size-4 shrink-0" style={{ color: token.colorPrimary }} /> : null}
                    </button>;
                })}
                {!loading && !projects.length && !error ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={keyword ? "未找到匹配画布" : "还没有画布，可在上方新建"} /> : null}
                {loading && !projects.length ? <div className="flex justify-center py-8"><Spin /></div> : null}
            </div>
            {error ? <div className="mt-3 text-sm" style={{ color: token.colorError }}>{error}<Button type="link" size="small" onClick={() => void loadMore()}>重试</Button></div> : null}
            {projects.length < total ? <Button block type="text" className="mt-2" loading={loading} onClick={() => void loadMore()}>加载更多</Button> : null}
        </Modal>
    );
}

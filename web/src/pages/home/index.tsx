import { useEffect, useMemo, useState } from "react";
import { App, Button, Empty, Input, Skeleton } from "antd";
import { ArrowRight, Bot, ImagePlus, MessageSquare, Plus, Video } from "lucide-react";
import { useNavigate } from "react-router-dom";

import { CanvasProjectCard } from "@/components/canvas/canvas-project-card";
import { CanvasSizePicker } from "@/components/canvas/canvas-size-picker";
import { ModelPicker } from "@/components/model-picker";
import { PromptCard } from "@/components/prompts/prompt-card";
import { PromptDetailDialog } from "@/components/prompts/prompt-detail-dialog";
import { usePromptCreation } from "@/hooks/use-prompt-creation";
import { cn } from "@/lib/utils";
import { fetchPrompts, type Prompt } from "@/services/api/prompts";
import { useCanvasStore } from "@/stores/canvas/use-canvas-store";
import { useAgentStore } from "@/stores/use-agent-store";
import { modelOptionName, resolveModelForCapability, useConfigStore } from "@/stores/use-config-store";
import { useCreationDraftStore, type CreationDraftInput } from "@/stores/use-creation-draft-store";
import { assertCurrentSession, useUserStore } from "@/stores/use-user-store";
import { CreationScenes } from "./components/creation-scenes";

const creationModes = [
    { value: "image", label: "图片", icon: ImagePlus, placeholder: "描述你想创作的画面、主体、风格和用途…" },
    { value: "video", label: "视频", icon: Video, placeholder: "描述场景、人物动作、镜头运动和氛围…" },
    { value: "text", label: "文本", icon: MessageSquare, placeholder: "写下问题，或描述要完成的文案、脚本和创意…" },
] as const;

export default function IndexPage() {
    const { message } = App.useApp();
    const navigate = useNavigate();
    const startPromptCreation = usePromptCreation();
    const sessionVersion = useUserStore((state) => state.sessionVersion);
    const config = useConfigStore((state) => state.config);
    const updateConfig = useConfigStore((state) => state.updateConfig);
    const projects = useCanvasStore((state) => state.projects);
    const projectListIds = useCanvasStore((state) => state.projectListIds);
    const refreshProjectList = useCanvasStore((state) => state.refreshProjectList);
    const hydrated = useCanvasStore((state) => state.hydrated);
    const createProject = useCanvasStore((state) => state.createProject);
    const [capability, setCapability] = useState<CreationDraftInput["capability"]>("image");
    const [prompt, setPrompt] = useState("");
    const [promptShowcase, setPromptShowcase] = useState<Prompt[]>([]);
    const [showcaseLoading, setShowcaseLoading] = useState(true);
    const [showcaseError, setShowcaseError] = useState("");
    const [showcaseRequest, setShowcaseRequest] = useState(0);
    const [selectedPrompt, setSelectedPrompt] = useState<Prompt | null>(null);
    const [creatingCanvas, setCreatingCanvas] = useState(false);
    const [recentReady, setRecentReady] = useState(false);
    const [recentError, setRecentError] = useState("");
    const [recentRequest, setRecentRequest] = useState(0);
    const mode = creationModes.find((item) => item.value === capability)!;
    const modelKey = capability === "image" ? "imageModel" : capability === "video" ? "videoModel" : "textModel";
    const model = resolveModelForCapability(config, config[modelKey], capability);
    const recentProjects = useMemo(() => {
        const byId = new Map(projects.map((project) => [project.id, project]));
        return projectListIds.slice(0, 3).flatMap((id) => byId.get(id) || []);
    }, [projectListIds, projects]);

    useEffect(() => { setPrompt(""); setCreatingCanvas(false); }, [sessionVersion]);
    useEffect(() => {
        if (!hydrated) return;
        let active = true;
        setRecentReady(false);
        setRecentError("");
        void refreshProjectList({})
            .catch((error: unknown) => { if (active && useUserStore.getState().sessionVersion === sessionVersion) setRecentError(error instanceof Error ? error.message : "画布加载失败"); })
            .finally(() => { if (active && useUserStore.getState().sessionVersion === sessionVersion) setRecentReady(true); });
        return () => { active = false; };
    }, [hydrated, recentRequest, refreshProjectList, sessionVersion]);
    useEffect(() => {
        let active = true;
        setPromptShowcase([]);
        setSelectedPrompt(null);
        setShowcaseLoading(true);
        setShowcaseError("");
        void fetchPrompts({ pageSize: 12 })
            .then((data) => { if (active && useUserStore.getState().sessionVersion === sessionVersion) setPromptShowcase(data.items); })
            .catch((error: unknown) => { if (active && useUserStore.getState().sessionVersion === sessionVersion) setShowcaseError(error instanceof Error ? error.message : "提示词加载失败"); })
            .finally(() => { if (active && useUserStore.getState().sessionVersion === sessionVersion) setShowcaseLoading(false); });
        return () => { active = false; };
    }, [sessionVersion, showcaseRequest]);

    const startCreation = () => {
        if (!prompt.trim()) return;
        const settings = capability === "image" ? { size: config.size, quality: config.quality, count: config.count, background: config.background } : capability === "video" ? { videoSeconds: config.videoSeconds, vquality: config.vquality, videoMode: config.videoMode } : undefined;
        useCreationDraftStore.getState().setDraft({ capability, prompt: prompt.trim(), modelId: model ? modelOptionName(model) : undefined, settings, sourceTitle: "首页创作" });
        navigate(`/${capability}`);
    };
    const newCanvas = async () => {
        const sessionVersion = useUserStore.getState().sessionVersion;
        setCreatingCanvas(true);
        try {
            const id = await createProject();
            assertCurrentSession(sessionVersion);
            navigate(`/canvas/${id}`);
        } catch (error) {
            if (useUserStore.getState().sessionVersion === sessionVersion) message.error(error instanceof Error ? error.message : "创建画布失败");
        } finally {
            if (useUserStore.getState().sessionVersion === sessionVersion) setCreatingCanvas(false);
        }
    };

    return (
        <main className="h-full overflow-y-auto bg-background text-foreground">
            <div className="mx-auto flex max-w-6xl flex-col gap-10 px-5 py-8 sm:px-8 sm:py-10">
                <section aria-labelledby="home-creation-title">
                    <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
                        <div><h1 id="home-creation-title" className="text-3xl font-semibold tracking-tight">从一个想法开始</h1><p className="mt-2 text-sm text-muted-foreground">写下内容，选择创作方式。</p></div>
                        <div className="flex items-center gap-1">
                            <Button type="text" disabled={!hydrated} loading={creatingCanvas} icon={<Plus className="size-4" />} onClick={() => void newCanvas()}>新建画布</Button>
                            <Button type="text" icon={<Bot className="size-4" />} onClick={() => useAgentStore.getState().openPanel()}>本地 Agent</Button>
                        </div>
                    </div>
                    <div className="rounded-2xl border border-border bg-card px-4 pb-4 sm:px-5">
                        <div className="flex gap-5 border-b border-border/70">
                            {creationModes.map((item) => <button key={item.value} type="button" aria-pressed={capability === item.value} onClick={() => setCapability(item.value)} className={cn("inline-flex cursor-pointer items-center gap-2 border-b-2 py-3.5 text-sm transition", capability === item.value ? "border-foreground text-foreground" : "border-transparent text-muted-foreground hover:text-foreground")}><item.icon className="size-4" />{item.label}</button>)}
                        </div>
                        <Input.TextArea aria-label={`${mode.label}创作内容`} variant="borderless" value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder={mode.placeholder} autoSize={{ minRows: 3, maxRows: 7 }} className="!px-0 !py-4 !text-base" />
                        <div className="flex flex-wrap items-center justify-between gap-3">
                            <div className="flex min-w-0 flex-wrap items-center gap-2">
                                <ModelPicker config={config} value={model} onChange={(value) => updateConfig(modelKey, value)} capability={capability} className="!rounded-lg !border-0 !px-1 !shadow-none" placeholder="在工作台选择模型" />
                                {capability === "image" ? <CanvasSizePicker value={config.size} onChange={(value) => updateConfig("size", value)} className="h-8 w-24" /> : null}
                            </div>
                            <Button type="primary" disabled={!prompt.trim()} icon={<ArrowRight className="size-4" />} iconPlacement="end" onClick={startCreation}>带入{mode.label}工作台</Button>
                        </div>
                    </div>
                    <p className="mt-3 text-xs leading-5 text-muted-foreground">进入工作台后可继续编辑、添加参考素材，并确认模型、参数与费用后生成。</p>
                </section>

                <section aria-labelledby="home-recent-title">
                    <div className="mb-4 flex items-center justify-between gap-3"><h2 id="home-recent-title" className="text-xl font-semibold tracking-tight">最近的画布</h2><Button type="text" icon={<ArrowRight className="size-4" />} iconPlacement="end" onClick={() => navigate("/canvas")}>全部画布</Button></div>
                    {!hydrated || !recentReady ? <div className="grid gap-4 sm:grid-cols-3">{[0, 1, 2].map((key) => <Skeleton key={key} active className="rounded-xl border border-border p-5" />)}</div> : recentError ? <div className="flex items-center justify-between gap-3 rounded-xl border border-border p-5"><p className="text-sm text-muted-foreground">{recentError}</p><Button onClick={() => setRecentRequest((value) => value + 1)}>重新加载</Button></div> : recentProjects.length ? <div className="grid gap-4 sm:grid-cols-3">{recentProjects.map((project) => <CanvasProjectCard key={project.id} project={project} compact />)}</div> : <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-dashed border-border p-6"><p className="text-sm text-muted-foreground">把灵感、素材和生成结果放进同一张画布。</p><Button type="text" loading={creatingCanvas} icon={<Plus className="size-4" />} onClick={() => void newCanvas()}>创建第一张画布</Button></div>}
                </section>

                <CreationScenes />

                <section aria-labelledby="home-showcase-title" className="pb-5">
                    <div className="mb-5 flex flex-wrap items-end justify-between gap-3"><div><h2 id="home-showcase-title" className="text-xl font-semibold tracking-tight">精选提示词作品</h2><p className="mt-1 text-sm text-muted-foreground">查看画面和提示词，再带入自己的创作。</p></div><Button type="text" icon={<ArrowRight className="size-4" />} iconPlacement="end" onClick={() => navigate("/prompts")}>浏览提示词库</Button></div>
                    {showcaseLoading ? <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">{[0, 1, 2, 3].map((key) => <Skeleton key={key} active className="rounded-xl border border-border p-5" />)}</div> : promptShowcase.length ? <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">{promptShowcase.map((item) => <PromptCard key={`${item.sourceId}:${item.id}`} item={item} onOpen={() => setSelectedPrompt(item)} onCopy={() => startPromptCreation(item)} actionLabel="用此创作" actionIcon={<ArrowRight className="size-3.5" />} />)}</div> : <div className="rounded-xl border border-border py-5"><Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={showcaseError || "暂无精选提示词作品"}>{showcaseError ? <Button onClick={() => setShowcaseRequest((value) => value + 1)}>重新加载</Button> : <Button type="text" onClick={() => navigate("/prompts")}>打开提示词库</Button>}</Empty></div>}
                </section>
            </div>
            <PromptDetailDialog prompt={selectedPrompt} onClose={() => setSelectedPrompt(null)} />
        </main>
    );
}

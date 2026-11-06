import { useEffect, useMemo, useRef, useState } from "react";
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
import { getWorkbenchDraft, saveWorkbenchDraft, clearWorkbenchDraft } from "@/stores/use-workbench-draft-store";
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
    const [capability, setCapability] = useState<CreationDraftInput["capability"]>(() => getWorkbenchDraft<CreationDraftInput>("home")?.capability || "image");
    const [prompt, setPrompt] = useState(() => getWorkbenchDraft<CreationDraftInput>("home")?.prompt || "");
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

    const previousSession = useRef(sessionVersion);
    useEffect(() => {
        if (previousSession.current !== sessionVersion) { previousSession.current = sessionVersion; setPrompt(""); setCreatingCanvas(false); return; }
        saveWorkbenchDraft("home", { capability, prompt }, sessionVersion);
    }, [sessionVersion, capability, prompt]);
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
        clearWorkbenchDraft("home");
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
            <div className="mx-auto flex max-w-6xl flex-col gap-8 px-5 py-8 sm:px-8 sm:py-10">
                <div className="grid gap-8 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)] lg:gap-10">
                    <section aria-labelledby="home-creation-title" className="min-w-0">
                        <div className="mb-5"><h1 id="home-creation-title" className="text-3xl font-semibold tracking-tight">从一个想法开始</h1><p className="mt-2 text-sm text-muted-foreground">写下内容，选择创作方式。</p></div>
                        <div className="overflow-hidden rounded-2xl border border-border bg-card px-4 pb-4 transition-colors focus-within:border-ring/60 sm:px-5">
                            <div className="flex gap-6" role="group" aria-label="创作方式">
                                {creationModes.map((item) => <button key={item.value} type="button" aria-pressed={capability === item.value} onClick={() => setCapability(item.value)} className={cn("inline-flex cursor-pointer items-center gap-2 border-b-2 py-3.5 text-sm transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring", capability === item.value ? "border-foreground font-medium text-foreground" : "border-transparent text-muted-foreground hover:text-foreground")}><item.icon className="size-4" />{item.label}</button>)}
                            </div>
                            <Input.TextArea aria-label={`${mode.label}创作内容`} variant="borderless" value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder={mode.placeholder} autoSize={{ minRows: 3, maxRows: 7 }} className="!px-0 !py-5 !text-base" />
                            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border/60 pt-3">
                                <div className="flex min-w-0 max-w-full flex-wrap items-center gap-1">
                                    <ModelPicker config={config} value={model} onChange={(value) => updateConfig(modelKey, value)} capability={capability} className="!max-w-full !rounded-lg !border-0 !bg-transparent !px-1 !shadow-none sm:!max-w-64" placeholder="在工作台选择模型" />
                                    {capability === "image" ? <CanvasSizePicker value={config.size} onChange={(value) => updateConfig("size", value)} className="h-8 w-28 shrink-0" /> : null}
                                </div>
                                <Button type="primary" className="!ml-auto !shadow-none" disabled={!prompt.trim()} icon={<ArrowRight className="size-4" />} iconPlacement="end" onClick={startCreation}>进入{mode.label}工作台</Button>
                            </div>
                        </div>
                        <div className="mt-3 flex flex-wrap items-center justify-between gap-x-3 gap-y-1"><p className="text-xs leading-5 text-muted-foreground">进入工作台后，确认参数与费用。</p><Button type="text" size="small" className="!text-xs !text-muted-foreground" icon={<Bot className="size-3.5" />} onClick={() => useAgentStore.getState().openPanel()}>本地 Agent</Button></div>
                    </section>

                    <section aria-labelledby="home-recent-title" className="min-w-0 lg:border-l lg:border-border/70 lg:pl-8">
                        <div className="mb-3 flex items-center justify-between gap-2"><h2 id="home-recent-title" className="text-lg font-semibold tracking-tight">继续创作</h2><Button type="text" size="small" className="!text-muted-foreground" icon={<ArrowRight className="size-3.5" />} iconPlacement="end" onClick={() => navigate("/canvas")}>全部画布</Button></div>
                        {!hydrated || !recentReady ? <div className="space-y-2 py-1">{[0, 1, 2].map((key) => <div key={key} className="flex items-center gap-3 py-2"><Skeleton.Button active style={{ width: 64, height: 48 }} /><Skeleton active title={{ width: "65%" }} paragraph={{ rows: 1, width: "45%" }} /></div>)}</div> : recentError ? <div className="py-5"><p className="break-words text-sm leading-6 text-muted-foreground">{recentError}</p><Button type="text" className="mt-2" onClick={() => setRecentRequest((value) => value + 1)}>重新加载</Button></div> : recentProjects.length ? <div className="-mx-2 space-y-1">{recentProjects.map((project) => <CanvasProjectCard key={project.id} project={project} compact />)}</div> : <div className="py-6"><p className="text-sm">还没有画布</p><p className="mt-2 text-xs leading-6 text-muted-foreground">把灵感、素材和生成结果，放进同一张画布。</p></div>}
                        <Button type="text" className="!mt-3 !px-0" disabled={!hydrated} loading={creatingCanvas} icon={<Plus className="size-4" />} onClick={() => void newCanvas()}>新建画布</Button>
                    </section>
                </div>

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

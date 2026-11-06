import { useState } from "react";
import { Button, Input, Modal } from "antd";
import { ArrowRight, Clapperboard, LayoutTemplate, Package, Palette, Search, UserRound } from "lucide-react";
import { useNavigate } from "react-router-dom";

import { creationScenes, type CreationScene } from "@/constant/creation-scenes";
import { useCreationDraftStore } from "@/stores/use-creation-draft-store";

const sceneIcons = { product: Package, poster: Palette, character: UserRound, storyboard: Clapperboard };

export function CreationScenes() {
    const navigate = useNavigate();
    const [scene, setScene] = useState<CreationScene | null>(null);
    const [prompt, setPrompt] = useState("");
    const start = () => {
        if (!scene || !prompt.trim()) return;
        useCreationDraftStore.getState().setDraft({ ...scene.example, prompt: prompt.trim(), sourceTitle: scene.title });
        navigate(`/${scene.example.capability}`);
    };

    return (
        <section aria-labelledby="creation-scenes-title" className="flex flex-col gap-3 border-y border-border/70 py-4 sm:flex-row sm:items-center sm:gap-6">
            <h2 id="creation-scenes-title" className="shrink-0 text-sm font-medium text-muted-foreground">按用途开始</h2>
            <div className="grid min-w-0 flex-1 grid-cols-2 gap-1 sm:grid-cols-4 sm:gap-2">
                {creationScenes.map((item) => {
                    const Icon = sceneIcons[item.id];
                    return (
                        <button key={item.id} type="button" onClick={() => { setScene(item); setPrompt(item.example.prompt); }} className="group flex min-w-0 cursor-pointer items-center gap-2.5 rounded-lg px-2 py-2.5 text-left text-sm transition-colors hover:bg-black/5 focus-visible:outline-2 focus-visible:outline-ring dark:hover:bg-white/10">
                            <Icon className="size-4 shrink-0 text-muted-foreground" strokeWidth={1.5} /><span className="truncate">{item.title}</span><ArrowRight className="ml-auto size-3.5 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
                        </button>
                    );
                })}
            </div>
            <Modal title={scene ? `${scene.title} · 可编辑示例` : "可编辑示例"} open={Boolean(scene)} onCancel={() => setScene(null)} footer={null} width={680} destroyOnHidden>
                {scene ? (
                    <div className="space-y-5 pt-2">
                        <p className="text-sm leading-6 text-muted-foreground">{scene.suitableFor}。可把下面的主题、外观与风格改成你的实际需求。</p>
                        <dl className="grid gap-3 text-sm leading-6 sm:grid-cols-2"><div><dt className="text-xs text-muted-foreground">准备材料</dt><dd>{scene.materials}</dd></div><div><dt className="text-xs text-muted-foreground">得到什么</dt><dd>{scene.outcome}</dd></div></dl>
                        <div><label htmlFor="creation-scene-prompt" className="mb-2 block text-sm font-medium">示例提示词</label><Input.TextArea id="creation-scene-prompt" value={prompt} onChange={(event) => setPrompt(event.target.value)} autoSize={{ minRows: 6, maxRows: 12 }} /></div>
                        <Button type="primary" disabled={!prompt.trim()} icon={<ArrowRight className="size-4" />} iconPlacement="end" onClick={start}>进入{scene.example.capability === "text" ? "文本" : "图片"}工作台</Button>
                        <p className="text-xs leading-5 text-muted-foreground">进入工作台后，确认参数与费用。</p>
                        <div className="flex flex-wrap gap-2 border-t border-border pt-4"><Button type="text" icon={<Search className="size-4" />} onClick={() => navigate(`/prompts?${new URLSearchParams({ keyword: scene.keyword })}`)}>查找相关提示词</Button><Button type="text" icon={<LayoutTemplate className="size-4" />} onClick={() => navigate(`/canvas?${new URLSearchParams({ templateKeyword: scene.keyword })}`)}>查找画布模板</Button></div>
                    </div>
                ) : null}
            </Modal>
        </section>
    );
}

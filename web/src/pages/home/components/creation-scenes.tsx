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
        <section aria-labelledby="creation-scenes-title">
            <div className="mb-5 flex flex-wrap items-end justify-between gap-2">
                <div><h2 id="creation-scenes-title" className="text-xl font-semibold tracking-tight">按用途开始</h2><p className="mt-1 text-sm text-muted-foreground">先选一件要完成的事，再编辑示例。</p></div>
            </div>
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
                {creationScenes.map((item, index) => {
                    const Icon = sceneIcons[item.id];
                    return (
                        <button key={item.id} type="button" onClick={() => { setScene(item); setPrompt(item.example.prompt); }} className="group flex h-full cursor-pointer flex-col rounded-xl border border-border p-5 text-left transition hover:bg-muted/25 focus-visible:outline-2 focus-visible:outline-ring">
                            <div className="mb-5 flex items-center justify-between text-muted-foreground"><span className="font-mono text-xs">0{index + 1}</span><Icon className="size-5" strokeWidth={1.5} /></div>
                            <h3 className="text-lg font-semibold">{item.title}</h3>
                            <p className="mt-2 text-xs leading-6 text-muted-foreground">{item.suitableFor}</p>
                            <dl className="mt-4 flex-1 space-y-3 text-xs leading-5"><div><dt className="mb-1 text-muted-foreground">准备材料</dt><dd>{item.materials}</dd></div><div><dt className="mb-1 text-muted-foreground">得到什么</dt><dd>{item.outcome}</dd></div></dl>
                            <span className="mt-5 inline-flex items-center gap-2 text-sm">查看并编辑示例<ArrowRight className="size-3.5 transition-transform group-hover:translate-x-1" /></span>
                        </button>
                    );
                })}
            </div>
            <Modal title={scene ? `${scene.title} · 可编辑示例` : "可编辑示例"} open={Boolean(scene)} onCancel={() => setScene(null)} footer={null} width={680} destroyOnHidden>
                {scene ? (
                    <div className="space-y-5 pt-2">
                        <p className="text-sm leading-6 text-muted-foreground">{scene.suitableFor}。{scene.materials}。可把下面的主题、外观与风格改成你的实际需求。</p>
                        <div><label htmlFor="creation-scene-prompt" className="mb-2 block text-sm font-medium">示例提示词</label><Input.TextArea id="creation-scene-prompt" value={prompt} onChange={(event) => setPrompt(event.target.value)} autoSize={{ minRows: 6, maxRows: 12 }} /></div>
                        <Button type="primary" disabled={!prompt.trim()} icon={<ArrowRight className="size-4" />} iconPlacement="end" onClick={start}>使用示例开始</Button>
                        <p className="text-xs leading-5 text-muted-foreground">内容将带入{scene.example.capability === "text" ? "文本" : "图片"}工作台，可继续编辑、添加参考素材，并确认模型、参数和费用后生成。</p>
                        <div className="flex flex-wrap gap-2 border-t border-border pt-4"><Button type="text" icon={<Search className="size-4" />} onClick={() => navigate(`/prompts?${new URLSearchParams({ keyword: scene.keyword })}`)}>查找相关提示词</Button><Button type="text" icon={<LayoutTemplate className="size-4" />} onClick={() => navigate(`/canvas?${new URLSearchParams({ templateKeyword: scene.keyword })}`)}>查找画布模板</Button></div>
                    </div>
                ) : null}
            </Modal>
        </section>
    );
}

import { Copy, FileText, FolderPlus, Sparkles } from "lucide-react";
import { useState } from "react";
import { Button, Image, Modal, Tag } from "antd";
import { useTranslation } from "react-i18next";

import { useCopyText } from "@/hooks/use-copy-text";
import { usePromptCreation } from "@/hooks/use-prompt-creation";
import { useSaveToAssets } from "@/hooks/use-save-to-assets";
import { formatPromptDate, type Prompt } from "@/services/api/prompts";
import { cn } from "@/lib/utils";

export function PromptDetailDialog({ prompt, onClose }: { prompt: Prompt | null; onClose: () => void }) {
    const { i18n, t } = useTranslation();
    const copyText = useCopyText();
    const saveToAssets = useSaveToAssets();
    const startCreation = usePromptCreation();
    const [selectedImage, setSelectedImage] = useState("");
    const images = prompt ? [...new Set([prompt.coverUrl, ...prompt.referenceImageUrls].filter(Boolean))] : [];
    const image = images.includes(selectedImage) ? selectedImage : images[0];

    return (
        <Modal title={prompt?.title} open={Boolean(prompt)} onCancel={onClose} footer={null} width={1120} centered destroyOnHidden styles={{ body: { maxHeight: "calc(88dvh - 76px)", overflowY: "auto" } }}>
            {prompt ? (
                <div className="grid min-w-0 gap-6 pt-2 md:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
                    <div className="min-w-0">
                        <div className="flex h-72 items-center justify-center overflow-hidden rounded-xl bg-muted/35 md:h-[440px]">
                            {image ? <Image src={image} alt={prompt.title} width="100%" height="100%" style={{ objectFit: "contain" }} /> : <FileText className="size-12 text-muted-foreground" />}
                        </div>
                        {images.length > 1 ? (
                            <div className="mt-3 flex gap-2 overflow-x-auto pb-1">
                                {images.map((url, index) => (
                                    <button key={url} type="button" aria-label={"查看示例图 " + (index + 1)} aria-pressed={url === image} onClick={() => setSelectedImage(url)} className={cn("size-16 shrink-0 overflow-hidden rounded-lg border-2 transition", url === image ? "border-primary" : "border-transparent hover:border-border")}>
                                        <img src={url} alt="" loading="lazy" className="h-full w-full object-cover" />
                                    </button>
                                ))}
                            </div>
                        ) : null}
                        <p className="mt-3 text-xs leading-5 text-muted-foreground">点击图片查看完整画面</p>
                    </div>
                    <div className="flex min-w-0 flex-col gap-4">
                        <div className="flex flex-wrap gap-1.5">{prompt.tags.map((tag) => <Tag key={tag} className="m-0">{tag}</Tag>)}</div>
                        {prompt.description ? <p className="text-sm leading-6 text-muted-foreground">{prompt.description}</p> : null}
                        <section className="min-h-0 flex-1">
                            <div className="mb-2 flex items-center justify-between gap-3">
                                <h3 className="text-sm font-medium text-foreground">提示词</h3>
                                <Button type="text" size="small" icon={<Copy className="size-3.5" />} onClick={() => copyText(prompt.prompt, t("common.promptCopied"))}>{t("common.copy")}</Button>
                            </div>
                            {prompt.preview ? <pre className="mb-3 whitespace-pre-wrap rounded-lg bg-muted/40 p-3 text-xs leading-5 text-muted-foreground">{prompt.preview}</pre> : null}
                            <p className="max-h-64 overflow-y-auto whitespace-pre-wrap text-sm leading-7 text-foreground">{prompt.prompt}</p>
                        </section>
                        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 border-t border-border pt-4 text-xs">
                            <dt className="text-muted-foreground">模型</dt><dd className="break-words text-right text-foreground">{prompt.imageModel || "创作时选择"}</dd>
                            {prompt.imageSize ? <><dt className="text-muted-foreground">画面尺寸</dt><dd className="text-right text-foreground">{prompt.imageSize}</dd></> : null}
                            {prompt.imageCount ? <><dt className="text-muted-foreground">生成张数</dt><dd className="text-right text-foreground">{prompt.imageCount} 张</dd></> : null}
                        </dl>
                        <div className="flex flex-wrap gap-2">
                            <Button type="primary" className="flex-1" icon={<Sparkles className="size-4" />} onClick={() => { startCreation(prompt); onClose(); }}>用此创作</Button>
                            <Button type="text" icon={<FolderPlus className="size-4" />} onClick={() => void saveToAssets({ kind: "text", title: prompt.title, coverUrl: prompt.coverUrl, tags: prompt.tags, source: prompt.category, data: { content: prompt.prompt }, metadata: { source: "prompt-library", promptId: prompt.id, githubUrl: prompt.githubUrl } })}>{t("common.addToAssets")}</Button>
                        </div>
                        <p className="text-xs leading-5 text-muted-foreground">带入提示词与已提供的模型、参数，在工作台确认后生成。</p>
                        {prompt.updatedAt ? <p className="text-xs text-muted-foreground">{t("common.updated", { date: formatPromptDate(prompt.updatedAt, i18n.resolvedLanguage) })}</p> : null}
                    </div>
                </div>
            ) : null}
        </Modal>
    );
}

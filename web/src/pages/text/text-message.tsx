import { memo, useEffect, useRef, useState } from "react";
import { App, Button, Dropdown, Image, Input, Modal, Tooltip, type MenuProps } from "antd";
import { ArrowRight, Copy, Download, Ellipsis, FilePlus2, ImagePlus, LayoutTemplate, RotateCcw, SquarePen, TextSelect, Video } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { saveAs } from "file-saver";
import { Streamdown } from "streamdown";

import { useAddToCanvas } from "@/hooks/use-add-to-canvas";
import { useCopyText } from "@/hooks/use-copy-text";
import { useAssetStore } from "@/stores/use-asset-store";
import { useCreationDraftStore } from "@/stores/use-creation-draft-store";
import { assertCurrentSession, useUserStore } from "@/stores/use-user-store";
import type { TextMessage } from "@/services/api/text";

export type TextMessageRowProps = {
    item: TextMessage;
    disabled: boolean;
    canContinue?: boolean;
    onEdit: (item: TextMessage) => void;
    onRegenerate: (item: TextMessage) => void;
    onContinue: (item: TextMessage) => void;
};

// 长对话只安装一个 selectionchange 监听器，且只通知选区所属消息与上一次消息。
const selections = new Map<Element, (text: string) => void>();
let selectedElement: Element | null = null;
function selectionChanged() {
    const selection = window.getSelection();
    const node = selection?.anchorNode;
    const element = (node instanceof Element ? node : node?.parentElement)?.closest("[data-text-message-content]") || null;
    const owned = element && selection?.rangeCount && element.contains(selection.getRangeAt(0).startContainer) && element.contains(selection.getRangeAt(0).endContainer);
    const next = owned && !selection?.isCollapsed ? element : null;
    if (selectedElement && selectedElement !== next) selections.get(selectedElement)?.("");
    selectedElement = next;
    const text = selection?.toString() || "";
    if (next) selections.get(next)?.(text.trim() ? text : "");
}

export const TextMessageRow = memo(function TextMessageRow({ item, disabled, canContinue = true, onEdit, onRegenerate, onContinue }: TextMessageRowProps) {
    const { message } = App.useApp();
    const copy = useCopyText();
    const addToCanvas = useAddToCanvas();
    const navigate = useNavigate();
    const client = useQueryClient();
    const session = useUserStore((state) => state.sessionVersion);
    const content = useRef<HTMLDivElement>(null);
    const mounted = useRef(false);
    const selectionLocked = useRef(false);
    const selectionSnapshot = useRef("");
    const [selectedText, setSelectedText] = useState("");
    const [asset, setAsset] = useState<{ content: string; title: string; session: number } | null>(null);
    const [saving, setSaving] = useState(false);
    const savingRef = useRef(false);
    const readonly = Boolean(item.supersededAt);
    const assistant = item.role === "assistant";
    const valid = () => mounted.current && useUserStore.getState().sessionVersion === session;
    useEffect(() => {
        mounted.current = true;
        const element = content.current!;
        if (!selections.size) document.addEventListener("selectionchange", selectionChanged);
        selections.set(element, (text) => { if (!selectionLocked.current) setSelectedText(text); });
        return () => {
            mounted.current = false;
            selections.delete(element);
            if (selectedElement === element) selectedElement = null;
            if (!selections.size) document.removeEventListener("selectionchange", selectionChanged);
        };
    }, []);
    useEffect(() => { setAsset(null); setSelectedText(""); selectionSnapshot.current = ""; selectionLocked.current = false; }, [session, item.id]);

    const reuse = (key: string, text: string) => {
        if (!text || !valid()) return;
        const title = (text.split("\n").find((line) => line.trim())?.trim() || "对话摘录").slice(0, 200);
        if (key === "copy") copy(text);
        if (key === "canvas") addToCanvas([{ kind: "text", content: text, title }]);
        if (key === "asset") setAsset({ content: text, title, session });
        if (key === "image" || key === "video") {
            useCreationDraftStore.getState().setDraft({ capability: key, prompt: text, sourceTitle: "文本对话" });
            navigate(`/${key}`);
        }
        if (key === "download") {
            saveAs(new Blob([text], { type: "text/markdown;charset=utf-8" }), `对话-${item.id}.md`);
            message.success("已下载 Markdown");
        }
    };
    const actions = (text: string): MenuProps => ({
        items: [
            { key: "canvas", label: "加入画布", icon: <LayoutTemplate className="size-3.5" /> },
            { key: "asset", label: "存为文本素材", icon: <FilePlus2 className="size-3.5" /> },
            { key: "image", label: "带入生图提示词", icon: <ImagePlus className="size-3.5" /> },
            { key: "video", label: "带入视频提示词", icon: <Video className="size-3.5" /> },
            { type: "divider" },
            { key: "copy", label: "复制文本", icon: <Copy className="size-3.5" /> },
            { key: "download", label: "下载 Markdown", icon: <Download className="size-3.5" /> },
        ],
        onClick: ({ key }) => reuse(key, text),
    });
    const saveAsset = async () => {
        if (!asset?.title.trim() || savingRef.current || !valid() || asset.session !== session) return;
        savingRef.current = true;
        setSaving(true);
        try {
            await useAssetStore.getState().addAsset({ kind: "text", scope: "private", title: asset.title.trim(), coverUrl: "", tags: [], source: "文本对话", data: { content: asset.content } });
            assertCurrentSession(session);
            if (!valid()) return;
            void client.invalidateQueries({ queryKey: ["assets"] });
            message.success("已保存到我的素材");
            setAsset(null);
        } catch (error) {
            if (valid() && error instanceof Error && error.name !== "AbortError") message.error(error.message);
        } finally {
            savingRef.current = false;
            if (valid()) setSaving(false);
        }
    };

    return <article id={`text-message-${item.id}`} data-message-id={item.id} tabIndex={-1} className={`group min-w-0 scroll-mt-6 outline-none focus:outline-1 focus:outline-offset-4 focus:outline-muted-foreground/40 ${item.role === "user" ? "flex flex-col items-end" : ""}`}>
        <div ref={content} data-text-message-content={item.id} onPointerUp={selectionChanged} onKeyUp={selectionChanged} className={item.role === "user" ? "max-w-[85%] rounded-3xl bg-muted px-4 py-2.5 @min-[640px]/conversation:max-w-[75%]" : "min-w-0"}>
            {item.attachments?.length ? <Image.PreviewGroup><div className="flex flex-wrap gap-2 pb-1.5">{item.attachments.map((attachment, index) => <Image key={`${attachment.id}:${index}`} src={attachment.url} alt={attachment.originalName} height={112} className="max-w-48 rounded-xl object-cover" />)}</div></Image.PreviewGroup> : null}
            {item.role === "user" ? <p className="whitespace-pre-wrap break-words text-[15px] leading-7">{item.content}</p> : <Streamdown className="agent-streamdown" controls={{ code: { copy: true, download: false }, table: { copy: true, download: false, fullscreen: false } }}>{item.content}</Streamdown>}
        </div>
        {selectedText ? <div className="mt-1 self-start">
            <Dropdown trigger={["click"]} menu={actions(selectionSnapshot.current || selectedText)} onOpenChange={(open) => { selectionLocked.current = open; if (open) selectionSnapshot.current = selectedText; else { selectionSnapshot.current = ""; selectionChanged(); } }}>
                <Button type="text" size="small" icon={<TextSelect className="size-3.5" />} onPointerDown={() => { selectionSnapshot.current = selectedText; selectionLocked.current = true; }} onMouseDown={(event) => event.preventDefault()}>使用选中文字</Button>
            </Dropdown>
        </div> : null}
        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
            {assistant && (item.modelDisplayName || item.billed != null) ? <Tooltip title={item.promptTokens != null || item.completionTokens != null ? `输入 ${item.promptTokens ?? "—"} tokens · 输出 ${item.completionTokens ?? "—"} tokens` : undefined}><span>{item.modelDisplayName}{item.modelDisplayName && item.billed != null ? " · " : ""}{item.billed != null ? `¥${item.billed}` : ""}</span></Tooltip> : null}
            {readonly ? <span>历史版本</span> : null}
            <div className="flex items-center transition-opacity [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover:opacity-100 focus-within:opacity-100">
                <Button type="text" size="small" aria-label={assistant ? "复制回复" : "复制消息"} title="复制" icon={<Copy className="size-3.5" />} onClick={() => copy(item.content)} />
                {!readonly && item.role === "user" ? <Button type="text" size="small" aria-label="编辑消息" title="编辑后重发" disabled={disabled} icon={<SquarePen className="size-3.5" />} onClick={() => onEdit(item)} /> : null}
                {!readonly && assistant ? <Button type="text" size="small" aria-label="重新生成回复" title="重新生成" disabled={disabled} icon={<RotateCcw className="size-3.5" />} onClick={() => onRegenerate(item)} /> : null}
                {assistant ? <Dropdown trigger={["click"]} menu={actions(item.content)}><Button type="text" size="small" aria-label="更多回复操作" title="更多操作" icon={<Ellipsis className="size-3.5" />} /></Dropdown> : null}
            </div>
        </div>
        {assistant && !readonly && item.finishReason === "length" ? <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground"><span>{canContinue ? "回复达到本次输出上限，可继续写。" : "回复达到本次输出上限。"}</span>{canContinue ? <Button type="text" size="small" disabled={disabled} icon={<ArrowRight className="size-3.5" />} onClick={() => onContinue(item)}>继续写</Button> : null}</div> : null}
        <Modal title="存为文本素材" open={Boolean(asset)} onCancel={() => { if (!saving) setAsset(null); }} onOk={() => void saveAsset()} okText="保存" cancelText="取消" confirmLoading={saving} okButtonProps={{ disabled: !asset?.title.trim() }} cancelButtonProps={{ disabled: saving }} destroyOnHidden>
            <label className="mb-2 block text-sm" htmlFor={`text-asset-title-${item.id}`}>素材标题</label>
            <Input id={`text-asset-title-${item.id}`} maxLength={200} value={asset?.title || ""} disabled={saving} onChange={(event) => setAsset((current) => current ? { ...current, title: event.target.value } : current)} />
            <p className="mt-3 text-xs text-muted-foreground">保存到我的私人素材，可随后加入画布或继续创作。</p>
        </Modal>
    </article>;
});

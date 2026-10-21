import { useDeferredValue, useEffect, useMemo, useRef, useState, type ChangeEvent, type ClipboardEvent } from "react";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, App, Button, Drawer, Dropdown, Empty, Image, Input, Select, Spin, Tooltip } from "antd";
import { ArrowUp, Brain, ChevronDown, Circle, Copy, Ellipsis, PanelLeft, Paperclip, Plus, Search, Settings2, Square, SquarePen, Trash2, X } from "lucide-react";
import { Link, useSearchParams } from "react-router-dom";
import { Streamdown } from "streamdown";
import dayjs from "dayjs";

import { useCopyText } from "@/hooks/use-copy-text";
import { usePublicModels } from "@/hooks/use-public-models";
import { getWallet } from "@/services/api/billing";
import { quoteGeneration } from "@/services/api/platform-operations";
import { deleteTextConversation, getTextConversation, listTextConversations, queueTextRequest, watchTextRequest, type TextMessage } from "@/services/api/text";
import { uploadMedia, type MediaRecord } from "@/services/api/media";
import { cancelGenerationTask } from "@/services/api/tasks";
import { assertCurrentSession, useUserStore } from "@/stores/use-user-store";
import { modelReasoningEfforts, modelReasoningOptions, resolveReasoningEffort, type ReasoningEffort } from "@/lib/model-reasoning";
import { modelPriceLabel } from "@/lib/model-price";
import { cn } from "@/lib/utils";

type Conversation = Awaited<ReturnType<typeof getTextConversation>>;
type ConversationItem = Awaited<ReturnType<typeof listTextConversations>>[number];
type PendingFile = { file: File; url: string };
const activeStates = ["reviewing", "queued", "running"];
const maxAttachments = 20;

export default function TextPage() {
    const { message, modal } = App.useApp();
    const client = useQueryClient();
    const session = useUserStore((state) => state.sessionVersion);
    const copy = useCopyText();
    const [search, setSearch] = useSearchParams();
    const conversationId = search.get("conversation") || "";
    const [modelId, setModelId] = useState("");
    const [prompt, setPrompt] = useState("");
    const [systemPrompt, setSystemPrompt] = useState("");
    const [reasoningEffort, setReasoningEffort] = useState<ReasoningEffort>("auto");
    const [settingsOpen, setSettingsOpen] = useState(false);
    const [historyOpen, setHistoryOpen] = useState(false);
    const [historyKeyword, setHistoryKeyword] = useState("");
    const [files, setFiles] = useState<PendingFile[]>([]);
    const [sending, setSending] = useState(false);
    const [canceling, setCanceling] = useState(false);
    const [streamError, setStreamError] = useState("");
    const pending = useRef<{ fingerprint: string; id: string; mediaIds?: string[] } | null>(null);
    const scroll = useRef<HTMLDivElement>(null);
    const fileInput = useRef<HTMLInputElement>(null);
    const follow = useRef(true);
    const previousSession = useRef(session);
    const restoredConversation = useRef("");
    const models = usePublicModels();
    const available = useMemo(() => (models.data || []).filter((model) => model.capability === "text"), [models.data]);
    const model = available.find((item) => item.id === modelId);
    const unavailableModel = Boolean(modelId && !models.isPending && !models.isError && !model);
    const effort = resolveReasoningEffort(model, reasoningEffort);
    const wallet = useQuery({ queryKey: ["wallet", session], queryFn: getWallet });
    const conversations = useInfiniteQuery({ queryKey: ["text-conversations", session], queryFn: ({ pageParam }) => listTextConversations(pageParam), initialPageParam: 0, getNextPageParam: (last, pages) => last.length === 50 ? pages.length * 50 : undefined });
    const conversationItems = useMemo(() => conversations.data?.pages.flat() || [], [conversations.data]);
    const visibleItems = useMemo(() => {
        const keyword = historyKeyword.trim().toLowerCase();
        return keyword ? conversationItems.filter((item) => item.title.toLowerCase().includes(keyword)) : conversationItems;
    }, [conversationItems, historyKeyword]);
    const groups = useMemo(() => groupConversations(visibleItems), [visibleItems]);
    const conversation = useQuery({ queryKey: ["text-conversation", session, conversationId], queryFn: () => getTextConversation(conversationId), enabled: Boolean(conversationId) });
    useEffect(() => {
        if (modelId || !available.length || conversationId) return;
        setModelId(available[0].id);
    }, [modelId, available, conversationId]);
    const latest = conversation.data?.latestRequest;
    const active = Boolean(latest && activeStates.includes(latest.status));
    const quotedPrompt = useDeferredValue(prompt);
    const parameters = effort === "auto" ? {} : { reasoningEffort: effort };
    const quote = useQuery({ queryKey: ["text-quote", session, model?.id, conversationId, quotedPrompt, systemPrompt, effort], queryFn: ({ signal }) => quoteGeneration({ modelId: model!.id, count: 1, content: quotedPrompt, conversationId: conversationId || undefined, systemPrompt, parameters }, signal), enabled: Boolean(model && quotedPrompt.trim()), gcTime: 0 });
    const quoteReady = !quotedPrompt.trim() || Boolean(quote.data && !quote.isFetching && !quote.isError);
    const canSend = Boolean(model && (prompt.trim() || files.length) && !sending && !active && quotedPrompt === prompt && quoteReady && (!files.length || model?.imageInput) && (!conversationId || !conversation.isPending && !conversation.isError));

    const clearFiles = () => {
        setFiles((current) => {
            current.forEach((item) => URL.revokeObjectURL(item.url));
            return [];
        });
    };
    const addFiles = (picked: File[]) => {
        const images = picked.filter((file) => file.type.startsWith("image/"));
        if (!images.length) return;
        setFiles((current) => {
            const remain = maxAttachments - current.length;
            if (remain <= 0) return current;
            const allowed = images.slice(0, remain);
            return [...current, ...allowed.map((file) => ({ file, url: URL.createObjectURL(file) }))];
        });
    };
    const removeFile = (index: number) => setFiles((current) => {
        URL.revokeObjectURL(current[index].url);
        return current.filter((_, i) => i !== index);
    });
    const filesRef = useRef(files);
    filesRef.current = files;
    useEffect(() => () => filesRef.current.forEach((item) => URL.revokeObjectURL(item.url)), []);

    useEffect(() => {
        if (previousSession.current === session) return;
        previousSession.current = session;
        pending.current = null;
        restoredConversation.current = "";
        setPrompt(""); setSystemPrompt(""); setReasoningEffort("auto"); setModelId(""); setStreamError(""); setSending(false); setCanceling(false); setHistoryKeyword(""); clearFiles();
        setSearch({}, { replace: true });
    }, [session, setSearch]);

    useEffect(() => {
        const saved = conversation.data?.conversation;
        if (!saved || restoredConversation.current === saved.id) return;
        restoredConversation.current = saved.id;
        setModelId(saved.modelId || "");
        setSystemPrompt(String(saved.parameters?.systemPrompt || ""));
        setReasoningEffort(modelReasoningEfforts.find((value) => value === saved.parameters?.reasoningEffort) || "auto");
    }, [conversation.data?.conversation]);

    useEffect(() => {
        if (!latest?.id || !active) return;
        setStreamError("");
        return watchTextRequest(latest.id, (detail) => {
            assertCurrentSession(session);
            client.setQueryData<Conversation>(["text-conversation", session, conversationId], (current) => current ? {
                ...current,
                latestRequest: detail.request,
                messages: detail.message && !current.messages.some((item) => item.id === detail.message!.id) ? [...current.messages, detail.message] : current.messages,
            } : current);
            if (!activeStates.includes(detail.request.status)) {
                void client.invalidateQueries({ queryKey: ["wallet", session] });
                void client.invalidateQueries({ queryKey: ["text-conversations", session] });
            }
        }, undefined, (error) => { if (useUserStore.getState().sessionVersion === session && error.name !== "AbortError") setStreamError(error.message); });
    }, [latest?.id, active, client, session, conversationId]);

    useEffect(() => { follow.current = true; }, [conversationId]);
    useEffect(() => { if (follow.current && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight; }, [conversation.data?.messages.length, latest?.partialText, conversationId]);

    const send = async () => {
        if (!canSend || !model) return;
        const version = useUserStore.getState().sessionVersion;
        const content = prompt.trim();
        const input = { modelId: model.id, conversationId: conversationId || undefined, content, title: (content || "图片对话").slice(0, 100), systemPrompt, parameters };
        const fingerprint = JSON.stringify({ ...input, files: files.map((item) => [item.file.name, item.file.size, item.file.lastModified]) });
        if (pending.current?.fingerprint !== fingerprint) pending.current = { fingerprint, id: crypto.randomUUID() };
        setSending(true);
        try {
            const mediaIds = pending.current.mediaIds || (await Promise.all(files.map((item) => uploadMedia(item.file, item.file.name)))).map((media) => media.id);
            assertCurrentSession(version);
            pending.current.mediaIds = mediaIds;
            const accepted = await queueTextRequest({ ...input, requestId: pending.current.id, attachmentMediaIds: mediaIds.length ? mediaIds : undefined });
            assertCurrentSession(version);
            pending.current = null;
            const uploaded = mediaIds.length ? mediaIds.map((id, index) => ({ id, url: `/api/media/${id}`, originalName: files[index]?.file.name || "图片" }) as MediaRecord) : undefined;
            const optimistic: TextMessage = { id: `local:${accepted.requestId}`, role: "user", content, createdAt: new Date().toISOString(), attachments: uploaded };
            client.setQueryData<Conversation>(["text-conversation", version, accepted.conversationId], (current) => current ? { ...current, messages: [...current.messages, optimistic] } : { conversation: { id: accepted.conversationId, title: input.title, canvasProjectId: null, modelId: model.id, parameters: { systemPrompt, reasoningEffort: effort } }, messages: [optimistic], latestRequest: null });
            setPrompt(""); setStreamError(""); follow.current = true; clearFiles();
            setSearch({ conversation: accepted.conversationId }, { replace: true });
            await Promise.all([client.invalidateQueries({ queryKey: ["text-conversation", version, accepted.conversationId] }), client.invalidateQueries({ queryKey: ["text-conversations", version] }), client.invalidateQueries({ queryKey: ["wallet", version] })]);
        } catch (error) {
            if (useUserStore.getState().sessionVersion === version && error instanceof Error && error.name !== "AbortError") message.error(error.message);
        } finally {
            if (useUserStore.getState().sessionVersion === version) setSending(false);
        }
    };
    const cancel = async () => {
        if (!latest?.canCancel || canceling) return;
        const version = useUserStore.getState().sessionVersion;
        setCanceling(true);
        try {
            await cancelGenerationTask(latest.id);
            assertCurrentSession(version);
            await Promise.all([conversation.refetch(), client.invalidateQueries({ queryKey: ["wallet", version] })]);
        } catch (error) {
            if (useUserStore.getState().sessionVersion === version && error instanceof Error && error.name !== "AbortError") message.error(error.message);
        } finally {
            if (useUserStore.getState().sessionVersion === version) setCanceling(false);
        }
    };
    const selectConversation = (id: string) => { setSearch(id ? { conversation: id } : {}); setStreamError(""); setPrompt(""); setHistoryOpen(false); if (!id) { setModelId(available[0]?.id || ""); setSystemPrompt(""); setReasoningEffort("auto"); } restoredConversation.current = ""; pending.current = null; clearFiles(); };
    const changeModel = (id: string) => {
        const next = available.find((item) => item.id === id);
        if (files.length && next && !next.imageInput) { clearFiles(); message.info("该模型不支持图片输入，已移除图片附件"); }
        setModelId(id);
    };
    const removeConversation = (item: ConversationItem) => {
        modal.confirm({
            title: "删除这条对话？",
            content: `「${item.title}」将从对话列表中移除，且不可恢复。已提交上游的生成需结束后才能删除。`,
            okText: "删除",
            okButtonProps: { danger: true },
            cancelText: "取消",
            onOk: async () => {
                const version = useUserStore.getState().sessionVersion;
                await deleteTextConversation(item.id);
                assertCurrentSession(version);
                if (item.id === conversationId) selectConversation("");
                await client.invalidateQueries({ queryKey: ["text-conversations", version] });
            },
        });
    };
    const pickFiles = (event: ChangeEvent<HTMLInputElement>) => {
        if (!model?.imageInput) { message.info("当前模型不支持图片输入"); event.target.value = ""; return; }
        addFiles(Array.from(event.target.files || []));
        event.target.value = "";
    };
    const pasteFiles = (event: ClipboardEvent<HTMLTextAreaElement>) => {
        const pasted = Array.from(event.clipboardData?.files || []).filter((file) => file.type.startsWith("image/"));
        if (!pasted.length) return;
        if (!model?.imageInput) { message.info("当前模型不支持图片输入"); return; }
        event.preventDefault();
        addFiles(pasted);
    };

    const sidebarBody = <>
        <div className="flex items-center justify-between px-2 pb-1 pt-1">
            <span className="px-2 text-sm font-semibold">文本对话</span>
            <Button type="text" aria-label="新建对话" title="新建对话" icon={<SquarePen className="size-4" />} disabled={sending} onClick={() => selectConversation("")} />
        </div>
        <div className="px-2 pb-2 pt-1">
            <Input allowClear size="small" variant="filled" prefix={<Search className="size-3.5 text-muted-foreground" />} placeholder="搜索对话" value={historyKeyword} onChange={(event) => setHistoryKeyword(event.target.value)} />
        </div>
        <div className="thin-scrollbar min-h-0 flex-1 overflow-y-auto px-2 pb-2">
            {conversations.error ? <Alert type="error" title={conversations.error.message} /> : conversations.isPending ? <Spin className="!block py-6" /> : !visibleItems.length ? <p className="px-3 py-6 text-xs text-muted-foreground">{historyKeyword.trim() ? "没有匹配的对话" : "暂无对话"}</p> : groups.map((group) => (
                <div key={group.label} className="pb-2">
                    <p className="px-3 pb-1 pt-3 text-xs text-muted-foreground">{group.label}</p>
                    {group.items.map((item) => (
                        <div key={item.id} className={cn("group relative rounded-lg transition", item.id === conversationId ? "bg-muted" : "hover:bg-muted/70")}>
                            <button type="button" disabled={sending} onClick={() => selectConversation(item.id)} className={cn("w-full truncate rounded-lg px-3 py-2 pr-8 text-left text-sm leading-6", item.id === conversationId ? "font-medium text-foreground" : "text-muted-foreground hover:text-foreground")}>{item.title}</button>
                            <Dropdown trigger={["click"]} menu={{ items: [{ key: "delete", label: "删除", danger: true, icon: <Trash2 className="size-3.5" /> }], onClick: ({ domEvent }) => { domEvent.stopPropagation(); removeConversation(item); } }}>
                                <button type="button" aria-label="更多操作" title="更多操作" className="absolute right-1.5 top-1/2 hidden -translate-y-1/2 rounded-md p-1 text-muted-foreground transition hover:bg-background hover:text-foreground group-hover:block"><Ellipsis className="size-4" /></button>
                            </Dropdown>
                        </div>
                    ))}
                </div>
            ))}
            {conversations.hasNextPage ? <Button type="text" size="small" block loading={conversations.isFetchingNextPage} onClick={() => void conversations.fetchNextPage()}>加载更多</Button> : null}
        </div>
    </>;

    return <div className="flex h-full min-h-0">
        <aside className="hidden w-64 shrink-0 flex-col border-r border-border bg-muted/40 px-2 py-4 md:flex">{sidebarBody}</aside>
        <Drawer placement="left" width={300} open={historyOpen} onClose={() => setHistoryOpen(false)} styles={{ body: { display: "flex", flexDirection: "column", padding: "16px 8px" } }} closable={false}>{sidebarBody}</Drawer>
        <section className="flex min-w-0 flex-1 flex-col">
            <header className="flex h-14 shrink-0 items-center justify-between gap-3 px-4 sm:px-6">
                <div className="flex min-w-0 items-center gap-1">
                    <Button type="text" className="md:!hidden" aria-label="历史对话" title="历史对话" icon={<PanelLeft className="size-4" />} onClick={() => setHistoryOpen(true)} />
                    <h2 className="min-w-0 truncate text-sm font-medium">{conversation.data?.conversation.title || "新对话"}</h2>
                </div>
                <div className="flex shrink-0 items-center gap-1 sm:gap-2">
                    <Link to="/user/wallet" className="mr-2 text-xs text-muted-foreground hover:text-foreground">余额 ¥{wallet.data?.wallet.balance ?? "—"}</Link>
                    <Button type="text" aria-label="对话设置" icon={<Settings2 className="size-4" />} onClick={() => setSettingsOpen(true)} />
                    <Button type="text" className="md:!hidden" aria-label="新建对话" icon={<Plus className="size-4" />} disabled={sending} onClick={() => selectConversation("")} />
                </div>
            </header>
            <div ref={scroll} className="thin-scrollbar min-h-0 flex-1 overflow-y-auto" onScroll={(event) => { const el = event.currentTarget; follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40; }}>
                <div className="mx-auto max-w-3xl space-y-6 px-4 py-6 sm:px-6">
                    {models.error || conversation.error ? <Alert type="error" title={models.error?.message || conversation.error?.message} /> : null}
                    {unavailableModel ? <Alert type="warning" showIcon title="已选模型已下线或暂无可用渠道，请明确选择其它模型后继续发送" /> : null}
                    {conversationId && conversation.isPending ? <Spin className="!block py-10" /> : null}
                    {!conversationId ? <div className="flex min-h-[50vh] flex-col items-center justify-center text-center">
                        <h2 className="text-2xl font-semibold tracking-tight sm:text-3xl">有什么可以帮忙的？</h2>
                        <p className="mt-3 max-w-md text-sm leading-7 text-muted-foreground">输入问题开始对话，对话自动保存；支持图片输入的模型可以直接识图问答。</p>
                        {!models.isPending && !available.length ? <Empty className="mt-8" description="暂无可用文本模型" /> : null}
                    </div> : null}
                    {conversation.data?.messages.map((item) => item.role === "user" ? (
                        <div key={item.id} className="group flex flex-col items-end">
                            <div className="max-w-[85%] rounded-3xl bg-muted px-4 py-2.5 sm:max-w-[75%]">
                                {item.attachments?.length ? <MessageAttachments attachments={item.attachments} /> : null}
                                {item.content ? <p className="whitespace-pre-wrap break-words text-[15px] leading-7">{item.content}</p> : null}
                            </div>
                            <div className="mt-1 opacity-100 transition-opacity sm:opacity-0 sm:group-hover:opacity-100">
                                <Button type="text" size="small" aria-label="复制消息" title="复制" icon={<Copy className="size-3.5" />} onClick={() => copy(item.content)} />
                            </div>
                        </div>
                    ) : (
                        <div key={item.id} className="group">
                            <Streamdown className="agent-streamdown" controls={{ code: { copy: true, download: false }, table: { copy: true, download: false, fullscreen: false } }}>{item.content}</Streamdown>
                            <div className="mt-1 flex items-center opacity-100 transition-opacity sm:opacity-0 sm:group-hover:opacity-100">
                                <Button type="text" size="small" aria-label="复制回复" title="复制" icon={<Copy className="size-3.5" />} onClick={() => copy(item.content)} />
                            </div>
                        </div>
                    ))}
                    {latest?.partialText && !latest.responseMessageId ? <div><Streamdown className="agent-streamdown" isAnimating={active}>{latest.partialText}</Streamdown></div> : null}
                    {active ? <div className="flex items-center gap-2 text-sm text-muted-foreground"><Spin size="small" />{latest?.status === "reviewing" ? "等待内容审核，可取消并退回冻结金额" : latest?.canCancel ? "正在等待提交，可取消并全退" : "已提交上游，继续生成并正常结算"}</div> : latest?.status === "failed" || latest?.status === "canceled" ? <Alert type="warning" showIcon title={latest.errorMessage || "本次生成已结束，冻结余额已退回"} /> : latest?.status === "succeeded" ? <p className="text-xs text-muted-foreground">本次实付 ¥{latest.billed}</p> : null}
                    {streamError ? <Alert type="warning" title={streamError} action={<Button size="small" onClick={() => void conversation.refetch()}>刷新对话</Button>} /> : null}
                </div>
            </div>
            <footer className="px-4 pb-5 pt-3 sm:px-6">
                <div className="mx-auto max-w-3xl">
                    <div className="rounded-3xl border border-border bg-background p-3 transition-colors focus-within:border-muted-foreground/40">
                        {files.length ? <div className="flex flex-wrap gap-2 px-1 pb-2">
                            {files.map((item, index) => <div key={item.url} className="relative">
                                <img src={item.url} alt={item.file.name} className="size-14 rounded-xl border border-border object-cover" />
                                <button type="button" aria-label={`移除 ${item.file.name}`} onClick={() => removeFile(index)} className="absolute -right-1.5 -top-1.5 flex size-5 items-center justify-center rounded-full border border-border bg-background text-muted-foreground shadow-sm transition hover:text-foreground"><X className="size-3" /></button>
                            </div>)}
                        </div> : null}
                        <Input.TextArea aria-label="消息内容" variant="borderless" className="!px-1 !pt-0 !text-[15px] !leading-7" autoSize={{ minRows: 1, maxRows: 8 }} maxLength={100000} value={prompt} disabled={sending} onChange={(event) => setPrompt(event.target.value)} placeholder="有什么问题，尽管问" onPaste={pasteFiles} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send(); } }} />
                        <div className="mt-1 flex items-center justify-between gap-2">
                            <div className="flex items-center gap-1">
                                <input ref={fileInput} type="file" className="hidden" multiple accept="image/*" onChange={pickFiles} />
                                <Tooltip title={model?.imageInput ? "添加图片" : "当前模型不支持图片输入"}>
                                    <span className="inline-flex"><Button type="text" aria-label="添加图片" icon={<Paperclip className="size-4" />} disabled={!model?.imageInput || sending || active || files.length >= maxAttachments} onClick={() => fileInput.current?.click()} /></span>
                                </Tooltip>
                            </div>
                            <div className="flex min-w-0 items-center justify-end gap-1 sm:gap-2">
                                <Select aria-label="选择文本模型" title="选择模型" variant="borderless" className="min-w-0 max-w-64 flex-1 sm:flex-none sm:min-w-36 sm:max-w-80" prefix={<Circle className="size-3.5 text-muted-foreground" />} suffixIcon={<ChevronDown className="size-3" />} value={modelId || undefined} labelRender={(option) => unavailableModel ? "已选模型不可用" : option.label} onChange={changeModel} disabled={sending || active} loading={models.isPending} placeholder="选择模型" showSearch optionFilterProp="label" placement="topRight" popupMatchSelectWidth={false} styles={{ popup: { root: { maxWidth: "calc(100vw - 32px)" } } }} options={available.map((item) => ({ value: item.id, label: item.displayName, price: modelPriceLabel(item), image: Boolean(item.imageInput) }))} optionRender={(option) => <div className="max-w-80 py-1"><div className="flex items-center gap-2 font-medium">{option.data.label}{option.data.image ? <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] leading-none text-muted-foreground">图片</span> : null}</div><div className="mt-1 whitespace-normal text-xs text-muted-foreground">{option.data.price}</div></div>} />
                                <Select<ReasoningEffort> aria-label="思考强度" title="思考强度" variant="borderless" className="!w-24 shrink-0" prefix={<Brain className="size-4" />} suffixIcon={<ChevronDown className="size-3" />} value={effort} onChange={setReasoningEffort} disabled={!model?.reasoningEfforts?.length || sending || active} placement="topRight" options={modelReasoningOptions(model)} />
                                {active ? <Button type="text" className="!size-8 !min-w-8 !rounded-full" aria-label="取消生成" title={latest?.canCancel ? "取消生成并全退" : "已提交上游，无法取消"} disabled={!latest?.canCancel} icon={<Square className="size-3.5" />} loading={canceling} onClick={() => void cancel()} /> : <Button type="primary" className="!size-8 !min-w-8 !rounded-full" aria-label="发送消息" title="发送消息" icon={<ArrowUp className="size-4" />} loading={sending} disabled={!canSend} onClick={() => void send()} />}
                            </div>
                        </div>
                    </div>
                    <p className="mt-3 text-center text-xs leading-5 text-muted-foreground">{quote.data && prompt.trim() ? `预计冻结 ¥${quote.data.quote.estimatedHold}${files.length ? "（提交时另计新附图片预算）" : ""}，实际费用多退少补，欠费后需结清再生成。` : "内容由 AI 生成，请核实重要信息。"} Enter 发送 · Shift + Enter 换行</p>
                    {quote.error ? <p className="mt-1 text-center text-xs text-destructive">{quote.error.message}</p> : null}
                </div>
            </footer>
        </section>
        <Drawer title="对话设置" open={settingsOpen} onClose={() => setSettingsOpen(false)}><label htmlFor="text-system-prompt" className="mb-3 block text-sm font-medium">系统提示词</label><Input.TextArea id="text-system-prompt" rows={8} value={systemPrompt} maxLength={100000} disabled={sending || active} onChange={(event) => setSystemPrompt(event.target.value)} placeholder="例如：用简洁的中文回答，并在必要时给出例子。" /><p className="mt-3 text-xs leading-6 text-muted-foreground">填写后用于后续请求，不会改写已有消息。</p></Drawer>
    </div>;
}

function MessageAttachments({ attachments }: { attachments: MediaRecord[] }) {
    return <Image.PreviewGroup>
        <div className="flex flex-wrap justify-end gap-2 pb-1.5">
            {attachments.map((item) => <Image key={item.id} src={item.url} alt={item.originalName} height={112} className="max-w-48 rounded-xl object-cover" />)}
        </div>
    </Image.PreviewGroup>;
}

function groupConversations(items: ConversationItem[]) {
    const groups: { label: string; items: ConversationItem[] }[] = [];
    for (const item of items) {
        const days = dayjs().startOf("day").diff(dayjs(item.updatedAt).startOf("day"), "day");
        const label = days <= 0 ? "今天" : days === 1 ? "昨天" : days <= 7 ? "前 7 天" : days <= 30 ? "前 30 天" : "更早";
        const last = groups.at(-1);
        if (last?.label === label) last.items.push(item);
        else groups.push({ label, items: [item] });
    }
    return groups;
}

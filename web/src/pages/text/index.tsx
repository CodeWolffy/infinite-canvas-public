import { useDeferredValue, useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, App, Button, Drawer, Empty, Input, InputNumber, Select, Spin } from "antd";
import { ArrowUp, Copy, MessageSquare, Plus, Settings2, Square } from "lucide-react";
import { Link, useSearchParams } from "react-router-dom";
import { Streamdown } from "streamdown";

import { useCopyText } from "@/hooks/use-copy-text";
import { getPublicModels } from "@/services/api/generation";
import { getWallet } from "@/services/api/billing";
import { quoteGeneration } from "@/services/api/platform-operations";
import { getTextConversation, listTextConversations, queueTextRequest, watchTextRequest } from "@/services/api/text";
import { cancelGenerationTask } from "@/services/api/tasks";
import { assertCurrentSession, useUserStore } from "@/stores/use-user-store";
import { cn } from "@/lib/utils";

type Conversation = Awaited<ReturnType<typeof getTextConversation>>;
const activeStates = ["reviewing", "queued", "running"];

export default function TextPage() {
    const { message } = App.useApp();
    const client = useQueryClient();
    const session = useUserStore((state) => state.sessionVersion);
    const copy = useCopyText();
    const [search, setSearch] = useSearchParams();
    const conversationId = search.get("conversation") || "";
    const [modelId, setModelId] = useState("");
    const [prompt, setPrompt] = useState("");
    const [systemPrompt, setSystemPrompt] = useState("");
    const [maxTokens, setMaxTokens] = useState<number | null>(null);
    const [settingsOpen, setSettingsOpen] = useState(false);
    const [page, setPage] = useState(1);
    const [sending, setSending] = useState(false);
    const [canceling, setCanceling] = useState(false);
    const [streamError, setStreamError] = useState("");
    const pending = useRef<{ fingerprint: string; id: string } | null>(null);
    const scroll = useRef<HTMLDivElement>(null);
    const follow = useRef(true);
    const previousSession = useRef(session);
    const restoredConversation = useRef("");
    const models = useQuery({ queryKey: ["public-models", session], queryFn: getPublicModels });
    const available = (models.data || []).filter((model) => model.capability === "text");
    const model = available.find((item) => item.id === modelId) || available[0];
    const wallet = useQuery({ queryKey: ["wallet", session], queryFn: getWallet });
    const conversations = useQuery({ queryKey: ["text-conversations", session, page], queryFn: () => listTextConversations((page - 1) * 50) });
    const conversation = useQuery({ queryKey: ["text-conversation", session, conversationId], queryFn: () => getTextConversation(conversationId), enabled: Boolean(conversationId) });
    const latest = conversation.data?.latestRequest;
    const active = Boolean(latest && activeStates.includes(latest.status));
    const quotedPrompt = useDeferredValue(prompt);
    const parameters = maxTokens == null ? {} : { max_tokens: maxTokens };
    const needsLimit = Boolean(model?.requiresMaxOutputTokens && !maxTokens);
    const quote = useQuery({ queryKey: ["text-quote", session, model?.id, conversationId, quotedPrompt, systemPrompt, maxTokens], queryFn: ({ signal }) => quoteGeneration({ modelId: model!.id, count: 1, content: quotedPrompt, conversationId: conversationId || undefined, systemPrompt, parameters }, signal), enabled: Boolean(model && quotedPrompt.trim() && !needsLimit), gcTime: 0 });

    useEffect(() => {
        if (previousSession.current === session) return;
        previousSession.current = session;
        pending.current = null;
        restoredConversation.current = "";
        setPrompt(""); setSystemPrompt(""); setMaxTokens(null); setModelId(""); setStreamError(""); setSending(false); setCanceling(false); setPage(1);
        setSearch({}, { replace: true });
    }, [session, setSearch]);

    useEffect(() => {
        const saved = conversation.data?.conversation;
        if (!saved || restoredConversation.current === saved.id) return;
        restoredConversation.current = saved.id;
        setModelId(saved.modelId || "");
        setSystemPrompt(String(saved.parameters?.systemPrompt || ""));
        const limit = saved.parameters?.max_completion_tokens ?? saved.parameters?.max_tokens ?? saved.parameters?.maxOutputTokens;
        setMaxTokens(limit == null ? null : Number(limit));
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
        if (sending || active || !model || !prompt.trim() || needsLimit || quotedPrompt !== prompt || quote.isFetching || !quote.data || conversationId && (conversation.isPending || conversation.isError)) return;
        const version = useUserStore.getState().sessionVersion;
        const input = { modelId: model.id, conversationId: conversationId || undefined, content: prompt.trim(), title: prompt.trim().slice(0, 100), systemPrompt, parameters };
        const fingerprint = JSON.stringify(input);
        if (pending.current?.fingerprint !== fingerprint) pending.current = { fingerprint, id: crypto.randomUUID() };
        setSending(true);
        try {
            const accepted = await queueTextRequest({ ...input, requestId: pending.current.id });
            assertCurrentSession(version);
            pending.current = null;
            setPrompt(""); setStreamError(""); follow.current = true;
            setSearch({ conversation: accepted.conversationId }, { replace: true });
            await Promise.all([client.invalidateQueries({ queryKey: ["text-conversation", version, accepted.conversationId] }), client.invalidateQueries({ queryKey: ["text-conversations", version] }), client.invalidateQueries({ queryKey: ["wallet", version] })]);
        } catch (error) {
            if (useUserStore.getState().sessionVersion === version && error instanceof Error && error.name !== "AbortError") message.error(error.message);
        } finally {
            if (useUserStore.getState().sessionVersion === version) setSending(false);
        }
    };
    const cancel = async () => {
        if (!latest || canceling) return;
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
    const selectConversation = (id: string) => { setSearch(id ? { conversation: id } : {}); setStreamError(""); setPrompt(""); restoredConversation.current = ""; pending.current = null; };

    return <div className="flex h-full min-h-0">
        <aside className="hidden w-64 shrink-0 flex-col border-r border-border px-3 py-5 md:flex">
            <div className="mb-5 flex items-center justify-between px-2"><h1 className="flex items-center gap-2 text-sm font-medium"><MessageSquare className="size-4" />文本对话</h1><Button type="text" aria-label="新建对话" icon={<Plus className="size-4" />} disabled={sending} onClick={() => selectConversation("")} /></div>
            <div className="min-h-0 flex-1 overflow-y-auto">{conversations.error ? <Alert type="error" title={conversations.error.message} /> : conversations.isPending ? <Spin className="!block" /> : (conversations.data || []).map((item) => <button key={item.id} type="button" disabled={sending} onClick={() => selectConversation(item.id)} className={cn("mb-1 w-full truncate rounded-lg px-3 py-3 text-left text-sm transition hover:bg-muted", item.id === conversationId ? "bg-muted font-medium" : "text-muted-foreground")}>{item.title}</button>)}</div>
            <div className="mt-4 flex justify-between"><Button type="text" size="small" disabled={page === 1} onClick={() => setPage((p) => p - 1)}>上一页</Button><Button type="text" size="small" disabled={(conversations.data?.length || 0) < 50} onClick={() => setPage((p) => p + 1)}>下一页</Button></div>
            <Link to="/status" className="mt-5 border-t border-border px-2 pt-4 text-xs text-muted-foreground hover:text-foreground">查看模型运行状态 ↗</Link>
        </aside>
        <section className="flex min-w-0 flex-1 flex-col">
            <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-4 lg:px-8"><Select className="min-w-44 max-w-xs flex-1" aria-label="文本模型" value={model?.id} onChange={setModelId} disabled={sending || active} loading={models.isPending} placeholder="选择文本模型" showSearch optionFilterProp="label" options={available.map((item) => ({ value: item.id, label: item.displayName }))} /><div className="flex items-center gap-2"><Link to="/user/wallet" className="mr-2 text-xs text-muted-foreground">余额 ¥{wallet.data?.wallet.balance ?? "—"}</Link><Button type="text" icon={<Settings2 className="size-4" />} onClick={() => setSettingsOpen(true)}>设置</Button><Button type="text" className="md:!hidden" aria-label="新建对话" icon={<Plus className="size-4" />} disabled={sending} onClick={() => selectConversation("")} /></div></header>
            <div className="border-b border-border px-5 py-3 md:hidden"><Select className="w-full" allowClear placeholder="历史对话" value={conversationId || undefined} disabled={sending} onChange={(id) => selectConversation(id || "")} options={(conversations.data || []).map((item) => ({ value: item.id, label: item.title }))} /></div>
            <div ref={scroll} className="min-h-0 flex-1 overflow-y-auto px-5 py-8 lg:px-8" onScroll={(event) => { const el = event.currentTarget; follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40; }}>
                <div className="mx-auto max-w-3xl space-y-8">
                    {models.error || conversation.error ? <Alert type="error" title={models.error?.message || conversation.error?.message} /> : null}
                    {conversationId && conversation.isPending ? <Spin className="!block" /> : null}
                    {!conversationId ? <div className="py-12 sm:py-20"><MessageSquare className="mb-6 size-8 text-muted-foreground" /><h2 className="text-3xl font-semibold tracking-tight">从一句话开始。</h2><p className="mt-4 text-sm leading-7 text-muted-foreground">讨论想法、整理思路，或让模型帮你完成一段文字。<br />对话自动保存，可以随时回来继续。</p>{!models.isPending && !available.length ? <Empty className="mt-10" description="暂无可用文本模型" /> : null}</div> : null}
                    {conversation.data?.messages.map((item) => <article key={item.id}><div className="mb-3 flex items-center justify-between text-xs text-muted-foreground"><span>{item.role === "user" ? "你" : "助手"}</span><Button type="text" size="small" aria-label="复制消息" icon={<Copy className="size-3.5" />} onClick={() => copy(item.content)} /></div>{item.role === "user" ? <p className="whitespace-pre-wrap break-words text-sm leading-7">{item.content}</p> : <Streamdown className="agent-streamdown" controls={{ code: { copy: true, download: false }, table: { copy: true, download: false, fullscreen: false } }}>{item.content}</Streamdown>}</article>)}
                    {latest?.partialText && !latest.responseMessageId ? <article><p className="mb-3 text-xs text-muted-foreground">{active ? "助手 · 正在回复" : "助手 · 未完成的回复"}</p><Streamdown className="agent-streamdown" isAnimating={active}>{latest.partialText}</Streamdown></article> : null}
                    {active ? <p className="flex items-center gap-2 text-sm text-muted-foreground"><Spin size="small" />{latest?.status === "reviewing" ? "等待内容审核，可取消并退回冻结金额" : latest?.status === "queued" ? (latest.attemptCount ? "正在切换渠道" : "正在等待可用渠道") : "正在生成回复"}</p> : latest?.status === "failed" || latest?.status === "canceled" ? <Alert type="warning" showIcon title={latest.errorMessage || "本次生成已结束，冻结余额已退回"} /> : latest?.status === "succeeded" ? <p className="text-xs text-muted-foreground">本次实付 ¥{latest.billed}</p> : null}
                    {streamError ? <Alert type="warning" title={streamError} action={<Button size="small" onClick={() => void conversation.refetch()}>刷新对话</Button>} /> : null}
                </div>
            </div>
            <footer className="px-5 pb-5 pt-3 lg:px-8"><div className="mx-auto max-w-3xl"><div className="rounded-xl border border-border p-3"><Input.TextArea aria-label="消息内容" variant="borderless" autoSize={{ minRows: 2, maxRows: 7 }} maxLength={100000} value={prompt} disabled={sending} onChange={(event) => setPrompt(event.target.value)} placeholder="写下你的问题或创作要求……" onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send(); } }} /><div className="mt-2 flex flex-wrap items-center justify-between gap-3"><div className="flex items-center gap-2"><InputNumber aria-label="最大输出 token" className="!w-44" min={1} precision={0} value={maxTokens} disabled={sending || active} onChange={setMaxTokens} placeholder={model?.requiresMaxOutputTokens ? "最大输出 token（必填）" : "最大输出 token（选填）"} /></div>{active ? <Button icon={<Square className="size-3" />} loading={canceling} onClick={() => void cancel()}>取消生成</Button> : <Button type="primary" shape="circle" aria-label="发送消息" icon={<ArrowUp className="size-4" />} loading={sending} disabled={!model || !prompt.trim() || needsLimit || quotedPrompt !== prompt || quote.isFetching || !quote.data} onClick={() => void send()} />}</div></div>
                <p className="mt-3 text-xs leading-5 text-muted-foreground">{needsLimit ? "此模型需要你指定最大输出 token 数。" : quote.data && prompt.trim() ? `预计冻结 ¥${quote.data.quote.estimatedHold}，完成后按实际用量结算。` : "Enter 发送 · Shift + Enter 换行"} 对话保存在当前账号。</p>{quote.error ? <p className="mt-1 text-xs text-destructive">{quote.error.message}</p> : null}
            </div></footer>
        </section>
        <Drawer title="对话设置" open={settingsOpen} onClose={() => setSettingsOpen(false)}><label htmlFor="text-system-prompt" className="mb-3 block text-sm font-medium">系统提示词</label><Input.TextArea id="text-system-prompt" rows={8} value={systemPrompt} maxLength={100000} disabled={sending || active} onChange={(event) => setSystemPrompt(event.target.value)} placeholder="例如：用简洁的中文回答，并在必要时给出例子。" /><p className="mt-3 text-xs leading-6 text-muted-foreground">填写后用于后续请求，不会改写已有消息。最大输出 token 数在输入框下方填写。</p></Drawer>
    </div>;
}

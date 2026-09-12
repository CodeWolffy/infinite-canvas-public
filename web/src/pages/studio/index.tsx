import { useDeferredValue, useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, App, Button, Empty, Image, Input, InputNumber, Segmented, Select, Spin, Tag } from "antd";
import { ArrowUpRight, AudioLines, Clock3, ImagePlus, MessageSquare, Paperclip, Play, Square, Video, X } from "lucide-react";
import { Link, useSearchParams } from "react-router-dom";
import dayjs from "dayjs";

import { createGenerationBatch, getPublicModels, type GenerationTask, type PublicModel } from "@/services/api/generation";
import { uploadMedia } from "@/services/api/media";
import { getTextConversation, listTextConversations, queueTextRequest, watchTextRequest } from "@/services/api/text";
import { quoteGeneration } from "@/services/api/platform-operations";
import { cancelGenerationTask, getCapabilityBatches, getStudioBatch } from "@/services/api/tasks";
import { getWallet } from "@/services/api/billing";
import { assertCurrentSession, useUserStore } from "@/stores/use-user-store";
import { cn } from "@/lib/utils";
import { modelPriceLabel } from "@/lib/model-price";
import { modelReasoningOptions, resolveReasoningEffort, type ReasoningEffort } from "@/lib/model-reasoning";
import { useAssetStore } from "@/stores/use-asset-store";
import { readVideoMeta } from "@/services/file-storage";

type Capability = PublicModel["capability"];
const labels: Record<Capability, string> = { image: "图片", video: "视频", text: "文本", audio: "音频" };
const states: Record<GenerationTask["status"], string> = { reviewing: "待审核", queued: "排队中", running: "生成中", succeeded: "已完成", failed: "未完成", canceled: "已取消" };

export default function StudioPage() {
    const { message } = App.useApp();
    const client = useQueryClient();
    const session = useUserStore((state) => state.sessionVersion);
    const addAsset = useAssetStore((state) => state.addAsset);
    const [search, setSearch] = useSearchParams();
    const capability: Capability = ["image", "video", "text", "audio"].includes(search.get("type") || "") ? search.get("type") as Capability : "image";
    const [selectedModel, setSelectedModel] = useState("");
    const [prompt, setPrompt] = useState("");
    const [count, setCount] = useState(1);
    const [imageSize, setImageSize] = useState("1024x1024");
    const [videoSize, setVideoSize] = useState("1280x720");
    const size = capability === "video" ? videoSize : imageSize;
    const setSize = capability === "video" ? setVideoSize : setImageSize;
    const [seconds, setSeconds] = useState(6);
    const [voice, setVoice] = useState("alloy");
    const [reasoningEffort, setReasoningEffort] = useState<ReasoningEffort>("auto");
    const [files, setFiles] = useState<File[]>([]);
    const [batchID, setBatchID] = useState<string | null>(search.get("batch"));
    const [conversationID, setConversationID] = useState<string | null>(search.get("conversation"));
    const [page, setPage] = useState(1);
    const inputRef = useRef<HTMLInputElement>(null);
    const pendingKey = useRef<{ body: string; id: string; mediaIds?: string[] } | null>(null);
    const previousSession = useRef(session);
    const models = useQuery({ queryKey: ["public-models", session], queryFn: getPublicModels });
    const wallet = useQuery({ queryKey: ["wallet", session], queryFn: getWallet });
    const available = (models.data || []).filter((model) => model.capability === capability);
    const model = available.find((item) => item.id === selectedModel) || available[0];
    const effort = resolveReasoningEffort(model, reasoningEffort);
    const textParameters = effort === "auto" ? {} : { reasoningEffort: effort };
    const quotedPrompt = useDeferredValue(prompt);
    const quote = useQuery({ queryKey: ["generation-quote", session, model?.id, count, seconds, capability, conversationID, quotedPrompt, effort], queryFn: ({ signal }) => quoteGeneration({ modelId: model!.id, count: capability === "text" ? 1 : count, content: quotedPrompt, conversationId: capability === "text" ? conversationID || undefined : undefined, parameters: capability === "video" ? { seconds } : capability === "text" ? textParameters : {} }, signal), enabled: Boolean(model && quotedPrompt.trim()), gcTime: 0 });
    const batches = useQuery({ queryKey: ["studio-batches", session, capability, page], queryFn: () => getCapabilityBatches(capability, (page - 1) * 50), enabled: capability !== "text", refetchInterval: (query) => query.state.data?.batches.some((batch) => batch.summary.activeCount > 0) ? 2500 : false });
    const currentBatchID = batchID || batches.data?.batches[0]?.id;
    const detail = useQuery({ queryKey: ["studio-batch", session, currentBatchID], queryFn: () => getStudioBatch(currentBatchID!), enabled: Boolean(currentBatchID) && capability !== "text", refetchInterval: (query) => query.state.data?.tasks.some((task) => task.status === "reviewing" || task.status === "queued" || task.status === "running") ? 2500 : false });
    const conversations = useQuery({ queryKey: ["studio-conversations", session], queryFn: () => listTextConversations(), enabled: capability === "text" });
    const conversation = useQuery({ queryKey: ["studio-conversation", session, conversationID], queryFn: () => getTextConversation(conversationID!), enabled: Boolean(conversationID) && capability === "text", refetchInterval: (query) => ["reviewing", "queued", "running"].includes(query.state.data?.latestRequest?.status || "") ? 2500 : false });
    const cancel = useMutation({ mutationFn: cancelGenerationTask, onSuccess: () => { void detail.refetch(); void conversation.refetch(); void client.invalidateQueries({ queryKey: ["wallet"] }); }, onError: (error: Error) => message.error(error.message) });
    useEffect(() => { if (previousSession.current !== session) { pendingKey.current = null; setPrompt(""); setSelectedModel(""); setReasoningEffort("auto"); setFiles([]); setBatchID(null); setConversationID(null); previousSession.current = session; } }, [session]);

    const submit = useMutation({ mutationFn: async () => {
        if (!model || !prompt.trim()) throw new Error("请选择模型并输入创作内容");
        const version = useUserStore.getState().sessionVersion;
        const input = { modelId: model.id, prompt: prompt.trim(), count: capability === "text" ? 1 : count, capability, size, seconds, voice, effort, conversationID, files: files.map((file) => [file.name, file.size, file.lastModified]) };
        const body = JSON.stringify(input);
        if (pendingKey.current?.body !== body) pendingKey.current = { body, id: crypto.randomUUID() };
        const requestId = pendingKey.current.id;
        const mediaIds = pendingKey.current.mediaIds || (await Promise.all(files.map((file) => uploadMedia(file, file.name)))).map((file) => file.id);
        assertCurrentSession(version);
        pendingKey.current.mediaIds = mediaIds;
        if (capability === "text") {
            const accepted = await queueTextRequest({ requestId, modelId: model.id, content: input.prompt, conversationId: conversationID || undefined, title: input.prompt.slice(0, 100), attachmentMediaIds: mediaIds, parameters: textParameters });
            assertCurrentSession(version);
            setConversationID(accepted.conversationId);
            setSearch({ type: "text", conversation: accepted.conversationId }, { replace: true });
            void client.invalidateQueries({ queryKey: ["studio-conversations"] });
            void client.invalidateQueries({ queryKey: ["studio-conversation"] });
        } else {
            const result = await createGenerationBatch({ requestId, modelId: model.id, prompt: input.prompt, count, referenceMediaIds: mediaIds, parameters: capability === "image" ? { size, quality: "auto" } : capability === "video" ? { size: size === "auto" ? "1280x720" : size, seconds: String(seconds), mode: "frames", generate_audio: true } : { voice, response_format: "mp3" } });
            assertCurrentSession(version);
            setBatchID(result.batch.id);
            setSearch({ type: capability, batch: result.batch.id }, { replace: true });
            void client.invalidateQueries({ queryKey: ["studio-batches"] });
        }
        pendingKey.current = null;
        void client.invalidateQueries({ queryKey: ["wallet"] });
    }, onError: (error: Error) => { if (error.name !== "AbortError") message.error(error.message); } });

    const changeCapability = (value: Capability) => { setSearch({ type: value }); setSelectedModel(""); setBatchID(null); setConversationID(null); setFiles([]); setPage(1); pendingKey.current = null; };
    const latestText = conversation.data?.latestRequest;
    useEffect(() => {
        if (!latestText || !["reviewing", "queued", "running"].includes(latestText.status) || !conversationID) return;
        return watchTextRequest(latestText.id, (detail) => {
            client.setQueryData<Awaited<ReturnType<typeof getTextConversation>>>(["studio-conversation", session, conversationID], (current) => current ? {
                ...current, latestRequest: detail.request,
                messages: detail.message && !current.messages.some((item) => item.id === detail.message!.id) ? [...current.messages, detail.message] : current.messages,
            } : current);
        });
    }, [latestText?.id, latestText?.status, session, conversationID, client]);
    const settledKey = capability === "text"
        ? latestText && ["succeeded", "failed", "canceled"].includes(latestText.status) ? `${latestText.id}:${latestText.status}` : ""
        : detail.data?.tasks.length && detail.data.tasks.every((task) => !["reviewing", "queued", "running"].includes(task.status)) ? `${currentBatchID}:${detail.data.tasks.map((task) => task.status).join(",")}` : "";
    useEffect(() => {
        if (!settledKey) return;
        void client.invalidateQueries({ queryKey: ["wallet"] });
        void client.invalidateQueries({ queryKey: ["wallet-entries"] });
    }, [client, settledKey]);
    const saveOutput = async (task: GenerationTask) => {
        const version = useUserStore.getState().sessionVersion;
        const output = task.output;
        if (!output || capability === "text") return;
        const common = { title: detail.data?.batch.prompt.slice(0, 120) || "生成素材", coverUrl: capability === "image" ? output.url : "", tags: [], source: "创作工作台" };
        const data = { storageKey: `media:${output.mediaId}`, width: output.width || 0, height: output.height || 0, bytes: output.bytes, mimeType: output.mimeType };
        try {
            if (capability === "video") Object.assign(data, await readVideoMeta(output.url));
            assertCurrentSession(version);
            if (capability === "image") await addAsset({ ...common, kind: "image", data: { ...data, dataUrl: output.url } });
            else if (capability === "video") await addAsset({ ...common, kind: "video", data: { ...data, url: output.url } });
            else await addAsset({ ...common, kind: "audio", data: { ...data, url: output.url } });
            message.success("已保存到我的素材");
        } catch (error) { if (!(error instanceof Error && error.name === "AbortError")) message.error(error instanceof Error ? error.message : "保存失败"); }
    };
    const busyConversation = latestText && ["reviewing", "queued", "running"].includes(latestText.status);

    return <div className="flex min-h-full flex-col bg-background text-foreground">
        <header className="flex flex-wrap items-center justify-between gap-4 border-b border-border px-5 py-6 lg:px-9"><div><p className="text-xs tracking-[0.2em] text-muted-foreground">从一个想法开始</p><h1 className="mt-1 text-2xl font-semibold tracking-tight">创作工作台</h1></div><Link to="/user/wallet" className="flex items-center gap-2 text-sm text-muted-foreground">余额 ¥{wallet.data?.wallet.balance ?? "—"}<ArrowUpRight className="size-4" /></Link></header>
        <div className="grid flex-1 lg:grid-cols-[370px_minmax(0,1fr)] xl:grid-cols-[400px_minmax(0,1fr)]">
            <section className="border-b border-border p-5 lg:border-b-0 lg:border-r lg:p-7">
                <Segmented<Capability> block value={capability} disabled={submit.isPending} onChange={changeCapability} options={[{ value: "image", label: "图片", icon: <ImagePlus className="size-4" /> }, { value: "video", label: "视频", icon: <Video className="size-4" /> }, { value: "text", label: "文本", icon: <MessageSquare className="size-4" /> }, { value: "audio", label: "音频", icon: <AudioLines className="size-4" /> }]} />
                <label className="mb-2 mt-7 block text-sm font-medium" htmlFor="studio-model">模型</label><Select id="studio-model" className="w-full" size="large" value={model?.id} loading={models.isPending} disabled={submit.isPending} placeholder="选择模型" onChange={setSelectedModel} options={available.map((item) => ({ value: item.id, label: `${item.displayName} · ${modelPriceLabel(item) || "价格未配置"}` }))} />
                {models.error ? <Alert className="mt-3" type="error" title={models.error.message} /> : !models.isPending && !available.length ? <Alert className="mt-3" type="info" title={`暂无已发布的${labels[capability]}模型`} description="管理员配置渠道后即可开始创作。" /> : null}
                <label className="mb-2 mt-6 block text-sm font-medium" htmlFor="studio-prompt">{capability === "audio" ? "要朗读的文字" : "描述你的想法"}</label><Input.TextArea id="studio-prompt" value={prompt} onChange={(event) => setPrompt(event.target.value)} rows={7} maxLength={capability === "text" ? 100000 : 50000} disabled={submit.isPending} placeholder={capability === "image" ? "画面主体、环境、光线，以及你希望呈现的风格……" : capability === "video" ? "镜头中的主体、运动方式和画面变化……" : capability === "audio" ? "输入希望转换为声音的内容……" : "写下你的问题或创作要求……"} />
                {capability !== "audio" ? <><input ref={inputRef} type="file" className="hidden" multiple accept={capability === "video" ? "image/*,video/*,audio/*" : "image/*"} onChange={(event) => { setFiles(Array.from(event.target.files || [])); event.target.value = ""; }} /><Button type="text" className="mt-2" icon={<Paperclip className="size-4" />} disabled={submit.isPending} onClick={() => inputRef.current?.click()}>添加参考文件</Button>{files.length ? <div className="mt-2 space-y-1">{files.map((file, index) => <div key={`${file.name}-${index}`} className="flex items-center justify-between gap-2 text-xs text-muted-foreground"><span className="truncate">{file.name}</span><button type="button" disabled={submit.isPending} aria-label={`移除 ${file.name}`} onClick={() => setFiles((current) => current.filter((_, i) => i !== index))}><X className="size-3.5" /></button></div>)}</div> : null}</> : null}
                {capability === "text" ? <div className="mt-5"><label className="mb-2 block text-sm" htmlFor="studio-reasoning">思考强度</label><Select<ReasoningEffort> id="studio-reasoning" className="w-full" value={effort} onChange={setReasoningEffort} disabled={submit.isPending || !model?.reasoningEfforts?.length} options={modelReasoningOptions(model)} /><Link to="/text" className="mt-3 inline-block text-xs text-muted-foreground">打开文本对话页 ↗</Link></div> : null}
                <div className="mt-5 grid grid-cols-2 gap-4">{capability !== "text" ? <div><label className="mb-2 block text-sm" htmlFor="studio-count">生成数量</label><InputNumber id="studio-count" min={1} max={20} precision={0} className="!w-full" value={count} onChange={(value) => setCount(value || 1)} /></div> : null}{capability === "image" || capability === "video" ? <div><label className="mb-2 block text-sm" htmlFor="studio-size">尺寸</label><Select id="studio-size" className="w-full" value={size} onChange={setSize} options={(capability === "image" ? ["1024x1024", "1536x1024", "1024x1536", "auto"] : ["1280x720", "720x1280", "1920x1080", "1080x1920"]).map((value) => ({ value, label: value === "auto" ? "自动" : value }))} /></div> : null}{capability === "video" ? <div><label className="mb-2 block text-sm" htmlFor="studio-seconds">时长（秒）</label><InputNumber id="studio-seconds" min={1} value={seconds} className="!w-full" onChange={(value) => setSeconds(value || 6)} /></div> : null}{capability === "audio" ? <div><label className="mb-2 block text-sm" htmlFor="studio-voice">声音</label><Input id="studio-voice" value={voice} onChange={(event) => setVoice(event.target.value)} placeholder="模型支持的声音名称" /></div> : null}</div>
                <Button className="mt-7" size="large" type="primary" block icon={<Play className="size-4" />} loading={submit.isPending} disabled={!model || !prompt.trim() || quotedPrompt !== prompt || !quote.data || quote.isFetching || quote.isError || Boolean(busyConversation)} onClick={() => submit.mutate()}>开始生成{quote.data ? ` · 预冻结 ¥${quote.data.quote.estimatedHold}` : ""}</Button><p className="mt-3 text-xs leading-5 text-muted-foreground">{quote.data?.quote.variable ? capability === "audio" ? "按实际音频时长结算，当前以 5 秒预估冻结。" : "按实际用量结算，预估冻结额包含当前分组折扣。" : "费用已按当前分组价格计算。"}成功后结算，失败自动退回，离开页面后任务继续执行。</p>{quote.error ? <Alert className="mt-3" type="warning" title={quote.error.message} /> : null}
            </section>
            <section className="min-w-0 p-5 lg:p-7">
                <div className="mb-5 flex items-center justify-between"><h2 className="flex items-center gap-2 text-sm font-medium"><Clock3 className="size-4" />{capability === "text" ? "对话与历史" : "生成结果"}</h2>{capability === "text" ? <Button type="text" onClick={() => { setConversationID(null); setPrompt(""); setReasoningEffort("auto"); setSearch({ type: "text" }); }}>新建对话</Button> : <Link to="/canvas" className="text-xs text-muted-foreground">进入无限画布 ↗</Link>}</div>
                {capability === "text" ? <>
                    <Select className="mb-5 w-full" allowClear placeholder="选择历史对话，或从左侧开始新对话" value={conversationID} options={(conversations.data || []).map((item) => ({ value: item.id, label: item.title }))} onChange={(id) => setConversationID(id || null)} />
                    {conversation.isPending && conversationID ? <Spin /> : null}{conversation.error ? <Alert type="error" title={conversation.error.message} /> : null}
                    <div className="space-y-6">{conversation.data?.messages.map((item) => <article key={item.id} className="border-b border-border pb-6"><p className="mb-2 text-xs text-muted-foreground">{item.role === "user" ? "你" : "助手"}</p><p className="whitespace-pre-wrap break-words text-sm leading-7">{item.content}</p></article>)}</div>
                    {latestText?.partialText && !latestText.responseMessageId ? <article className="mt-6 border-b border-border pb-6"><p className="mb-2 text-xs text-muted-foreground">{busyConversation ? "助手 · 正在生成" : "助手 · 未完成的回复"}</p><p className="whitespace-pre-wrap break-words text-sm leading-7">{latestText.partialText}</p></article> : null}
                    {busyConversation ? <div className="mt-5 flex items-center justify-between"><span className="flex items-center gap-2 text-sm text-muted-foreground"><Spin size="small" />{latestText.status === "reviewing" ? "等待内容审核" : "正在生成回复"}</span><Button type="text" icon={<Square className="size-3" />} loading={cancel.isPending} onClick={() => cancel.mutate(latestText.id)}>取消</Button></div> : latestText?.status === "failed" ? <Alert className="mt-5" type="warning" title={latestText.errorMessage || "本次生成未完成，余额已退回"} /> : !conversationID ? <div className="py-20"><Empty description="让第一句话成为创作的起点" /></div> : latestText?.billed ? <p className="mt-5 text-xs text-muted-foreground">本次实付 ¥{latestText.billed}</p> : null}
                </> : <>
                    {batches.error || detail.error ? <Alert className="mb-5" type="error" title={(batches.error || detail.error)?.message} /> : null}
                    {(detail.data?.tasks.length || 0) > 0 ? <><p className="mb-5 text-sm leading-6 text-muted-foreground">{detail.data?.batch.prompt}</p><div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">{detail.data!.tasks.map((task) => <article key={task.id} className="min-w-0 overflow-hidden rounded-xl border border-border"><div className="flex min-h-44 items-center justify-center p-3">{task.output ? capability === "image" ? <Image src={task.output.url} alt={detail.data?.batch.prompt} className="!max-h-80 object-contain" /> : capability === "video" ? <video src={task.output.url} controls preload="metadata" className="w-full rounded-lg" /> : <audio src={task.output.url} controls preload="metadata" className="w-full" /> : task.status === "reviewing" || task.status === "queued" || task.status === "running" ? <div className="text-center"><Spin /><p className="mt-3 text-sm text-muted-foreground">{states[task.status]}</p></div> : <p className="p-4 text-sm text-muted-foreground">{task.errorMessage || states[task.status]}</p>}</div><div className="flex items-center justify-between border-t border-border px-3 py-2"><Tag variant="filled">{states[task.status]}</Tag>{task.output ? <div className="flex items-center gap-2"><Button type="text" size="small" onClick={() => void saveOutput(task)}>保存素材</Button><a href={task.output.url} download className="text-xs">下载</a></div> : task.status === "reviewing" || task.status === "queued" || task.status === "running" ? <Button type="text" size="small" loading={cancel.isPending && cancel.variables === task.id} onClick={() => cancel.mutate(task.id)}>取消</Button> : null}</div></article>)}</div></> : <div className="py-20"><Empty description="你的下一份作品，从这里开始" /></div>}
                    <div className="mt-9 border-t border-border pt-5"><h3 className="mb-3 text-sm font-medium">最近的创作</h3><div className="space-y-1">{batches.data?.batches.map((batch) => <button key={batch.id} type="button" className={cn("flex w-full items-center justify-between gap-4 rounded-lg px-3 py-3 text-left text-sm transition hover:bg-muted", currentBatchID === batch.id && "bg-muted")} onClick={() => { setBatchID(batch.id); setSearch({ type: capability, batch: batch.id }, { replace: true }); }}><span className="truncate">{batch.prompt}</span><span className="shrink-0 text-xs text-muted-foreground">{batch.summary.activeCount ? `${batch.summary.activeCount} 个进行中` : dayjs(batch.createdAt).format("MM-DD HH:mm")}</span></button>)}</div><div className="mt-4 flex justify-end gap-2"><Button disabled={page === 1} onClick={() => { setPage((value) => value - 1); setBatchID(null); }}>上一页</Button><Button disabled={(batches.data?.batches.length || 0) < 50} onClick={() => { setPage((value) => value + 1); setBatchID(null); }}>下一页</Button></div></div>
                </>}
            </section>
        </div>
    </div>;
}

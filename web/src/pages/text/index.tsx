import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState, type ChangeEvent, type ClipboardEvent } from "react";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, App, Button, Drawer, Dropdown, Empty, Input, Modal, Select, Spin, Tooltip } from "antd";
import { Archive, ArrowDown, ArrowUp, Brain, ChevronDown, Circle, Download, Ellipsis, PanelLeft, Paperclip, Pin, Plus, RotateCcw, Search, Settings2, Square, SquarePen, Trash2, X } from "lucide-react";
import { Link, useSearchParams } from "react-router-dom";
import { Streamdown } from "streamdown";
import dayjs from "dayjs";
import { saveAs } from "file-saver";

import { useConfirmInputReplace } from "@/hooks/use-confirm-input-replace";
import { clearWorkbenchDraft, getWorkbenchDraft, saveWorkbenchDraft } from "@/stores/use-workbench-draft-store";
import { usePublicModels } from "@/hooks/use-public-models";
import { getWallet } from "@/services/api/billing";
import { quoteGeneration } from "@/services/api/platform-operations";
import { deleteTextConversation, getTextConversation, getTextRequest, listTextConversations, queueTextRequest, updateTextConversation, watchTextRequest, type TextMessage } from "@/services/api/text";
import { ApiError } from "@/services/api/request";
import { mediaId, uploadMedia, type MediaRecord } from "@/services/api/media";
import { cancelGenerationTask, ensurePlatformMedia } from "@/services/api/tasks";
import { taskCancellationMessage } from "@/lib/task-cancellation";
import { assertCurrentSession, useUserStore } from "@/stores/use-user-store";
import { modelReasoningEfforts, modelReasoningOptions, resolveReasoningEffort, type ReasoningEffort } from "@/lib/model-reasoning";
import { modelPriceLabel } from "@/lib/model-price";
import { cn } from "@/lib/utils";
import { resolveCreationDraftModel } from "@/lib/creation-draft-model";
import { useCreationDraftStore } from "@/stores/use-creation-draft-store";
import { workbenchExamples } from "@/constant/creation-scenes";
import { useTextDraft, type PendingTextFile, type TextInputDraft } from "./use-text-draft";
import { TextMessageRow } from "./text-message";

type Conversation = Awaited<ReturnType<typeof getTextConversation>>;
type ConversationItem = Awaited<ReturnType<typeof listTextConversations>>[number];
type PendingFile = PendingTextFile & { status?: "uploading" | "ready" | "error"; error?: string };
const activeStates = ["reviewing", "queued", "running"];
const maxAttachments = 20;
const textExamples = workbenchExamples.filter((item) => item.example.capability === "text");

export default function TextPage() {
    const [search] = useSearchParams();
    const session = useUserStore((state) => state.sessionVersion);
    return <TextConversationPage key={`${session}:${search.get("conversation") || ""}`} />;
}

function TextConversationPage() {
    const { message, modal } = App.useApp();
    const client = useQueryClient();
    const confirmReplace = useConfirmInputReplace();
    const mounted = useRef(false);
    useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
    const session = useUserStore((state) => state.sessionVersion);
    const draft = useCreationDraftStore((state) => state.draft);
    const isAdmin = useUserStore((state) => state.user?.role === "admin");
    const setDraft = useCreationDraftStore((state) => state.setDraft);
    const clearDraft = useCreationDraftStore((state) => state.clearDraft);
    const appliedDraftRef = useRef("");
    const [search, setSearch] = useSearchParams();
    const conversationId = search.get("conversation") || "";
    const draftKey = `text:${conversationId}`;
    const savedInput = useRef(getWorkbenchDraft<TextInputDraft>(draftKey)).current;
    const [modelId, setModelId] = useState(savedInput?.modelId || "");
    const [ambiguousDraftModel, setAmbiguousDraftModel] = useState(false);
    const [prompt, setPrompt] = useState(savedInput?.prompt || "");
    const [systemPrompt, setSystemPrompt] = useState(savedInput?.systemPrompt || "");
    const [reasoningEffort, setReasoningEffort] = useState<ReasoningEffort>(savedInput?.reasoningEffort || "auto");
    const [settingsOpen, setSettingsOpen] = useState(false);
    const [historyOpen, setHistoryOpen] = useState(false);
    const [historyKeyword, setHistoryKeyword] = useState("");
    const [showArchived, setShowArchived] = useState(false);
    const [renaming, setRenaming] = useState<{ id: string; title: string } | null>(null);
    const [savingTitle, setSavingTitle] = useState(false);
    const [oldMessagesOpen, setOldMessagesOpen] = useState(false);
    const [showLatest, setShowLatest] = useState(false);
    const [streamVersion, setStreamVersion] = useState(0);
    const [action, setAction] = useState<TextInputDraft["action"]>(savedInput?.action);
    const [targetMessageId, setTargetMessageId] = useState(savedInput?.targetMessageId);
    const [settingsDirty, setSettingsDirty] = useState(Boolean(savedInput?.settingsDirty));
    const [recoveringSubmission, setRecoveringSubmission] = useState(savedInput?.submission?.id || "");
    const [files, setFiles] = useState<PendingFile[]>(() => (savedInput?.files || []).map((item) => item.file ? { file: item.file, url: URL.createObjectURL(item.file) } : item));
    const [sending, setSending] = useState(false);
    const [canceling, setCanceling] = useState(false);
    const [streamError, setStreamError] = useState("");
    const [submissionError, setSubmissionError] = useState("");
    const pending = useRef<TextInputDraft["submission"] | null>(savedInput?.submission || null);
    const scroll = useRef<HTMLDivElement>(null);
    const fileInput = useRef<HTMLInputElement>(null);
    const follow = useRef(true);
    const inputRevision = useRef(0);
    const previousSession = useRef(session);
    const restoredConversation = useRef(savedInput ? conversationId : "");
    const currentInput = useRef<TextInputDraft>({ prompt, modelId, systemPrompt, reasoningEffort, files, action, targetMessageId, settingsDirty });
    currentInput.current = { prompt, modelId, systemPrompt, reasoningEffort, files, action, targetMessageId, settingsDirty, submission: pending.current || undefined };
    const inputDraft = useTextDraft({ conversationId, value: currentInput.current, onRestore: (saved) => {
        restoredConversation.current = conversationId;
        pending.current = saved.submission || null;
        setRecoveringSubmission(saved.submission?.id || "");
        setPrompt(saved.prompt); setModelId(saved.modelId); setSystemPrompt(saved.systemPrompt); setReasoningEffort(saved.reasoningEffort);
        setFiles(saved.files); setAction(saved.action); setTargetMessageId(saved.targetMessageId);
        setSettingsDirty(Boolean(saved.settingsDirty));
    } });
    const markInputChanged = (settings = false) => { inputRevision.current++; pending.current = null; setRecoveringSubmission(""); inputDraft.markChanged(); if (settings) setSettingsDirty(true); };
    useEffect(() => () => {
        if (useUserStore.getState().sessionVersion !== session) return;
        if (currentInput.current.prompt || currentInput.current.files.length) saveWorkbenchDraft(draftKey, currentInput.current, session);
        else clearWorkbenchDraft(draftKey);
    }, [draftKey, session]);
    const models = usePublicModels();
    const available = useMemo(() => (models.data || []).filter((model) => model.capability === "text"), [models.data]);
    const model = available.find((item) => item.id === modelId);
    const unavailableModel = Boolean(modelId && !models.isPending && !models.isError && !model);
    const effort = resolveReasoningEffort(model, reasoningEffort);
    const wallet = useQuery({ queryKey: ["wallet", session], queryFn: getWallet });
    const searchKeyword = useDeferredValue(historyKeyword.trim());
    const conversations = useInfiniteQuery({ queryKey: ["text-conversations", session, searchKeyword, showArchived], queryFn: ({ pageParam, signal }) => listTextConversations(pageParam, searchKeyword, showArchived, signal), initialPageParam: 0, getNextPageParam: (last, pages) => last.length === 50 ? pages.length * 50 : undefined });
    const conversationItems = useMemo(() => conversations.data?.pages.flat() || [], [conversations.data]);
    const groups = useMemo(() => groupConversations(conversationItems), [conversationItems]);
    const conversation = useQuery({ queryKey: ["text-conversation", session, conversationId], queryFn: () => getTextConversation(conversationId), enabled: Boolean(conversationId) });
    const submissionRecovery = useQuery({ queryKey: ["text-submission", session, recoveringSubmission], queryFn: () => getTextRequest(recoveringSubmission), enabled: Boolean(inputDraft.ready && recoveringSubmission), retry: false });
    useEffect(() => {
        if (!inputDraft.ready || modelId || !available.length || conversationId) return;
        setModelId(available[0].id);
    }, [modelId, available, conversationId, inputDraft.ready]);
    const latest = conversation.data?.latestRequest;
    const active = Boolean(latest && activeStates.includes(latest.status));
    const activeMessages = useMemo(() => conversation.data?.messages.filter((item) => !item.supersededAt) || [], [conversation.data?.messages]);
    const oldMessages = useMemo(() => conversation.data?.messages.filter((item) => item.supersededAt) || [], [conversation.data?.messages]);
    const quotedPrompt = useDeferredValue(prompt);
    const parameters = effort === "auto" ? {} : { reasoningEffort: effort };
    const referenceMediaIds = [...new Set(files.flatMap((item) => item.reference?.storageKey ? [mediaId(item.reference.storageKey).toLowerCase()] : []))];
    const quote = useQuery({ queryKey: ["text-quote", session, model?.id, conversationId, activeMessages.at(-1)?.id, quotedPrompt, systemPrompt, effort, referenceMediaIds, action, targetMessageId], queryFn: async ({ signal }) => {
        assertCurrentSession(session);
        const result = await quoteGeneration({ modelId: model!.id, count: 1, content: quotedPrompt, conversationId: conversationId || undefined, systemPrompt, parameters, attachmentMediaIds: referenceMediaIds, action, targetMessageId }, signal);
        assertCurrentSession(session);
        return result;
    }, enabled: Boolean(!active && !recoveringSubmission && inputDraft.ready && model && (quotedPrompt.trim() || referenceMediaIds.length)), gcTime: 0 });
    const quoteReady = !quotedPrompt.trim() && !referenceMediaIds.length || Boolean(quote.data && !quote.isFetching && !quote.isError);
    const noModelsHint = isAdmin ? "暂无可用文本模型，请在管理后台检查模型与渠道配置。" : "暂无可用文本模型，请联系管理员开通。";
    const sendBlockedReason = !inputDraft.ready ? "正在恢复本机草稿，请稍候。" : recoveringSubmission ? submissionRecovery.isError ? "上次提交状态暂时无法核对，请重试核对后再发送。" : "正在核对上次提交，避免重复生成。" : sending ? "正在提交消息，请稍候。" : active ? latest?.canCancel ? "当前回复生成中，可取消后再发送。" : "已提交上游，无法取消；请等待当前回复完成后再发送。"
        : conversationId && conversation.isPending ? "正在读取对话，请稍候。" : conversationId && conversation.isError ? "对话读取失败，请刷新对话后再发送。"
        : models.isPending ? "正在加载可用模型，请稍候。" : models.isError ? "模型读取失败，请刷新模型列表后再发送。" : !available.length ? noModelsHint
        : !model ? "请选择可用的文本模型后再发送。" : files.length && !model.imageInput ? "当前模型不支持图片附件，请切换支持图片的模型或移除附件。"
        : files.length > maxAttachments ? `图片附件超过 ${maxAttachments} 张，请移除多余附件后再发送。` : !prompt.trim() && !files.length ? "输入消息或添加图片后即可发送。"
        : quote.isError ? "费用报价失败，请重试报价后再发送。" : quotedPrompt !== prompt || !quoteReady ? "正在获取费用报价，完成后即可发送。" : "";
    const canSend = !sendBlockedReason;
    const attachmentHint = model && !model.imageInput ? "当前模型仅支持文本；识图请切换支持图片的模型。" : files.length >= maxAttachments ? `图片附件已达 ${maxAttachments} 张上限；请先移除附件再添加。` : "";
    const retryMessage = latest?.conversationId === conversationId && (latest.status === "failed" || latest.status === "canceled") ? activeMessages.findLast((item) => item.role === "user") : undefined;
    const retryBlockedReason = !retryMessage ? "未找到本次请求的消息，请刷新对话后重试。"
        : (retryMessage.attachments?.length || 0) > maxAttachments ? `本次消息超过 ${maxAttachments} 张图片上限，无法完整恢复；请手动整理后发送。`
        : retryMessage.attachments?.some((item) => !item.mimeType?.startsWith("image/") || !item.id) ? "本次消息含不可恢复的附件，请刷新对话核对后重试。"
        : retryMessage.attachments?.length && !model?.imageInput ? "本次消息含图片，请先选择支持图片的模型再恢复输入。" : "";
    const recovery = useRef({ latest, retryMessage, retryBlockedReason, sending });
    recovery.current = { latest, retryMessage, retryBlockedReason, sending };

    const clearFiles = () => {
        setFiles((current) => {
            current.forEach((item) => { if (item.file) URL.revokeObjectURL(item.url); });
            return [];
        });
    };
    const addFiles = (picked: File[]) => {
        const images = picked.filter((file) => file.type.startsWith("image/"));
        if (images.length !== picked.length) message.warning("仅支持图片附件，其他文件未添加");
        if (!images.length) return;
        const remain = maxAttachments - files.length;
        if (images.length > remain) message.warning(`最多可添加 ${maxAttachments} 张图片，本次有 ${images.length - Math.max(0, remain)} 张未添加`);
        markInputChanged();
        setFiles((current) => {
            const remain = maxAttachments - current.length;
            if (remain <= 0) return current;
            const allowed = images.slice(0, remain);
            return [...current, ...allowed.map((file) => ({ file, url: URL.createObjectURL(file) }))];
        });
    };
    const removeFile = (index: number) => { markInputChanged(); setFiles((current) => {
        if (current[index].file) URL.revokeObjectURL(current[index].url);
        return current.filter((_, i) => i !== index);
    }); };
    const filesRef = useRef(files);
    filesRef.current = files;
    useEffect(() => () => filesRef.current.forEach((item) => { if (item.file) URL.revokeObjectURL(item.url); }), []);
    useEffect(() => {
        if (!recoveringSubmission || pending.current?.id !== recoveringSubmission) return;
        if (submissionRecovery.error instanceof ApiError && submissionRecovery.error.status === 404) { setRecoveringSubmission(""); return; }
        const request = submissionRecovery.data?.request;
        if (!request || request.id !== recoveringSubmission) return;
        void inputDraft.clear(recoveringSubmission);
        clearWorkbenchDraft(draftKey);
        pending.current = null;
        currentInput.current = { ...currentInput.current, prompt: "", files: [], action: undefined, targetMessageId: undefined, settingsDirty: false, submission: undefined };
        setPrompt(""); clearFiles(); setAction(undefined); setTargetMessageId(undefined); setSettingsDirty(false); setRecoveringSubmission("");
        setSearch({ conversation: request.conversationId }, { replace: true });
        void client.invalidateQueries({ queryKey: ["text-conversation", session, request.conversationId] });
        void client.invalidateQueries({ queryKey: ["text-conversations", session] });
    }, [recoveringSubmission, submissionRecovery.data, submissionRecovery.error]);

    useEffect(() => {
        if (previousSession.current === session) return;
        previousSession.current = session;
        pending.current = null;
        restoredConversation.current = "";
        setPrompt(""); setSystemPrompt(""); setReasoningEffort("auto"); setModelId(""); setAmbiguousDraftModel(false); setStreamError(""); setSending(false); setCanceling(false); setHistoryKeyword(""); clearFiles();
        setSearch({}, { replace: true });
    }, [session, setSearch]);

    useEffect(() => {
        const saved = conversation.data?.conversation;
        if (!inputDraft.ready || !saved || restoredConversation.current === saved.id) return;
        restoredConversation.current = saved.id;
        setModelId(saved.modelId || "");
        setAmbiguousDraftModel(false);
        setSystemPrompt(String(saved.parameters?.systemPrompt || ""));
        setReasoningEffort(modelReasoningEfforts.find((value) => value === saved.parameters?.reasoningEffort) || "auto");
    }, [conversation.data?.conversation, inputDraft.ready]);

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
                void client.invalidateQueries({ queryKey: ["text-conversation", session, conversationId] });
                void client.invalidateQueries({ queryKey: ["wallet", session] });
                void client.invalidateQueries({ queryKey: ["text-conversations", session] });
            }
        }, undefined, (error) => { if (useUserStore.getState().sessionVersion === session && error.name !== "AbortError") setStreamError(error.message); });
    }, [latest?.id, active, client, session, conversationId, streamVersion]);

    useEffect(() => { follow.current = true; }, [conversationId]);
    useEffect(() => { if (follow.current && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight; }, [conversation.data?.messages.length, latest?.partialText, conversationId]);
    const focusMessageId = search.get("message");
    useEffect(() => {
        if (!focusMessageId || !conversation.data) return;
        if (conversation.data.messages.some((item) => item.id === focusMessageId && item.supersededAt) && !oldMessagesOpen) { setOldMessagesOpen(true); return; }
        const frame = requestAnimationFrame(() => {
            const element = document.getElementById(`text-message-${focusMessageId}`);
            if (element) { follow.current = false; element.scrollIntoView({ block: "center" }); element.focus({ preventScroll: true }); setShowLatest(true); setSearch((current) => { const next = new URLSearchParams(current); next.delete("message"); return next; }, { replace: true }); }
        });
        return () => cancelAnimationFrame(frame);
    }, [focusMessageId, conversation.data?.conversation.id, conversation.data?.messages.length, oldMessagesOpen]);
    const refreshConversation = async () => {
        const result = await conversation.refetch();
        if (mounted.current && useUserStore.getState().sessionVersion === session && !result.isError) { setStreamError(""); setStreamVersion((value) => value + 1); }
    };
    const uploadFile = async (item: PendingFile, revision: number): Promise<string> => {
        const valid = () => mounted.current && useUserStore.getState().sessionVersion === session && inputRevision.current === revision;
        if (!valid()) throw new DOMException("输入已变更", "AbortError");
        if (item.reference?.storageKey) return ensurePlatformMedia(item.reference);
        setFiles((current) => current.map((file) => file.url === item.url ? { ...file, status: "uploading", error: "" } : file));
        try {
            const id = item.file ? (await uploadMedia(item.file, item.file.name)).id : await ensurePlatformMedia(item.reference);
            if (!valid()) throw new DOMException("输入已变更", "AbortError");
            const reference = { id, name: item.file?.name || item.reference?.name || "图片", type: item.file?.type || item.reference?.type || "image/png", dataUrl: "", storageKey: id, url: `/api/media/${id}` };
            setFiles((current) => current.map((file) => file.url === item.url ? { reference, url: reference.url, status: "ready" } : file));
            if (item.file) URL.revokeObjectURL(item.url);
            return id;
        } catch (error) {
            if (valid()) setFiles((current) => current.map((file) => file.url === item.url ? { ...file, status: "error", error: error instanceof Error ? error.message : "上传失败" } : file));
            throw error;
        }
    };

    const send = async () => {
        if (!canSend || !model) return;
        const version = useUserStore.getState().sessionVersion;
        const revision = inputRevision.current;
        const submittedInput = currentInput.current;
        const content = prompt.trim();
        const input = { modelId: model.id, conversationId: conversationId || undefined, content, title: (content || "图片对话").slice(0, 100), systemPrompt, parameters, action, targetMessageId };
        const fingerprint = JSON.stringify({ ...input, files: files.map((item) => item.file ? [item.file.name, item.file.size, item.file.lastModified] : item.reference) });
        if (!pending.current) pending.current = { fingerprint, id: crypto.randomUUID() };
        setSending(true);
        setSubmissionError("");
        try {
            const mediaIds: string[] = pending.current.mediaIds ? [...pending.current.mediaIds] : [];
            let uploadFailed = false;
            for (const item of pending.current.mediaIds ? [] : files) {
                try { mediaIds.push(await uploadFile(item, revision)); }
                catch (error) { if (error instanceof DOMException && error.name === "AbortError") throw error; uploadFailed = true; }
            }
            if (uploadFailed) throw new Error("部分图片上传失败，请在附件下重试；已上传的图片会继续保留。");
            assertCurrentSession(version);
            if (!mounted.current || inputRevision.current !== revision) return;
            pending.current.mediaIds = mediaIds;
            pending.current.fingerprint = JSON.stringify({ ...input, files: files.map((item, index) => item.reference?.storageKey ? item.reference : { id: mediaIds[index], name: item.file?.name || item.reference?.name || "图片", type: item.file?.type || item.reference?.type || "image/png", dataUrl: "", storageKey: mediaIds[index], url: `/api/media/${mediaIds[index]}` }) });
            const submission = { ...pending.current };
            const preparedFiles: PendingFile[] = files.map((item, index) => ({ url: `/api/media/${mediaIds[index]}`, reference: item.reference?.storageKey ? item.reference : { id: mediaIds[index], name: item.file?.name || item.reference?.name || "图片", type: item.file?.type || item.reference?.type || "image/png", dataUrl: "", storageKey: mediaIds[index], url: `/api/media/${mediaIds[index]}` } }));
            await inputDraft.persistPending({ ...submittedInput, files: preparedFiles, submission });
            assertCurrentSession(version);
            if (!mounted.current || inputRevision.current !== revision) return;
            const accepted = await queueTextRequest({ ...input, requestId: submission.id, attachmentMediaIds: mediaIds.length ? mediaIds : undefined });
            assertCurrentSession(version);
            void inputDraft.clear(submission.id);
            const saved = getWorkbenchDraft<TextInputDraft>(draftKey);
            if (saved?.submission?.id === submission.id || saved?.prompt === submittedInput.prompt && saved?.files === submittedInput.files && saved?.modelId === submittedInput.modelId) clearWorkbenchDraft(draftKey);
            if (!mounted.current) return;
            currentInput.current = { ...submittedInput, prompt: "", files: [], action: undefined, targetMessageId: undefined, settingsDirty: false, submission: undefined };
            clearWorkbenchDraft(draftKey);
            pending.current = null;
            const uploaded = mediaIds.length ? mediaIds.map((id, index) => ({ id, url: `/api/media/${id}`, originalName: files[index]?.file?.name || files[index]?.reference?.name || "图片" }) as MediaRecord) : undefined;
            const optimistic: TextMessage = { id: `local:${accepted.requestId}`, role: "user", content, createdAt: new Date().toISOString(), attachments: uploaded };
            if (!action) client.setQueryData<Conversation>(["text-conversation", version, accepted.conversationId], (current) => current ? { ...current, messages: [...current.messages, optimistic] } : { conversation: { id: accepted.conversationId, title: input.title, canvasProjectId: null, modelId: model.id, parameters: { systemPrompt, reasoningEffort: effort } }, messages: [optimistic], latestRequest: null });
            setPrompt(""); setAction(undefined); setTargetMessageId(undefined); setSettingsDirty(false); setStreamError(""); follow.current = true; clearFiles();
            setSearch({ conversation: accepted.conversationId }, { replace: true });
            await Promise.all([client.invalidateQueries({ queryKey: ["text-conversation", version, accepted.conversationId] }), client.invalidateQueries({ queryKey: ["text-conversations", version] }), client.invalidateQueries({ queryKey: ["wallet", version] })]);
        } catch (error) {
            if (mounted.current && useUserStore.getState().sessionVersion === version && error instanceof Error && error.name !== "AbortError") setSubmissionError(error.message);
        } finally {
            if (mounted.current && useUserStore.getState().sessionVersion === version) setSending(false);
        }
    };
    const cancel = async () => {
        if (!latest?.canCancel || canceling) return;
        const version = useUserStore.getState().sessionVersion;
        setCanceling(true);
        try {
            const result = await cancelGenerationTask(latest.id);
            assertCurrentSession(version);
            if (mounted.current) message.info(taskCancellationMessage(result));
            await Promise.all([conversation.refetch(), client.invalidateQueries({ queryKey: ["wallet", version] })]);
        } catch (error) {
            if (mounted.current && useUserStore.getState().sessionVersion === version && error instanceof Error && error.name !== "AbortError") message.error(error.message);
        } finally {
            if (useUserStore.getState().sessionVersion === version) setCanceling(false);
        }
    };
    const editFailedRequest = () => {
        const requestId = latest?.id;
        confirmReplace(Boolean(prompt || files.length), () => {
            const current = recovery.current;
            if (current.sending || current.latest?.id !== requestId || !["failed", "canceled"].includes(current.latest?.status || "")) return;
            if (current.retryBlockedReason || !current.retryMessage) { message.warning(current.retryBlockedReason); return; }
            markInputChanged();
            const restoredFiles: PendingFile[] = (current.retryMessage.attachments || []).map((item) => ({
                url: item.url || `/api/media/${item.id}`,
                reference: { id: item.id, name: item.originalName, type: item.mimeType, dataUrl: "", url: item.url, storageKey: item.id },
            }));
            clearFiles();
            setFiles(restoredFiles);
            setPrompt(current.retryMessage.content);
            setAction("edit"); setTargetMessageId(current.retryMessage.id);
            currentInput.current = { ...currentInput.current, prompt: current.retryMessage.content, files: restoredFiles };
            pending.current = null;
            setSubmissionError("");
            message.success("已恢复本次输入，可修改后发送");
        });
    };
    const prepareMessage = (item: TextMessage, nextAction: "edit" | "regenerate") => {
        if (sending || active || item.supersededAt) return;
        const original = nextAction === "edit" ? item : activeMessages.find((entry) => entry.id === item.requestMessageId);
        if (!original || original.role !== "user") { message.warning("未找到原始问题，请刷新对话后重试"); return; }
        if (original.attachments?.length && !model?.imageInput) { message.info("原问题包含图片，请先选择支持图片的模型"); return; }
        confirmReplace(Boolean(prompt || files.length), () => {
            markInputChanged(); clearFiles(); pending.current = null; setSubmissionError("");
            setPrompt(original.content); setAction(nextAction); setTargetMessageId(item.id);
            setFiles((original.attachments || []).map((entry) => ({ url: entry.url || `/api/media/${entry.id}`, reference: { id: entry.id, name: entry.originalName, type: entry.mimeType, dataUrl: "", url: entry.url, storageKey: entry.id } })));
        });
    };
    const continueMessage = (item: TextMessage) => {
        if (active || sending) return;
        if (activeMessages.at(-1)?.id !== item.id) { message.info("请在最新回复后继续写；较早的回复可复制后补充要求"); return; }
        confirmReplace(Boolean(prompt || files.length), () => {
            markInputChanged(); clearFiles(); setAction(undefined); setTargetMessageId(undefined);
            setPrompt("请从上一条回复中断的位置继续，不要重复已有内容。");
        });
    };
    const messageActions = useRef({ edit: (item: TextMessage) => prepareMessage(item, "edit"), regenerate: (item: TextMessage) => prepareMessage(item, "regenerate"), continue: continueMessage });
    messageActions.current = { edit: (item) => prepareMessage(item, "edit"), regenerate: (item) => prepareMessage(item, "regenerate"), continue: continueMessage };
    const editMessage = useCallback((item: TextMessage) => messageActions.current.edit(item), []);
    const regenerateMessage = useCallback((item: TextMessage) => messageActions.current.regenerate(item), []);
    const continueReply = useCallback((item: TextMessage) => messageActions.current.continue(item), []);
    const resetConversation = (id: string) => { markInputChanged(); void inputDraft.clear(); clearWorkbenchDraft(draftKey); currentInput.current = { ...currentInput.current, prompt: "", files: [], action: undefined, targetMessageId: undefined, settingsDirty: false, submission: undefined }; setAction(undefined); setTargetMessageId(undefined); setSettingsDirty(false); setSearch(id ? { conversation: id } : {}); setStreamError(""); setSubmissionError(""); setPrompt(""); setAmbiguousDraftModel(false); setHistoryOpen(false); if (!id) { setModelId(available[0]?.id || ""); setSystemPrompt(""); setReasoningEffort("auto"); } restoredConversation.current = ""; pending.current = null; clearFiles(); };
    const selectConversation = (id: string) => {
        if (id === conversationId && id) return;
        if (id !== conversationId) { setSearch(id ? { conversation: id } : {}); setHistoryOpen(false); return; }
        confirmReplace(Boolean(prompt || files.length), () => resetConversation(id));
    };
    const changeModel = (id: string) => {
        const next = available.find((item) => item.id === id);
        if (files.length && next && !next.imageInput) { message.info("该模型不支持图片输入，请先移除附件后再切换"); return; }
        confirmReplace(false, () => {
            markInputChanged(true);
            if (files.length && next && !next.imageInput) clearFiles();
            setModelId(id);
            setAmbiguousDraftModel(false);
        });
    };
    useEffect(() => {
        if (!inputDraft.ready || !draft || draft.capability !== "text" || draft.sessionVersion !== session || models.isPending || models.isError || sending || appliedDraftRef.current === draft.id) return;
        if (conversationId) { setSearch({}); return; }
        appliedDraftRef.current = draft.id;
        confirmReplace(Boolean(prompt || files.length), () => {
            if (useCreationDraftStore.getState().draft?.id !== draft.id) return;
            resetConversation("");
            const resolved = resolveCreationDraftModel(available, draft);
            const selected = draft.modelId || draft.modelName ? resolved.model : available[0];
            setAmbiguousDraftModel(resolved.ambiguous);
            setModelId(selected?.id || draft.modelId || draft.modelName || "");
            setPrompt(draft.prompt);
            if ((draft.modelId || draft.modelName) && !selected) message.warning(resolved.ambiguous ? `草稿名称「${draft.modelName}」对应多个模型配置，请明确选择` : `草稿指定的模型「${draft.modelName || draft.modelId}」当前不可用，请重新选择`);
            const references = draft.references || [];
            if (references.length) {
                if (!selected?.imageInput) message.warning("当前文本模型不支持图片输入，未带入草稿附件");
                else {
                    const images = references.filter((item) => item.type.startsWith("image"));
                    setFiles(images.slice(0, maxAttachments).map((reference) => ({ reference, url: reference.dataUrl || reference.url || `/api/media/${mediaId(reference.storageKey || "")}` })));
                    if (images.length !== references.length) message.warning("文本对话只支持图片附件，其他素材未带入");
                    if (images.length > maxAttachments) message.warning(`草稿图片超过当前上限，仅带入前 ${maxAttachments} 张`);
                }
            }
            clearDraft(draft.id);
        }, () => clearDraft(draft.id));
    }, [draft, session, models.isPending, models.isError, sending, available, clearDraft, message, selectConversation, inputDraft.ready]);
    const updateConversation = async (id: string, changes: Parameters<typeof updateTextConversation>[1]) => {
        const version = useUserStore.getState().sessionVersion;
        await updateTextConversation(id, changes);
        assertCurrentSession(version);
        await Promise.all([client.invalidateQueries({ queryKey: ["text-conversations", version] }), client.invalidateQueries({ queryKey: ["text-conversation", version, id] })]);
    };
    const changeConversation = (item: ConversationItem, key: string) => {
        if (key === "rename") { setRenaming({ id: item.id, title: item.title }); return; }
        if (key === "delete") { removeConversation(item); return; }
        void updateConversation(item.id, key === "pin" ? { pinned: !item.pinned } : { archived: !item.archivedAt }).catch((error: Error) => { if (mounted.current && useUserStore.getState().sessionVersion === session && error.name !== "AbortError") message.error(error.message); });
    };
    const exportConversation = () => {
        if (!conversation.data) return;
        const title = conversation.data.conversation.title;
        const format = (items: TextMessage[]) => items.map((item) => `## ${item.role === "user" ? "我" : "助手"}\n\n${item.content}${item.attachments?.length ? `\n\n附件：${item.attachments.map((file) => file.originalName).join("、")}（图片不包含在此文本导出中）` : ""}`).join("\n\n---\n\n");
        saveAs(new Blob([`# ${title}\n\n${format(activeMessages)}${oldMessages.length ? `\n\n# 历史记录（不参与后续上下文）\n\n${format(oldMessages)}` : ""}`], { type: "text/markdown;charset=utf-8" }), `${title.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_") || "对话"}.md`);
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
                if (item.id === conversationId) resetConversation("");
                await client.invalidateQueries({ queryKey: ["text-conversations", version] });
            },
        });
    };
    const pickFiles = (event: ChangeEvent<HTMLInputElement>) => {
        if (sending || active || action === "regenerate" || !inputDraft.ready) { event.target.value = ""; return; }
        if (!model?.imageInput) { message.info("当前模型不支持图片输入"); event.target.value = ""; return; }
        addFiles(Array.from(event.target.files || []));
        event.target.value = "";
    };
    const pasteFiles = (event: ClipboardEvent<HTMLTextAreaElement>) => {
        if (sending || active || action === "regenerate" || !inputDraft.ready) return;
        const pasted = Array.from(event.clipboardData?.files || []).filter((file) => file.type.startsWith("image/"));
        if (!pasted.length) return;
        if (!model?.imageInput) { message.info("当前模型不支持图片输入"); return; }
        event.preventDefault();
        addFiles(pasted);
    };

    const sidebarBody = <>
        <div className="flex items-center justify-between px-2 pb-1 pt-1">
            <span className="px-2 text-sm font-semibold">{showArchived ? "已归档对话" : "文本对话"}</span>
            <Tooltip title={showArchived ? "返回最近对话" : "查看已归档"}><Button type="text" size="small" aria-label={showArchived ? "返回最近对话" : "查看已归档"} icon={showArchived ? <RotateCcw className="size-4" /> : <Archive className="size-4" />} onClick={() => setShowArchived((value) => !value)} /></Tooltip>
            <Button type="text" aria-label="新建对话" title="新建对话" icon={<SquarePen className="size-4" />} disabled={sending} onClick={() => selectConversation("")} />
        </div>
        <div className="px-2 pb-2 pt-1">
            <Input allowClear size="small" variant="filled" prefix={<Search className="size-3.5 text-muted-foreground" />} suffix={conversations.isFetching ? <Spin size="small" /> : null} placeholder="搜索标题和消息" value={historyKeyword} onChange={(event) => setHistoryKeyword(event.target.value)} />
        </div>
        <div className="thin-scrollbar min-h-0 flex-1 overflow-y-auto px-2 pb-2">
            {conversations.error ? <Alert type="error" title={conversations.error.message} /> : conversations.isPending ? <Spin className="!block py-6" /> : !conversationItems.length ? <p className="px-3 py-6 text-xs text-muted-foreground">{historyKeyword.trim() ? "没有匹配的对话" : showArchived ? "暂无归档对话" : "暂无对话"}</p> : groups.map((group) => (
                <div key={group.label} className="pb-2">
                    <p className="px-3 pb-1 pt-3 text-xs text-muted-foreground">{group.label}</p>
                    {group.items.map((item) => (
                        <div key={item.id} className={cn("group relative rounded-lg transition", item.id === conversationId ? "bg-muted" : "hover:bg-muted/70")}>
                            <button type="button" disabled={sending} onClick={() => { if (item.matchedMessageId) { setSearch({ conversation: item.id, message: item.matchedMessageId }); setHistoryOpen(false); } else selectConversation(item.id); }} className={cn("w-full rounded-lg px-3 py-2 pr-8 text-left text-sm leading-6", item.id === conversationId ? "font-medium text-foreground" : "text-muted-foreground hover:text-foreground")}><span className="block truncate">{item.pinned ? <Pin className="mr-1 inline size-3" /> : null}{item.title}</span>{searchKeyword && item.excerpt ? <span className="mt-0.5 line-clamp-2 text-xs font-normal text-muted-foreground">{item.excerpt}</span> : null}</button>
                            <Dropdown trigger={["click"]} menu={{ items: [{ key: "rename", label: "重命名", icon: <SquarePen className="size-3.5" /> }, { key: "pin", label: item.pinned ? "取消置顶" : "置顶", icon: <Pin className="size-3.5" /> }, { key: "archive", label: item.archivedAt ? "取消归档" : "归档", icon: <Archive className="size-3.5" /> }, { type: "divider" }, { key: "delete", label: "删除", danger: true, icon: <Trash2 className="size-3.5" /> }], onClick: ({ key, domEvent }) => { domEvent.stopPropagation(); changeConversation(item, key); } }}>
                                <button type="button" aria-label="更多操作" title="更多操作" className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded-md p-1 text-muted-foreground transition hover:bg-background hover:text-foreground [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover:opacity-100 focus-visible:opacity-100"><Ellipsis className="size-4" /></button>
                            </Dropdown>
                        </div>
                    ))}
                </div>
            ))}
            {conversations.hasNextPage ? <Button type="text" size="small" block loading={conversations.isFetchingNextPage} onClick={() => void conversations.fetchNextPage()}>加载更多</Button> : null}
        </div>
    </>;

    return <div className="@container/text-workbench flex h-full min-h-0 min-w-0">
        <aside className="hidden w-64 shrink-0 flex-col border-r border-border bg-muted/40 px-2 py-4 @min-[1024px]/text-workbench:flex">{sidebarBody}</aside>
        <Drawer placement="left" size="min(300px, 100vw)" open={historyOpen} onClose={() => setHistoryOpen(false)} styles={{ body: { display: "flex", flexDirection: "column", padding: "16px 8px" } }} closable={false}>{sidebarBody}</Drawer>
        <section className="@container/conversation flex min-h-0 min-w-0 flex-1 flex-col">
            <header className="flex min-h-14 shrink-0 flex-wrap items-center justify-between gap-x-3 gap-y-1 px-4 py-2 @min-[640px]/conversation:px-6">
                <div className="flex min-w-0 items-center gap-1">
                    <Button type="text" className="@min-[1024px]/text-workbench:!hidden" aria-label="历史对话" title="历史对话" icon={<PanelLeft className="size-4" />} onClick={() => setHistoryOpen(true)} />
                    <h2 className="min-w-0 truncate text-sm font-medium">{conversation.data?.conversation.title || "新对话"}</h2>
                    {conversation.data?.conversation.archivedAt ? <span className="shrink-0 text-xs text-muted-foreground">已归档</span> : null}
                </div>
                <div className="flex shrink-0 items-center gap-1 @min-[640px]/conversation:gap-2">
                    <Link to="/user/wallet" className="mr-2 text-xs text-muted-foreground hover:text-foreground">余额 ¥{wallet.data?.wallet.balance ?? "—"}</Link>
                    {conversation.data ? <Button type="text" aria-label="导出对话 Markdown" title="导出 Markdown" icon={<Download className="size-4" />} onClick={exportConversation} /> : null}
                    <Button type="text" aria-label="对话设置" icon={<Settings2 className="size-4" />} onClick={() => setSettingsOpen(true)} />
                    <Button type="text" className="@min-[1024px]/text-workbench:!hidden" aria-label="新建对话" icon={<Plus className="size-4" />} disabled={sending} onClick={() => selectConversation("")} />
                </div>
            </header>
            <div ref={scroll} className="thin-scrollbar min-h-0 flex-1 overflow-y-auto" onScroll={(event) => { const el = event.currentTarget; follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40; setShowLatest(!follow.current); }}>
                <div className="mx-auto min-w-0 max-w-3xl space-y-6 break-words px-4 py-6 @min-[640px]/conversation:px-6">
                    {models.error || conversation.error ? <Alert type="error" title={models.error ? "模型列表读取失败，请重试。" : "对话读取失败，请重试。"} description={<details><summary className="cursor-pointer">查看错误详情</summary><p className="mt-2 whitespace-pre-wrap break-words">{models.error?.message || conversation.error?.message}</p></details>} action={<Button size="small" onClick={() => void (models.error ? models.refetch() : conversation.refetch())}>{models.error ? "刷新模型列表" : "刷新对话"}</Button>} /> : null}
                    {unavailableModel ? <Alert type="warning" showIcon title={ambiguousDraftModel ? "草稿名称对应多个模型配置，请明确选择后继续发送" : "已选模型已下线或暂无可用渠道，请明确选择其它模型后继续发送"} /> : null}
                    {conversationId && conversation.isPending ? <Spin className="!block py-10" /> : null}
                    {!conversationId ? <div className="flex min-h-[50vh] flex-col items-center justify-center text-center">
                        <h2 className="text-2xl font-semibold tracking-tight @min-[640px]/conversation:text-3xl">有什么可以帮忙的？</h2>
                        <p className="mt-3 max-w-md text-sm leading-7 text-muted-foreground">输入问题开始对话，对话自动保存；支持图片输入的模型可以直接识图问答。</p>
                        <div className="mt-7 grid w-full gap-2 text-left @min-[640px]/conversation:grid-cols-3">
                            {textExamples.map((item) => <button key={item.id} type="button" disabled={sending} onClick={() => setDraft(item.example)} className="rounded-xl border border-border px-4 py-3 transition-colors hover:bg-muted/60 disabled:opacity-50"><span className="text-sm font-medium">{item.title}</span><span className="mt-1 block line-clamp-2 text-xs leading-6 text-muted-foreground">{item.example.prompt}</span></button>)}
                        </div>
                        {!models.isPending && !models.isError && !available.length ? <Empty className="mt-8" description={noModelsHint} /> : null}
                    </div> : null}
                    {oldMessages.length ? <details open={oldMessagesOpen} onToggle={(event) => setOldMessagesOpen(event.currentTarget.open)} className="rounded-xl border border-border px-4 py-3"><summary className="cursor-pointer text-xs text-muted-foreground">历史记录 · {oldMessages.length} 条（不参与后续上下文）</summary>{oldMessagesOpen ? <div className="mt-5 space-y-6">{oldMessages.map((item) => <TextMessageRow key={item.id} item={item} disabled onEdit={editMessage} onRegenerate={regenerateMessage} onContinue={continueReply} />)}</div> : null}</details> : null}
                    {activeMessages.map((item) => <TextMessageRow key={item.id} item={item} disabled={sending || active} canContinue={item.id === activeMessages.at(-1)?.id} onEdit={editMessage} onRegenerate={regenerateMessage} onContinue={continueReply} />)}
                    {latest?.partialText && !latest.responseMessageId ? <div><Streamdown className="agent-streamdown" isAnimating={active}>{latest.partialText}</Streamdown></div> : null}
                    {active ? <div className="flex items-center gap-2 text-sm text-muted-foreground"><Spin size="small" />{latest?.status === "reviewing" ? "等待内容审核，可取消并退回冻结金额" : latest?.canCancel ? "正在等待提交，可取消并全退" : "已提交上游，继续生成并正常结算"}</div> : latest?.status === "failed" || latest?.status === "canceled" ? <Alert type="warning" showIcon title={latest.status === "failed" ? "本次回复未完成" : "本次生成已取消"} description={<div className="space-y-2">
                        <p>可将本次消息与图片恢复到输入区，检查内容或模型后再次发送。</p>
                        <p className="text-xs">{latest.billed != null && latest.billed !== "" ? `本次实付 ¥${latest.billed}，结算以钱包账单为准。` : "结算金额尚未返回，请到钱包核对账单。"}</p>
                        {latest.errorMessage || latest.errorCode ? <details><summary className="cursor-pointer text-xs">查看错误详情</summary><p className="mt-2 whitespace-pre-wrap break-words text-xs">{latest.errorMessage || latest.errorCode}</p></details> : null}
                        <div className="flex flex-wrap items-center gap-2"><Button size="small" icon={<SquarePen className="size-3.5" />} disabled={sending || Boolean(retryBlockedReason)} onClick={editFailedRequest}>编辑后重发</Button>{retryBlockedReason ? <span className="text-xs">{retryBlockedReason}</span> : null}</div>
                    </div>} /> : latest?.status === "succeeded" ? <p className="text-xs text-muted-foreground">{latest.billed != null && latest.billed !== "" ? `本次实付 ¥${latest.billed}` : "生成已完成，请到钱包查看结算账单。"}</p> : null}
                    {streamError ? <Alert type="warning" title="连接已中断，请刷新对话查看最新结果。" description={<details><summary className="cursor-pointer">查看错误详情</summary><p className="mt-2 whitespace-pre-wrap break-words">{streamError}</p></details>} action={<Button size="small" onClick={() => void refreshConversation()}>刷新对话</Button>} /> : null}
                </div>
            </div>
            <footer className="thin-scrollbar max-h-[60%] shrink-0 overflow-y-auto px-4 pb-[max(1.25rem,env(safe-area-inset-bottom))] pt-3 @min-[640px]/conversation:px-6">
                <div className="mx-auto max-w-3xl">
                    {showLatest ? <div className="mb-2 text-center"><Button type="text" size="small" icon={<ArrowDown className="size-3.5" />} onClick={() => { follow.current = true; if (scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight; setShowLatest(false); }}>{active ? "查看最新生成" : "回到最新回复"}</Button></div> : null}
                    {action ? <div className="mb-2 flex items-start gap-2 px-1 text-xs leading-5 text-muted-foreground"><SquarePen className="mt-0.5 size-3.5 shrink-0" /><p className="flex-1">{action === "regenerate" ? "重新生成原问题的回答" : "修改历史问题"}：发送后原内容及后续消息收进只读历史，费用按本次选择的模型计算。</p><Button type="text" size="small" disabled={sending} aria-label="取消修改" onClick={() => { markInputChanged(); setAction(undefined); setTargetMessageId(undefined); setPrompt(""); clearFiles(); }} icon={<X className="size-3.5" />} /></div> : null}
                    <div className="rounded-3xl border border-border bg-background p-3 transition-colors focus-within:border-muted-foreground/40">
                        {files.length ? <div className="flex flex-wrap gap-2 px-1 pb-2">
                            {files.map((item, index) => <div key={`${item.url}:${index}`} className="relative w-20">
                                <img src={item.url} alt={item.file?.name || item.reference?.name || "图片"} className="size-14 rounded-xl border border-border object-cover" />
                                <button type="button" disabled={sending || action === "regenerate"} aria-label={`移除 ${item.file?.name || item.reference?.name || "图片"}`} onClick={() => removeFile(index)} className="absolute right-4 top-0 flex size-5 items-center justify-center rounded-full border border-border bg-background text-muted-foreground transition hover:text-foreground disabled:opacity-40"><X className="size-3" /></button>
                                <p className="mt-1 truncate text-[11px] text-muted-foreground" title={item.file?.name || item.reference?.name}>{item.file?.name || item.reference?.name || "图片"}</p>
                                {item.status === "uploading" ? <span className="text-[11px] text-muted-foreground">上传中…</span> : item.status === "error" ? <Tooltip title={item.error}><Button type="link" size="small" className="!h-auto !p-0 !text-xs" disabled={sending} onClick={() => { setSending(true); void uploadFile(item, inputRevision.current).catch(() => undefined).finally(() => { if (mounted.current && useUserStore.getState().sessionVersion === session) setSending(false); }); }}>上传失败，重试</Button></Tooltip> : <span className="text-[11px] text-muted-foreground">{item.reference?.storageKey ? "已就绪" : "发送时上传"}</span>}
                            </div>)}
                        </div> : null}
                        <Input.TextArea aria-label="消息内容" variant="borderless" className="!px-1 !pt-0 !text-[15px] !leading-7" autoSize={{ minRows: 1, maxRows: 8 }} maxLength={100000} value={prompt} disabled={sending} readOnly={action === "regenerate"} onChange={(event) => { markInputChanged(); setPrompt(event.target.value); }} placeholder="有什么问题，尽管问" onPaste={pasteFiles} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send(); } }} />
                        <div className="mt-1 flex flex-wrap items-center justify-end gap-2">
                            <input ref={fileInput} type="file" className="hidden" multiple accept="image/*" onChange={pickFiles} />
                            <Tooltip title={model?.imageInput ? "添加图片" : "当前模型不支持图片输入"}>
                                <span className="mr-auto inline-flex"><Button type="text" aria-label="添加图片" icon={<Paperclip className="size-4" />} disabled={!model?.imageInput || sending || active || action === "regenerate" || files.length >= maxAttachments} onClick={() => fileInput.current?.click()} /></span>
                            </Tooltip>
                            <Select aria-label="选择文本模型" title="选择模型" variant="borderless" className="min-w-36 max-w-full flex-1 @min-[640px]/conversation:max-w-80" prefix={<Circle className="size-3.5 text-muted-foreground" />} suffixIcon={<ChevronDown className="size-3" />} value={modelId || undefined} labelRender={(option) => unavailableModel ? ambiguousDraftModel ? "请明确选择模型" : "已选模型不可用" : option.label} onChange={changeModel} disabled={!inputDraft.ready || sending || active} loading={models.isPending} placeholder="选择模型" showSearch={{ filterOption: (input, option) => `${option?.label || ""} ${option?.name || ""} ${option?.description || ""}`.toLowerCase().includes(input.toLowerCase()) }} placement="topRight" popupMatchSelectWidth={false} styles={{ popup: { root: { maxWidth: "calc(100vw - 32px)" } } }} options={available.map((item) => ({ value: item.id, label: item.displayName, name: item.name, description: item.description, price: modelPriceLabel(item), image: Boolean(item.imageInput) }))} optionRender={(option) => <div className="max-w-80 py-1"><div className="flex items-center gap-2 font-medium">{option.data.label}{option.data.image ? <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] leading-none text-muted-foreground">图片</span> : null}</div><div className="mt-1 whitespace-normal text-xs text-muted-foreground">价格：{option.data.price}</div>{option.data.description ? <p className="mt-1 whitespace-normal text-xs leading-5 text-muted-foreground">适用说明：{option.data.description}</p> : null}</div>} />
                            <div className="flex shrink-0 items-center gap-2">
                                <Select<ReasoningEffort> aria-label="思考强度" title="思考强度" variant="borderless" className="!w-24 shrink-0" prefix={<Brain className="size-4" />} suffixIcon={<ChevronDown className="size-3" />} value={effort} onChange={(value) => { markInputChanged(true); setReasoningEffort(value); }} disabled={!inputDraft.ready || !model?.reasoningEfforts?.length || sending || active} placement="topRight" options={modelReasoningOptions(model)} />
                                {active ? <Button type="text" className="!size-8 !min-w-8 !rounded-full" aria-label="取消生成" title={latest?.canCancel ? "取消生成并全退" : "已提交上游，无法取消"} disabled={!latest?.canCancel} icon={<Square className="size-3.5" />} loading={canceling} onClick={() => void cancel()} /> : <Button type="primary" className="!size-8 !min-w-8 !rounded-full" aria-label="发送消息" aria-describedby={sendBlockedReason ? "text-send-status" : undefined} title={sendBlockedReason || "发送消息"} icon={<ArrowUp className="size-4" />} loading={sending} disabled={!canSend} onClick={() => void send()} />}
                            </div>
                        </div>
                    </div>
                    {sendBlockedReason ? <p id="text-send-status" role="status" className="mt-2 px-1 text-xs leading-5 text-muted-foreground">{sendBlockedReason}</p> : null}
                    {recoveringSubmission && submissionRecovery.isError ? <Button type="link" size="small" onClick={() => void submissionRecovery.refetch()}>重新核对上次提交</Button> : null}
                    <p className="mt-1 px-1 text-xs leading-5 text-muted-foreground">{inputDraft.error || "草稿保存在本机，刷新后可恢复；已发送消息保存到账号。"}</p>
                    {quote.data?.context ? <div className="mt-1 px-1 text-xs leading-5 text-muted-foreground"><Tooltip title={quote.data.context.estimateNote}><span>本轮上下文 {quote.data.context.messageCount} 条消息{quote.data.context.imageCount ? ` · ${quote.data.context.imageCount} 张图片` : ""}{quote.data.context.estimatedTokens != null ? ` · 约 ${quote.data.context.estimatedTokens.toLocaleString()} token` : ""}{quote.data.context.contextWindow ? ` / 容量 ${quote.data.context.contextWindow.toLocaleString()}` : ""}</span></Tooltip>{quote.data.context.warning ? <p role="status" className="mt-1">{quote.data.context.warning}</p> : null}</div> : conversationId && activeMessages.length ? <p className="mt-1 px-1 text-xs leading-5 text-muted-foreground">当前对话 {activeMessages.length} 条有效消息，仅沿用本对话历史。</p> : null}
                    {attachmentHint ? <p className="mt-1 px-1 text-xs leading-5 text-muted-foreground">{attachmentHint}</p> : null}
                    {submissionError ? <Alert className="mt-2" type="warning" showIcon title="消息提交未完成，输入已保留。" description={<div><p>请展开详情处理问题后再次发送；若网络中断，可先刷新对话核对是否已提交。</p><details className="mt-2"><summary className="cursor-pointer">查看错误详情</summary><p className="mt-2 whitespace-pre-wrap break-words">{submissionError}</p></details></div>} /> : null}
                    <p className="mt-3 text-center text-xs leading-5 text-muted-foreground">{quote.data && prompt.trim() && quotedPrompt === prompt && !quote.isFetching ? `预计冻结 ¥${quote.data.quote.estimatedHold}${files.some((item) => !item.reference?.storageKey) ? "（提交时另计新附图片预算）" : ""}，实际费用多退少补，欠费后需结清再生成。` : "内容由 AI 生成，请核实重要信息。"} Enter 发送 · Shift + Enter 换行</p>
                    {quote.error ? <div className="mt-1 flex items-start justify-center gap-2 text-xs text-destructive"><details><summary className="cursor-pointer">查看报价错误详情</summary><p className="mt-1 whitespace-pre-wrap break-words">{quote.error.message}</p></details><Button type="link" size="small" className="!h-auto !p-0 !text-xs" onClick={() => void quote.refetch()}>重试报价</Button></div> : null}
                </div>
            </footer>
        </section>
        <Drawer title="对话设置" open={settingsOpen} onClose={() => setSettingsOpen(false)}><label htmlFor="text-system-prompt" className="mb-3 block text-sm font-medium">系统提示词</label><Input.TextArea id="text-system-prompt" rows={8} value={systemPrompt} maxLength={100000} disabled={!inputDraft.ready || sending || active} onChange={(event) => { markInputChanged(true); setSystemPrompt(event.target.value); }} placeholder="例如：用简洁的中文回答，并在必要时给出例子。" /><p className="mt-3 text-xs leading-6 text-muted-foreground">填写后用于后续请求，不会改写已有消息。</p></Drawer>
        <Modal title="重命名对话" open={Boolean(renaming)} confirmLoading={savingTitle} okText="保存" cancelText="取消" okButtonProps={{ disabled: !renaming?.title.trim() }} onCancel={() => { if (!savingTitle) setRenaming(null); }} onOk={async () => {
            if (!renaming?.title.trim()) return;
            setSavingTitle(true);
            try { await updateConversation(renaming.id, { title: renaming.title.trim() }); if (mounted.current && useUserStore.getState().sessionVersion === session) setRenaming(null); }
            catch (error) { if (mounted.current && useUserStore.getState().sessionVersion === session && error instanceof Error && error.name !== "AbortError") message.error(error.message); }
            finally { if (mounted.current) setSavingTitle(false); }
        }}><Input aria-label="对话名称" maxLength={200} value={renaming?.title || ""} disabled={savingTitle} onChange={(event) => setRenaming((current) => current ? { ...current, title: event.target.value } : current)} /></Modal>
    </div>;
}

function groupConversations(items: ConversationItem[]) {
    const groups: { label: string; items: ConversationItem[] }[] = [];
    for (const item of items) {
        const days = dayjs().startOf("day").diff(dayjs(item.updatedAt).startOf("day"), "day");
        const label = item.pinned ? "置顶" : days <= 0 ? "今天" : days === 1 ? "昨天" : days <= 7 ? "前 7 天" : days <= 30 ? "前 30 天" : "更早";
        const last = groups.at(-1);
        if (last?.label === label) last.items.push(item);
        else groups.push({ label, items: [item] });
    }
    return groups;
}

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { App, Button, Tooltip } from "antd";
import dayjs from "dayjs";
import { Bot, History, MessageSquare, PanelRightClose, PlugZap, Plus, Sparkles, Terminal } from "lucide-react";
import { useTranslation } from "react-i18next";

import i18n from "@/i18n";
import { AGENT_REASONING_EFFORTS, createId, createMessageAttachmentMetadata, MAX_ATTACHMENTS, MAX_ATTACHMENT_PAYLOAD_BYTES, readDataUrl, rt, type AgentModelsResponse, type AgentTurnResponse } from "@/lib/agent/agent-panel-utils";
import { canvasThemes } from "@/lib/canvas-theme";
import { resolveCanvasReferenceImages } from "@/lib/canvas/canvas-resource-references";
import { readImageMeta } from "@/lib/image-utils";
import { AgentApiError, fetchAgentJson, interruptCodexTurn } from "@/services/api/canvas-agent";
import { useThemeStore } from "@/stores/use-theme-store";
import { assertCurrentSession, useUserStore } from "@/stores/use-user-store";
import { useAgentSkillStore } from "@/stores/use-agent-skill-store";
import { useShallow } from "zustand/react/shallow";
import { agentSettingKey, useAgentStore, type AgentAttachment, type AgentCanvasContext, type AgentCanvasReference, type AgentChatItem, type AgentConversationState, type AgentPendingToolCall, type AgentPermissionMode, type AgentReasoningEffort } from "@/stores/use-agent-store";
import { AgentChatTimeline, AgentTaskProgress, AgentUsageBar } from "./agent-chat";
import { AgentChatComposer } from "./agent-chat-composer";
import { AgentConnectView } from "./agent-connect-view";
import {
    agentAttachmentToChatAttachment,
    attachmentPayloadBytes,
    compactText,
    formatBytes,
    normalizeText,
    promptWithAttachments,
    promptWithCanvasReferences,
    scopeChatItem,
    upsertAgentMessage,
} from "./agent-event-formatters";
import { AgentHistoryView } from "./agent-history-view";
import { AgentLogView } from "./agent-log-view";
import { AgentPanelTabs } from "./agent-panel-tabs";
import { AgentSkillsView } from "./agent-skills-view";
import { useAgentApprovals } from "./hooks/use-agent-approvals";
import { useAgentConnection } from "./hooks/use-agent-connection";
import { useAgentEvents } from "./hooks/use-agent-events";
import { useAgentHistory } from "./hooks/use-agent-history";

export function LocalAgentPanel({ embedded, headless, autoConnect }: { embedded?: boolean; headless?: boolean; autoConnect?: boolean }) {
    const { t } = useTranslation();
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const { message, modal } = App.useApp();
    const { hash } = useLocation();
    const [searchParams] = useSearchParams();
    const navigate = useNavigate();
    const userId = useUserStore((state) => state.user?.id || "");
    const sessionVersion = useUserStore((state) => state.sessionVersion);
    // Field-level selectors with useShallow rerender only when these fields change.
    // canvasContext is intentionally excluded because project updates it every frame during dragging and resizing.
    // The panel uses it only for ref synchronization and debounced postState calls, never during rendering.
    // Subscribing here would rerender the panel every frame and amplify the #185 crash, so it is observed imperatively below.
    const { url, token, connected, enabled, prompt, attachments, sending, waiting, tokenUsage, eventLogs, threads, activeThreadId, workspacePath, loadingThreads, activeTab, confirmTools, permissionMode, models, model, reasoningEffort, activity, conversation, connectError, pendingTool, pendingApprovals } = useAgentStore(
        useShallow((state) => ({
            width: state.width,
            url: state.url,
            token: state.token,
            connected: state.connected,
            enabled: state.enabled,
            prompt: state.prompt,
            attachments: state.attachments,
            sending: state.sending,
            waiting: state.waiting,
            tokenUsage: state.tokenUsage,
            eventLogs: state.eventLogs,
            threads: state.threads,
            activeThreadId: state.activeThreadId,
            workspacePath: state.workspacePath,
            loadingThreads: state.loadingThreads,
            activeTab: state.activeTab,
            confirmTools: state.confirmTools,
            permissionMode: state.permissionMode,
            models: state.models,
            model: state.model,
            reasoningEffort: state.reasoningEffort,
            activity: state.activity,
            conversation: state.conversation,
            connectError: state.connectError,
            pendingTool: state.pendingTool,
            pendingApprovals: state.pendingApprovals,
        })),
    );
    const updateAgentState = useAgentStore((state) => state.setAgentState);
    const setAgentState = useCallback((patch: Parameters<typeof updateAgentState>[0]) => {
        if (useUserStore.getState().sessionVersion === sessionVersion) updateAgentState(patch);
    }, [sessionVersion, updateAgentState]);
    const conversationReady = conversation.status === "ready" || conversation.status === "warning";
    const conversationBusy = conversation.status === "preparing" || conversation.status === "running";
    const closePanel = useAgentStore((state) => state.closePanel);
    const pushMessage = useAgentStore((state) => state.addMessage);
    const pushEventLog = useAgentStore((state) => state.addEventLog);
    const clearEventLogs = useAgentStore((state) => state.clearEventLogs);
    const loadSkills = useAgentSkillStore((state) => state.loadSkills);
    const clearSkillSelection = useAgentSkillStore((state) => state.clearSelection);
    const skillCount = useAgentSkillStore((state) => state.skills.length);
    const messageCount = useAgentStore((state) => state.messages.length);
    const canvasContextRef = useRef<AgentCanvasContext | null>(useAgentStore.getState().canvasContext);
    const pendingToolRef = useRef<AgentPendingToolCall | null>(null);
    const autoConnectRef = useRef(false);
    const connectedRef = useRef(false);
    const attachmentUrlsRef = useRef(new Set<string>());
    const clientIdRef = useRef("");
    const endpoint = useMemo(() => url.trim().replace(/\/$/, ""), [url]);
    const urlAgentAutoConnect = searchParams.has("agentUrl") && searchParams.has("agentToken");

    const addMessage = (item: Omit<AgentChatItem, "id"> & { id?: string }) => {
        const text = normalizeText(item.text);
        if (!text && !item.attachments?.length) return;
        const current = useAgentStore.getState();
        const itemId = item.itemId || item.id || createId();
        const next = scopeChatItem({ ...item, id: item.id || itemId, itemId, text } as AgentChatItem, item.threadId ?? current.activeThreadId, item.turnId ?? current.activeTurnId);
        setAgentState({ messages: upsertAgentMessage(current.messages, next) });
    };

    const addEventLog = (title: string, text: unknown, raw?: unknown) => {
        if (useUserStore.getState().sessionVersion !== sessionVersion) return;
        const value = normalizeText(text) || title;
        const last = useAgentStore.getState().eventLogs.at(-1);
        if (last?.title === title && last.text === value) return;
        pushEventLog({ id: `${Date.now()}-${Math.random()}`, time: dayjs().format("YYYY-MM-DD HH:mm:ss"), title, text: value, raw });
    };

    const { loadThreads, applyConversationState, applyWorkspaceChange, startNewThread, resumeThread, confirmDeleteThreads, loadThreadsSequenceRef, threadMessagesRef, authoritativeHistoryTurnsRef, liveTurnKeysRef, threadOperationRef } = useAgentHistory({
        setAgentState,
        sessionVersion,
        endpoint,
        token,
        clientIdRef,
        connectedRef,
        pendingToolRef,
        addEventLog,
        connected,
        sending,
        waiting,
        loadingThreads,
        permissionMode,
        message,
        modal,
        t,
    });

    useLayoutEffect(() => {
        autoConnectRef.current = false;
        loadThreadsSequenceRef.current += 1;
        threadMessagesRef.current.clear();
        authoritativeHistoryTurnsRef.current.clear();
        liveTurnKeysRef.current.clear();
        pendingToolRef.current = null;
    }, [sessionVersion]);

    const { handleToolCall, rejectPendingTool, approvePendingTool, decideApproval } = useAgentApprovals({
        setAgentState,
        sessionVersion,
        endpoint,
        token,
        clientIdRef,
        canvasContextRef,
        pendingToolRef,
        confirmTools,
        pendingTool,
        navigate,
        message,
        addEventLog,
    });

    const { handleAgentEvent, showAgentError } = useAgentEvents({
        setAgentState,
        sessionVersion,
        endpoint,
        token,
        clientIdRef,
        canvasContextRef,
        liveTurnKeysRef,
        pushMessage,
        addMessage,
        addEventLog,
    });

    const clearAgentSession = useCallback((patch: Parameters<typeof setAgentState>[0] = {}) => {
        loadThreadsSequenceRef.current += 1;
        threadMessagesRef.current.clear();
        authoritativeHistoryTurnsRef.current.clear();
        liveTurnKeysRef.current.clear();
        threadOperationRef.current = 0;
        setAgentState({
            messages: [],
            tokenUsage: null,
            threads: [],
            activeThreadId: "",
            activeTurnId: "",
            workspacePath: "",
            loadingThreads: false,
            waiting: false,
            sending: false,
            fragmentBootstrap: false,
            pendingTool: null,
            pendingApprovals: [],
            conversation: { revision: 0, conversationId: "", threadId: "", status: "idle", mcpStatuses: {} },
            bootstrapStatus: null,
            mcpStartupStatuses: {},
            ...patch,
        });
        useAgentSkillStore.getState().reset();
        pendingToolRef.current = null;
    }, [setAgentState]);

    const { toggleAgentConnection } = useAgentConnection({
        setAgentState,
        sessionVersion,
        userId,
        endpoint,
        token,
        enabled,
        connected,
        headless,
        autoConnect,
        urlAgentAutoConnect,
        hash,
        navigate,
        searchParams,
        clientIdRef,
        canvasContextRef,
        connectedRef,
        pendingToolRef,
        autoConnectRef,
        liveTurnKeysRef,
        authoritativeHistoryTurnsRef,
        loadThreadsSequenceRef,
        applyConversationState,
        applyWorkspaceChange,
        loadThreads,
        loadSkills,
        handleToolCall,
        handleAgentEvent,
        showAgentError,
        addEventLog,
        clearAgentSession,
        message,
        permissionMode,
    });

    useEffect(() => () => attachmentUrlsRef.current.forEach((url) => URL.revokeObjectURL(url)), []);

    useEffect(() => {
        if (connected) void loadThreads();
    }, [connected, loadThreads]);

    useEffect(() => {
        if (connected) void loadSkills(endpoint, token);
    }, [connected, endpoint, loadSkills, token]);

    useEffect(() => {
        if (!connected) return;
        void fetchAgentJson<AgentModelsResponse>(endpoint, token, "/agent/codex/models").then(({ data = [] }) => {
            if (useUserStore.getState().sessionVersion !== sessionVersion) return;
            const names = new Set<string>();
            const models = data.flatMap((item) => {
                const name = item.displayName || item.model;
                const efforts = item.supportedReasoningEfforts.filter(({ reasoningEffort }) => AGENT_REASONING_EFFORTS.has(reasoningEffort));
                if (item.model === "codex-auto-review" || names.has(name) || !efforts.length) return [];
                names.add(name);
                const defaultReasoningEffort = efforts.some((effort) => effort.reasoningEffort === item.defaultReasoningEffort) ? item.defaultReasoningEffort : efforts[0].reasoningEffort;
                return [{ ...item, supportedReasoningEfforts: efforts, defaultReasoningEffort }];
            });
            if (!models.length) return;
            const savedModel = useAgentStore.getState().model;
            const current = models.find((item) => item.model === savedModel) || models.find((item) => item.isDefault) || models[0];
            const savedEffort = useAgentStore.getState().reasoningEffort;
            const efforts = current.supportedReasoningEfforts.map((item) => item.reasoningEffort);
            const nextEffort = efforts.includes(savedEffort as AgentReasoningEffort) ? savedEffort as AgentReasoningEffort : current.defaultReasoningEffort || efforts[0];
            localStorage.setItem(agentSettingKey("canvas-agent-model"), current.model);
            localStorage.setItem(agentSettingKey("canvas-agent-reasoning-effort"), nextEffort);
            setAgentState({ models, model: current.model, reasoningEffort: nextEffort });
        }).catch((error) => addEventLog(rt("modelListFailed"), error));
    }, [connected, endpoint, setAgentState, token, sessionVersion]);

    useEffect(() => {
        if (urlAgentAutoConnect && confirmTools) setAgentState({ confirmTools: false });
    }, [confirmTools, setAgentState, urlAgentAutoConnect]);

    const sendPrompt = async () => {
        if (useUserStore.getState().sessionVersion !== sessionVersion) return;
        const text = prompt.trim();
        const files = attachments;
        const skillState = useAgentSkillStore.getState();
        const selectedSkill = skillState.selectedSkill;
        const selectedSkillRevision = skillState.selectionRevision;
        const currentState = useAgentStore.getState();
        const canvasNodeIds = new Set(currentState.canvasContext?.snapshot.nodes.map((node) => node.id) || []);
        const canvasReferences = currentState.canvasReferences.filter((item) => canvasNodeIds.has(item.nodeId));
        if (canvasReferences.length !== currentState.canvasReferences.length) {
            setAgentState({ canvasReferences });
            message.warning(rt(canvasReferences.length ? "someCanvasReferencesMissing" : "canvasReferencesMissing"));
        }
        const requestPrompt = promptWithCanvasReferences(promptWithAttachments(text, files), canvasReferences);
        if (!currentState.connected || !requestPrompt || currentState.sending || currentState.waiting || currentState.loadingThreads || !["ready", "warning"].includes(currentState.conversation.status)) return;
        let referenceImages: AgentAttachment[] = [];
        if (canvasReferences.some((item) => item.kind === "image")) {
            setAgentState({ sending: true, activity: rt("readingCanvasImages") });
            try {
                referenceImages = await resolveCanvasReferenceImages(canvasReferences, currentState.canvasContext?.snapshot.nodes || []);
                assertCurrentSession(sessionVersion);
            } catch (error) {
                if (useUserStore.getState().sessionVersion !== sessionVersion) return;
                setAgentState({ sending: false, activity: rt("canvasImageReadFailed") });
                addMessage({ role: "error", title: rt("canvasImageReadFailed"), text: error instanceof Error ? error.message : rt("canvasImageReadFailed") });
                return;
            }
        }
        const requestFiles = [...files, ...referenceImages.filter((reference) => !files.some((file) => file.dataUrl === reference.dataUrl))];
        if (requestFiles.length > MAX_ATTACHMENTS) {
            setAgentState({ sending: false, activity: rt("tooManyImages") });
            addMessage({ role: "error", title: rt("tooManyImages"), text: rt("imageCountLimit", { count: MAX_ATTACHMENTS }) });
            return;
        }
        if (attachmentPayloadBytes(requestFiles) > MAX_ATTACHMENT_PAYLOAD_BYTES) {
            setAgentState({ sending: false, activity: rt("imageTooLarge") });
            addMessage({ role: "error", title: rt("imageTooLarge"), text: rt("imagePayloadTooLarge") });
            return;
        }
        const messageId = createId();
        const userText = text || rt(files.length ? "imagesSent" : "canvasReferencesSent", { count: files.length || canvasReferences.length });
        const messageReferences: AgentCanvasReference[] = await Promise.all(canvasReferences.map(async ({ nodeId, label, title, kind, previewUrl, text }) => {
            const image = referenceImages.find((item) => item.id === `canvas:${nodeId}`);
            return { nodeId, label, title, kind, previewUrl: image ? (await createMessageAttachmentMetadata(image)).url : previewUrl, text };
        }));
        if (useUserStore.getState().sessionVersion !== sessionVersion) return;
        const messageSkill = selectedSkill ? { name: selectedSkill.name, path: selectedSkill.path, displayName: selectedSkill.interface?.displayName || undefined } : undefined;
        loadThreadsSequenceRef.current += 1;
        const currentBeforeSend = useAgentStore.getState();
        const requestThreadId = currentBeforeSend.activeThreadId;
        setAgentState({ prompt: "", attachments: [], canvasReferences: [], activity: rt("sending"), sending: true, loadingThreads: false, activeTurnId: "", messages: currentBeforeSend.messages });
        addMessage({ id: messageId, itemId: "synthetic:user", clientMessageId: messageId, threadId: requestThreadId, turnId: "", role: "user", text: userText, attachments: files, canvasReferences: messageReferences, skill: messageSkill });
        let threadId = requestThreadId;
        try {
            const messageAttachments = await Promise.all(files.map(createMessageAttachmentMetadata));
            assertCurrentSession(sessionVersion);
            const messageMetadata = {
                ...(messageAttachments.length ? { attachments: messageAttachments } : {}),
                ...(messageReferences.length ? { canvasReferences: messageReferences } : {}),
                ...(messageSkill ? { skill: messageSkill } : {}),
            };
            const modelName = models.find((item) => item.model === model)?.displayName || model || rt("defaultModel");
            const effortName = reasoningEffort ? i18n.t(`agent.composer.effort.${reasoningEffort}`) : rt("defaultEffort");
            addEventLog(rt("sendTask"), `${modelName} · ${effortName}${selectedSkill ? ` · Skill ${selectedSkill.name}` : ""}${files.length ? ` · ${rt("attachmentCount", { count: files.length })}` : ""}${canvasReferences.length ? ` · ${rt("canvasReferenceCount", { count: canvasReferences.length })}` : ""} · ${compactText(text) || rt(canvasReferences.length ? "canvasReferencesOnly" : "attachmentsOnly")}`);
            const accepted = await fetchAgentJson<AgentTurnResponse>(endpoint, token, "/agent/codex/turn", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                    prompt: requestPrompt,
                    messageText: userText,
                    messageId,
                    clientId: clientIdRef.current,
                    threadId,
                    conversationId: currentBeforeSend.conversation.conversationId,
                    expectedRevision: currentBeforeSend.conversation.revision,
                    permissionMode,
                    model,
                    effort: reasoningEffort,
                    skill: selectedSkill ? { name: selectedSkill.name, path: selectedSkill.path } : undefined,
                    attachments: requestFiles.map(({ id, name, type, size, width, height, dataUrl }) => ({ id, name, type, size, width, height, dataUrl })),
                    messageMetadata,
                }),
            });
            assertCurrentSession(sessionVersion);
            threadId = accepted.threadId || threadId;
            if (!threadId) throw new Error(rt("startConversationFailed"));
            if (selectedSkill) clearSkillSelection(selectedSkillRevision);
            files.forEach((item) => {
                URL.revokeObjectURL(item.url);
                attachmentUrlsRef.current.delete(item.url);
            });
        } catch (error) {
            if (useUserStore.getState().sessionVersion !== sessionVersion) return;
            const text = error instanceof Error ? error.message : rt("sendFailed");
            const response = error instanceof AgentApiError ? error.response as { code?: string; state?: AgentConversationState } : undefined;
            if (response?.state) applyConversationState(response.state);
            const stale = response?.code === "CONVERSATION_STALE";
            const busy = response?.code === "CONVERSATION_BUSY" || text.includes("Codex 正在运行");
            const state = useAgentStore.getState();
            const removeFailedPending = (messages: AgentChatItem[]) => messages.filter((item) => item.clientMessageId !== messageId || Boolean(item.turnId));
            threadMessagesRef.current.forEach((messages, cachedThreadId) => {
                const next = removeFailedPending(messages);
                if (next.length !== messages.length) threadMessagesRef.current.set(cachedThreadId, next);
            });
            const ownsCurrentThread = state.activeThreadId === (threadId || requestThreadId);
            const restoreDraft = state.prompt || state.attachments.length || state.canvasReferences.length ? {} : { prompt, attachments: files, canvasReferences };
            if (ownsCurrentThread) {
                setAgentState({
                    activity: rt(stale ? "conversationSynced" : busy ? "codexRunning" : "sendFailed"),
                    sending: false,
                    messages: removeFailedPending(state.messages),
                    ...restoreDraft,
                });
                addMessage({ threadId: state.activeThreadId, turnId: "", role: "error", title: rt(stale ? "conversationSynced" : busy ? "taskStillRunning" : "sendFailed"), text });
            } else {
                setAgentState({ sending: false, messages: removeFailedPending(state.messages), ...restoreDraft });
            }
            addEventLog(rt("sendFailed"), error);
        }
    };

    const stopTurn = async () => {
        if (!connected || (!sending && !waiting)) return;
        setAgentState({ activity: rt("stopping") });
        try {
            await interruptCodexTurn(endpoint, token, useAgentStore.getState().activeThreadId || undefined);
            addEventLog(rt("stopTask"), rt("taskStopped"));
        } catch (error) {
            setAgentState({ activity: rt("stopFailed") });
            addEventLog(rt("stopFailed"), error);
        }
    };

    const addAttachments = async (files: FileList | File[] | null) => {
        if (!files || useUserStore.getState().sessionVersion !== sessionVersion) return;
        const images = Array.from(files).filter((file) => file.type.startsWith("image/"));
        const prev = useAgentStore.getState().attachments;
        try {
            const next = await Promise.all(
                images.slice(0, Math.max(0, MAX_ATTACHMENTS - prev.length)).map(async (file) => {
                    const dataUrl = await readDataUrl(file);
                    assertCurrentSession(sessionVersion);
                    const meta = await readImageMeta(dataUrl);
                    assertCurrentSession(sessionVersion);
                    const url = URL.createObjectURL(file);
                    attachmentUrlsRef.current.add(url);
                    return { id: createId(), name: file.name, type: file.type, size: file.size, width: meta.width, height: meta.height, url, dataUrl };
                }),
            );
            assertCurrentSession(sessionVersion);
            const merged = [...prev, ...next];
            if (attachmentPayloadBytes(merged) > MAX_ATTACHMENT_PAYLOAD_BYTES) {
                next.forEach((item) => {
                    URL.revokeObjectURL(item.url);
                    attachmentUrlsRef.current.delete(item.url);
                });
                addMessage({ role: "error", title: rt("imageTooLarge"), text: rt("imageLimit") });
                return;
            }
            if (next.length) setAgentState({ attachments: merged });
        } catch (error) {
            if (useUserStore.getState().sessionVersion !== sessionVersion) return;
            addMessage({ role: "error", title: rt("imageReadFailed"), text: error instanceof Error ? error.message : rt("imageReadFailed") });
        }
    };

    const removeAttachment = (id: string) => {
        const removed = attachments.find((item) => item.id === id);
        if (removed) {
            URL.revokeObjectURL(removed.url);
            attachmentUrlsRef.current.delete(removed.url);
        }
        setAgentState({ attachments: attachments.filter((item) => item.id !== id) });
    };

    const changePermissionMode = (nextMode: AgentPermissionMode) => {
        const apply = () => {
            if (useUserStore.getState().sessionVersion !== sessionVersion) return;
            localStorage.setItem(agentSettingKey("canvas-agent-permission-mode"), nextMode);
            setAgentState({ permissionMode: nextMode });
        };
        if (nextMode !== "full") return apply();
        modal.confirm({
            title: rt("enableFullAccess"),
            content: rt("fullAccessDescription"),
            okText: rt("enableFullAccessAction"),
            okType: "danger",
            cancelText: t("common.cancel"),
            onOk: apply,
        });
    };

    const connectionStatus = t(connectError ? "agent.status.failed" : connected ? "agent.status.connected" : enabled ? "agent.status.connecting" : "agent.status.disconnected");
    const connectionStatusColor = connectError ? "#dc2626" : connected ? "#16a34a" : enabled ? "#d97706" : theme.node.muted;
    const content = (
        <>
            <AgentPanelTabs
                value={activeTab}
                theme={theme}
                leading={
                    <div className="flex items-center gap-1">
                        <span className="grid size-8 place-items-center">
                            <Bot className="size-4" />
                        </span>
                        <div className="hidden text-base font-semibold leading-5 @min-[560px]:block">Agent</div>
                        <Tooltip title={t("agent.panel.connectionSettings", { status: connectionStatus })} placement="bottom">
                            <Button size="small" type="text" className="!h-8 !w-8 !min-w-8 !px-0 @min-[560px]:!w-auto @min-[560px]:!min-w-0 @min-[560px]:!px-[7px]" aria-label={t("agent.panel.connectionSettingsLabel", { status: connectionStatus })} icon={<PlugZap className="size-3.5" style={{ color: connectionStatusColor }} />} onClick={() => setAgentState({ activeTab: "setup" })}>
                                <span className="hidden @min-[560px]:inline">{connectionStatus}</span>
                            </Button>
                        </Tooltip>
                    </div>
                }
                items={[
                    { value: "chat", label: t("agent.panel.chat"), icon: <MessageSquare className="size-3.5" /> },
                    { value: "history", label: t("agent.panel.history"), icon: <History className="size-3.5" />, count: threads.length },
                    { value: "skills", label: t("agent.panel.skills"), icon: <Sparkles className="size-3.5" />, count: skillCount },
                    { value: "log", label: t("agent.panel.logs"), icon: <Terminal className="size-3.5" />, count: eventLogs.length },
                ]}
                onChange={(activeTab) => {
                    setAgentState({ activeTab });
                    if (activeTab === "history") void loadThreads();
                }}
                right={
                    <>
                        <Tooltip title={t("agent.history.newThread")} placement="bottom">
                            <Button size="small" type="text" className="!h-8 !w-8 !min-w-8 !px-0 @min-[560px]:!w-auto @min-[560px]:!min-w-0 @min-[560px]:!px-[7px]" aria-label={t("agent.history.newThread")} disabled={!connected || loadingThreads || sending || waiting || conversationBusy} icon={<Plus className="size-3.5" />} onClick={startNewThread}>
                                <span className="hidden @min-[560px]:inline">{t("agent.history.newThread")}</span>
                            </Button>
                        </Tooltip>
                        <Tooltip title={t("agent.panel.collapse")}>
                            <Button type="text" shape="circle" className="!h-8 !w-8 !min-w-8" aria-label={t("agent.panel.collapseLabel")} style={{ color: theme.node.muted }} icon={<PanelRightClose className="size-4" />} onClick={closePanel} />
                        </Tooltip>
                    </>
                }
            />

            {activeTab === "setup" ? (
                <AgentConnectView
                    theme={theme}
                    url={url}
                    token={token}
                    enabled={enabled}
                    connected={connected}
                    activity={activity}
                    connectError={connectError}
                    onUrlChange={(url) => setAgentState({ url, connectError: "" })}
                    onTokenChange={(token) => setAgentState({ token, connectError: "" })}
                    onToggleEnabled={toggleAgentConnection}
                />
            ) : activeTab === "skills" ? (
                <AgentSkillsView clientId={clientIdRef.current} />
            ) : activeTab === "history" ? (
                <AgentHistoryView
                    theme={theme}
                    threads={threads}
                    activeThreadId={activeThreadId}
                    workspacePath={workspacePath}
                    loading={loadingThreads}
                    busy={sending || waiting || conversationBusy}
                    connected={connected}
                    onRefresh={() => void loadThreads()}
                    onNewThread={() => void startNewThread()}
                    onResumeThread={(threadId) => void resumeThread(threadId)}
                    onDeleteThreads={confirmDeleteThreads}
                />
            ) : activeTab === "log" ? (
                <AgentLogView
                    logs={eventLogs}
                    theme={theme}
                    context={{ endpoint, connected, enabled, activity, waiting, sending, messages: messageCount, pendingTool: pendingTool?.name }}
                    onClear={clearEventLogs}
                    onCopied={(text) => message.success(text)}
                    onCopyBlocked={(text) => message.warning(text)}
                />
            ) : (
                <>
                    <AgentChatTimeline theme={theme} pendingTool={pendingTool} pendingApprovals={pendingApprovals} sending={sending} waiting={waiting} onRejectTool={rejectPendingTool} onApproveTool={approvePendingTool} onApprovalDecision={decideApproval} />
                    <AgentTaskProgress theme={theme} busy={sending || waiting} />
                    {tokenUsage ? <AgentUsageBar usage={tokenUsage} theme={theme} /> : null}
                    <AgentChatComposer
                        prompt={prompt}
                        attachments={attachments.map((attachment) => agentAttachmentToChatAttachment(attachment, endpoint, token))}
                        disabled={!connected || !conversationReady || loadingThreads}
                        sending={sending || waiting}
                        placeholder={conversation.status === "idle" || conversation.status === "preparing"
                            ? t("agent.panel.mcpInitializing")
                            : conversation.status === "failed"
                                ? t("agent.panel.initFailed")
                                : t("agent.panel.placeholder")}
                        theme={theme}
                        onPromptChange={(prompt) => setAgentState({ prompt })}
                        onSubmit={sendPrompt}
                        onStop={stopTurn}
                        onAddFiles={addAttachments}
                        onRemoveAttachment={removeAttachment}
                        confirmTools={confirmTools}
                        onConfirmToolsChange={(confirmTools) => setAgentState({ confirmTools })}
                        permissionMode={permissionMode}
                        onPermissionModeChange={changePermissionMode}
                        models={models}
                        model={model}
                        reasoningEffort={reasoningEffort}
                        onModelChange={(model) => {
                            const selected = models.find((item) => item.model === model);
                            if (!selected) return;
                            const effort = selected.defaultReasoningEffort || selected.supportedReasoningEfforts[0]?.reasoningEffort;
                            localStorage.setItem(agentSettingKey("canvas-agent-model"), model);
                            if (effort) localStorage.setItem(agentSettingKey("canvas-agent-reasoning-effort"), effort);
                            setAgentState({ model, ...(effort ? { reasoningEffort: effort } : {}) });
                        }}
                        onReasoningEffortChange={(reasoningEffort) => {
                            localStorage.setItem(agentSettingKey("canvas-agent-reasoning-effort"), reasoningEffort);
                            setAgentState({ reasoningEffort });
                        }}
                        left={
                            attachments.length ? (
                                <span className="hidden text-[11px] @min-[660px]:inline" style={{ color: theme.node.muted }}>
                                    {formatBytes(attachmentPayloadBytes(attachments))} / 30MB
                                </span>
                            ) : null
                        }
                    />
                </>
            )}
        </>
    );

    if (headless) return null;
    return embedded ? content : null;
}

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { App } from "antd";

import { readAgentUrlBootstrap } from "@/lib/agent/agent-url-bootstrap";
import { normalizeAgentEndpoint } from "@/lib/agent/agent-endpoint";
import { acquireAgentClientId, agentErrorState, approvalActivity, DEFAULT_AGENT_URL, AGENT_PROTOCOL_VERSION, rt, type AgentStatePatch, type AgentBootstrapEvent, type AgentChatEvent, type AgentCodexState, type AgentHelloEvent, type AgentWorkspaceEvent, type AgentWorkspaceResponse } from "@/lib/agent/agent-panel-utils";
import { activateAgentClient, discoverAgentConfig, fetchAgentJson, postState } from "@/services/api/canvas-agent";
import { useAgentSkillStore } from "@/stores/use-agent-skill-store";
import { useUserStore } from "@/stores/use-user-store";
import { useAgentStore, agentSettingKey, type AgentCanvasContext, type AgentConversationState, type AgentPendingApproval, type AgentPendingToolCall, type AgentPermissionMode } from "@/stores/use-agent-store";
import { bindPendingTurnMessages, isConnectionErrorMessage, isCurrentThreadEvent, parseEventData, registerLiveAgentTurn, scopeChatItem, upsertAgentMessage, type AgentEventPayload } from "@/components/agent/agent-event-formatters";

type AppContext = ReturnType<typeof App.useApp>;

type UseAgentConnectionOptions = {
    setAgentState: (patch: AgentStatePatch) => void;
    sessionVersion: number;
    userId: string;
    endpoint: string;
    token: string;
    enabled: boolean;
    connected: boolean;
    headless?: boolean;
    hash: string;
    navigate: (to: string, options?: { replace?: boolean }) => void;
    searchParams: URLSearchParams;
    clientIdRef: { current: string };
    canvasContextRef: { current: AgentCanvasContext | null };
    connectedRef: { current: boolean };
    pendingToolRef: { current: AgentPendingToolCall | null };
    liveTurnKeysRef: { current: Set<string> };
    authoritativeHistoryTurnsRef: { current: Set<string> };
    loadThreadsSequenceRef: { current: number };
    applyConversationState: (next: AgentConversationState, force?: boolean) => boolean;
    applyWorkspaceChange: (data: AgentWorkspaceEvent) => number;
    loadThreads: (skipHistory?: boolean, expectedTurnId?: string) => Promise<void>;
    loadSkills: (endpoint: string, token: string, forceReload?: boolean) => Promise<void>;
    handleToolCall: (endpoint: string, token: string, payload: AgentPendingToolCall) => Promise<void>;
    handleAgentEvent: (event: AgentEventPayload) => Promise<void>;
    showAgentError: (value: unknown, event?: AgentEventPayload, log?: boolean) => void;
    addEventLog: (title: string, text: unknown, raw?: unknown) => void;
    clearAgentSession: (patch?: AgentStatePatch) => void;
    message: AppContext["message"];
    modal: AppContext["modal"];
    permissionMode: AgentPermissionMode;
};

export function useAgentConnection({ setAgentState, sessionVersion, userId, endpoint, token, enabled, connected, headless, hash, navigate, searchParams, clientIdRef, canvasContextRef, connectedRef, pendingToolRef, liveTurnKeysRef, authoritativeHistoryTurnsRef, loadThreadsSequenceRef, applyConversationState, applyWorkspaceChange, loadThreads, loadSkills, handleToolCall, handleAgentEvent, showAgentError, addEventLog, clearAgentSession, message, modal, permissionMode }: UseAgentConnectionOptions) {
    const errorLoggedRef = useRef(false);
    const [clientReady, setClientReady] = useState(false);

    useEffect(() => {
        let disposed = false;
        setClientReady(false);
        void acquireAgentClientId().then((clientId) => {
            if (!disposed) {
                clientIdRef.current = `${clientId}:${userId}`;
                setClientReady(true);
            }
        });
        return () => { disposed = true; };
    }, [clientIdRef, userId, sessionVersion]);

    useLayoutEffect(() => {
        const fragment = readAgentUrlBootstrap(hash);
        const bootstrap = fragment || readAgentUrlBootstrap(searchParams.toString());
        if (!bootstrap) return;
        const query = new URLSearchParams(searchParams);
        query.delete("agentUrl");
        query.delete("agentToken");
        navigate(`${window.location.pathname}${query.size ? `?${query}` : ""}${fragment?.remainingHash ?? hash}`, { replace: true });
        clearAgentSession({ enabled: false, connected: false, authorizedConnection: "", confirmTools: true, activeTab: "setup" });
        useAgentStore.getState().openPanel();
        if (!bootstrap.url || !bootstrap.token) {
            setAgentState({ fragmentBootstrap: false, activeTab: "setup", connectError: rt(!bootstrap.url ? "addressRequired" : "agentNotFound") });
            useAgentStore.getState().openPanel();
            return;
        }
        try {
            normalizeAgentEndpoint(bootstrap.url);
        } catch {
            setAgentState({ fragmentBootstrap: false, activeTab: "setup", connectError: rt("invalidAddress") });
            useAgentStore.getState().openPanel();
            return;
        }
        errorLoggedRef.current = false;
        setAgentState({ url: normalizeAgentEndpoint(bootstrap.url), token: bootstrap.token, silentConnect: false, fragmentBootstrap: false, activity: "待确认连接", connectError: "" });
    }, [hash, navigate, searchParams, setAgentState, clearAgentSession]);

    // Imperatively subscribe to canvasContext to keep the ref current and debounce snapshot reports without rerendering the panel.
    useEffect(() => {
        let timer: ReturnType<typeof setTimeout> | null = null;
        const unsubscribe = useAgentStore.subscribe((state) => {
            if (state.canvasContext === canvasContextRef.current) return;
            canvasContextRef.current = state.canvasContext;
            if (!useAgentStore.getState().connected) return;
            if (timer) clearTimeout(timer);
            timer = setTimeout(() => {
                const current = useAgentStore.getState();
                if (useUserStore.getState().sessionVersion === sessionVersion && current.connected && current.enabled && current.authorizedConnection === `${endpoint}\0${token}`) void postState(endpoint, token, clientIdRef.current, canvasContextRef.current?.snapshot || null);
            }, 300);
        });
        return () => {
            unsubscribe();
            if (timer) clearTimeout(timer);
        };
    }, [canvasContextRef, clientIdRef, endpoint, sessionVersion, token]);

    useEffect(() => {
        const connectionKey = `${endpoint}\0${token}`;
        if (!clientReady || !enabled || !token.trim() || useAgentStore.getState().authorizedConnection !== connectionKey || useUserStore.getState().sessionVersion !== sessionVersion) return;
        localStorage.setItem(agentSettingKey("canvas-agent-url"), endpoint);
        localStorage.setItem(agentSettingKey("canvas-agent-token"), token);
        const clientId = clientIdRef.current;
        let disposed = false;
        let protocolRejected = false;
        let eventQueue = Promise.resolve();
        const isCurrentConnection = () => !disposed && useAgentStore.getState().enabled && useAgentStore.getState().authorizedConnection === connectionKey && clientIdRef.current === clientId && useUserStore.getState().sessionVersion === sessionVersion;
        const enqueueEvent = (task: () => void | Promise<void>) => {
            eventQueue = eventQueue.then(async () => {
                if (isCurrentConnection()) await task();
            }).catch((error) => {
                if (isCurrentConnection()) addEventLog(rt("conversationSyncFailed"), error);
            });
        };
        const source = new EventSource(`${endpoint}/events?token=${encodeURIComponent(token)}&clientId=${encodeURIComponent(clientId)}`);
        source.addEventListener("hello", (event) => {
            if (!isCurrentConnection()) return;
            const hello = parseEventData<AgentHelloEvent>(event);
            if (hello?.protocolVersion !== AGENT_PROTOCOL_VERSION) {
                const text = rt("agentOutdated");
                protocolRejected = true;
                source.close();
                connectedRef.current = false;
                setAgentState({ enabled: false, connected: false, waiting: false, sending: false, activity: rt("restartRequired"), connectError: text, silentConnect: false, fragmentBootstrap: false, pendingTool: null, pendingApprovals: [] });
                useAgentSkillStore.getState().reset();
                addEventLog(rt("versionMismatch"), text, hello);
                if (!headless) message.error(text);
                return;
            }
            const codex = hello?.codex;
            const busy = Boolean(codex?.busy);
            const nextThreadId = hello?.conversation?.threadId ?? hello?.workspace?.activeThreadId ?? useAgentStore.getState().activeThreadId;
            if (hello?.conversation) applyConversationState(hello.conversation, true);
            else applyWorkspaceChange({ activeThreadId: nextThreadId });
            const current = useAgentStore.getState();
            const nextTurnId = codex?.threadId === nextThreadId ? codex.turnId ?? "" : "";
            if (nextTurnId) liveTurnKeysRef.current.add(`${nextThreadId}\0${nextTurnId}`);
            const activeTurnId = busy ? nextTurnId : "";
            const pendingApprovals = busy ? (hello?.pendingApprovals || []).filter((item) => !item.threadId || item.threadId === nextThreadId) : [];
            const messages = activeTurnId
                ? bindPendingTurnMessages(current.messages.filter((item) => !isConnectionErrorMessage(item)), nextThreadId, activeTurnId)
                : current.messages.filter((item) => !isConnectionErrorMessage(item));
            errorLoggedRef.current = false;
            connectedRef.current = true;
            setAgentState({
                connected: true,
                activity: pendingApprovals.length ? rt("awaitingApproval") : busy ? rt("codexRunning") : rt("connected"),
                waiting: busy,
                sending: false,
                connectError: "",
                silentConnect: false,
                fragmentBootstrap: false,
                activeThreadId: nextThreadId,
                activeTurnId,
                messages,
                pendingApprovals,
            });
            if (!headless) message.success(rt("localAgentConnected"));
            void postState(endpoint, token, clientId, canvasContextRef.current?.snapshot || null);
            if (document.visibilityState === "visible" && document.hasFocus()) void activateAgentClient(endpoint, token, clientId);
            if (!busy && !nextThreadId && (!hello?.conversation || hello.conversation.status === "idle")) {
                void fetchAgentJson<AgentWorkspaceResponse>(endpoint, token, "/agent/codex/threads/reset", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ clientId, permissionMode }) })
                    .then((result) => isCurrentConnection() && result.conversation && applyConversationState(result.conversation))
                    .catch((error) => {
                        if (!isCurrentConnection()) return;
                        const state = agentErrorState(error);
                        if (state) applyConversationState(state);
                        addEventLog(rt("conversationInitFailed"), error);
                    });
            }
        });
        source.addEventListener("codex_state", (event) => {
            const data = parseEventData<AgentCodexState>(event);
            if (!data) return;
            enqueueEvent(async () => {
                const busy = Boolean(data.busy);
                const current = useAgentStore.getState();
                const appliesToCurrentThread = !data.threadId || data.threadId === current.activeThreadId;
                if (!appliesToCurrentThread) return;
                const turnId = data.turnId || current.activeTurnId;
                if (turnId) liveTurnKeysRef.current.add(`${current.activeThreadId}\0${turnId}`);
                const activeTurnId = busy ? turnId : "";
                const messages = activeTurnId ? bindPendingTurnMessages(current.messages, current.activeThreadId, activeTurnId) : current.messages;
                setAgentState({
                    activity: busy ? rt("codexRunning") : current.activity === rt("processingFailed") ? rt("processingFailed") : rt("completed"),
                    waiting: busy,
                    sending: false,
                    activeTurnId,
                    messages,
                });
                if (!busy && current.waiting) void loadThreads(false, turnId);
            });
        });
        source.addEventListener("tool_call", (event) => {
            if (!isCurrentConnection()) return;
            const data = parseEventData<AgentPendingToolCall>(event);
            if (data) void handleToolCall(endpoint, token, data).catch((error) => {
                if (isCurrentConnection()) addEventLog(rt("toolExecutionFailed"), error);
            });
        });
        source.addEventListener("codex_approval", (event) => {
            if (!isCurrentConnection()) return;
            const data = parseEventData<AgentPendingApproval>(event);
            if (!data || !isCurrentThreadEvent(data)) return;
            setAgentState({ pendingApprovals: [...useAgentStore.getState().pendingApprovals.filter((item) => item.requestId !== data.requestId), data], activity: rt("awaitingApproval") });
            addEventLog(rt("awaitingApproval"), data.reason || data.method, data);
        });
        source.addEventListener("codex_approval_resolved", (event) => {
            if (!isCurrentConnection()) return;
            const data = parseEventData<{ requestId?: string; decision?: "accept" | "acceptForSession" | "decline" | "cancel" }>(event);
            if (!data?.requestId) return;
            const current = useAgentStore.getState();
            const approval = current.pendingApprovals.find((item) => item.requestId === data.requestId);
            const pendingApprovals = current.pendingApprovals.filter((item) => item.requestId !== data.requestId);
            setAgentState({ pendingApprovals, activity: approvalActivity(pendingApprovals, current.waiting, current.activity) });
            const decision = data.decision || approval?.deciding;
            if (approval && decision) addEventLog(rt(decision === "accept" || decision === "acceptForSession" ? "approvalGranted" : "approvalCanceled"), approval.reason || approval.method, approval);
        });
        source.addEventListener("agent_event", (event) => {
            const data = parseEventData<AgentEventPayload>(event);
            if (data) enqueueEvent(() => {
                if (!isCurrentThreadEvent(data)) return;
                const shouldProcess = registerLiveAgentTurn(data, authoritativeHistoryTurnsRef.current, liveTurnKeysRef.current);
                if (data.type !== "usage.updated" && !shouldProcess) return;
                return handleAgentEvent(data);
            });
        });
        source.addEventListener("agent_bootstrap", (event) => {
            const data = parseEventData<AgentBootstrapEvent>(event);
            if (!data?.type) return;
            if (data.type === "codex.preparing") {
                addEventLog(rt("conversationInitializing"), rt("conversationCreating"), data);
                return;
            }
            if (data.type === "codex.prepare_failed") {
                addEventLog(rt("conversationInitFailed"), data.error, data);
                return;
            }
            if (data.type === "mcp.complete") {
                addEventLog(rt("mcpStatusComplete"), rt("mcpListRead"), data);
                return;
            }
            if (!data.name || !data.status) return;
            const label = data.name;
            const status = data.status === "starting"
                ? { text: rt("mcpStarting", { name: label }), detail: rt("mcpConnecting"), status: "running" as const }
                : data.status === "ready"
                    ? { text: rt("mcpReadyNamed", { name: label }), detail: rt("toolsReady"), status: "ready" as const }
                    : data.status === "failed"
                        ? { text: rt("mcpFailedNamed", { name: label }), detail: data.error || rt("toolInitFailed"), status: "error" as const }
                        : { text: rt("mcpCanceledNamed", { name: label }), detail: rt("toolInitCanceled"), status: "error" as const };
            addEventLog(status.text, status.detail, data);
        });
        source.addEventListener("conversation_changed", (event) => {
            const data = parseEventData<AgentConversationState>(event);
            if (data) enqueueEvent(() => { applyConversationState(data); });
        });
        source.addEventListener("workspace_changed", (event) => {
            const data = parseEventData<AgentWorkspaceEvent>(event);
            if (!data) return;
            enqueueEvent(() => {
                if (data.conversation) applyConversationState(data.conversation);
                else applyWorkspaceChange(data);
                if (!data.draftThread) void loadThreads(Boolean(data.emptyThread));
            });
        });
        source.addEventListener("chat_message", (event) => {
            const data = parseEventData<AgentChatEvent>(event);
            if (!data?.message) return;
            enqueueEvent(() => {
                if (!isCurrentThreadEvent(data)) return;
                if (!registerLiveAgentTurn(data, authoritativeHistoryTurnsRef.current, liveTurnKeysRef.current)) return;
                const current = useAgentStore.getState();
                const threadId = data.threadId || data.message!.threadId || current.activeThreadId;
                const turnId = data.turnId ?? data.message!.turnId ?? "";
                const clientMessageId = data.message!.clientMessageId || data.message!.itemId || data.message!.id;
                if (current.activeThreadId !== threadId) return;
                const next = scopeChatItem(data.message!, threadId, turnId);
                const currentMessages = data.message!.role === "user" && clientMessageId
                    ? current.messages.filter((item) => item.role !== "user" || item.clientMessageId !== clientMessageId || item.id === next.id)
                    : current.messages;
                const messages = upsertAgentMessage(currentMessages, next);
                setAgentState({ messages });
            });
        });
        source.addEventListener("agent_log", (event) => {
            if (!isCurrentConnection()) return;
            const text = parseEventData<{ text?: unknown }>(event)?.text;
            addEventLog(rt("log"), text, text);
        });
        source.addEventListener("skills_changed", (event) => {
            if (!isCurrentConnection()) return;
            const data = parseEventData<{ forceReload?: boolean }>(event);
            void loadSkills(endpoint, token, Boolean(data?.forceReload));
        });
        source.addEventListener("agent_error", (event) => {
            const data = parseEventData<AgentEventPayload>(event);
            if (!data) return;
            enqueueEvent(() => {
                if (!isCurrentThreadEvent(data)) return;
                if (!registerLiveAgentTurn(data, authoritativeHistoryTurnsRef.current, liveTurnKeysRef.current)) return;
                showAgentError(data.message, data, !data.replayed);
            });
        });
        source.onerror = () => {
            if (!isCurrentConnection() || protocolRejected) return;
            const wasConnected = connectedRef.current;
            const silent = useAgentStore.getState().silentConnect && !wasConnected;
            const text = rt(wasConnected ? "connectionLostDescription" : "connectionFailedDescription");
            if (!errorLoggedRef.current || wasConnected) {
                addEventLog(rt(wasConnected ? "connectionLost" : "connectionFailed"), text);
                if (!headless && !silent) message.error(text);
            }
            errorLoggedRef.current = true;
            connectedRef.current = false;
            pendingToolRef.current = null;
            setAgentState({
                activity: rt(wasConnected ? "connectionLost" : "connectionFailed"),
                connected: false,
                waiting: false,
                sending: false,
                connectError: silent ? "" : text,
                silentConnect: false,
                fragmentBootstrap: false,
                pendingTool: null,
                pendingApprovals: [],
            });
            useAgentSkillStore.getState().reset();
            if (!wasConnected) {
                source.close();
                setAgentState({ enabled: false });
            }
        };
        return () => {
            disposed = true;
            source.close();
            connectedRef.current = false;
            loadThreadsSequenceRef.current += 1;
            useAgentSkillStore.getState().reset();
        };
    }, [applyConversationState, applyWorkspaceChange, clientReady, enabled, endpoint, loadSkills, loadThreads, message, setAgentState, token, sessionVersion]);

    useEffect(() => {
        if (!connected) return;
        const activate = () => {
            const current = useAgentStore.getState();
            if (useUserStore.getState().sessionVersion === sessionVersion && current.connected && current.authorizedConnection === `${endpoint}\0${token}`) void activateAgentClient(endpoint, token, clientIdRef.current);
        };
        const activateVisible = () => {
            if (document.visibilityState === "visible") activate();
        };
        window.addEventListener("focus", activate);
        document.addEventListener("visibilitychange", activateVisible);
        return () => {
            window.removeEventListener("focus", activate);
            document.removeEventListener("visibilitychange", activateVisible);
        };
    }, [clientIdRef, connected, endpoint, sessionVersion, token]);

    const toggleAgentConnection = async ({ silent = false }: { silent?: boolean } = {}) => {
        const connectionSessionVersion = useUserStore.getState().sessionVersion;
        if (enabled) {
            clearAgentSession({ enabled: false, connected: false, authorizedConnection: "", activity: rt("offline"), connectError: "" });
            return;
        }
        let nextEndpoint: string;
        try {
            nextEndpoint = normalizeAgentEndpoint(endpoint || DEFAULT_AGENT_URL);
        } catch (error) {
            message.warning(error instanceof Error ? error.message : rt("invalidAddress"));
            return;
        }
        const accepted = await modal.confirm({
            title: "确认连接 Agent",
            content: `目标：${nextEndpoint}。连接后，该服务可读取当前画布并接收你发送的内容。请确认这是你信任的 Agent；远程 Agent 的工具请求需要逐次确认。`,
            okText: "信任并连接",
            cancelText: "取消",
            focusable: { autoFocusButton: "cancel" },
        });
        if (!accepted || useUserStore.getState().sessionVersion !== connectionSessionVersion || useAgentStore.getState().url.trim().replace(/\/$/, "") !== endpoint || useAgentStore.getState().token !== token) return;
        const discovered = token.trim() ? null : await discoverAgentConfig(nextEndpoint);
        if (useUserStore.getState().sessionVersion !== connectionSessionVersion || useAgentStore.getState().url.trim().replace(/\/$/, "") !== endpoint || useAgentStore.getState().token !== token) return;
        const nextToken = (token.trim() || discovered?.token || "").trim();
        if (!nextEndpoint) {
            const text = rt("addressRequired");
            if (!silent) {
                setAgentState({ connectError: text });
                if (!headless) message.warning(text);
            }
            return;
        }
        if (!nextToken) {
            const text = rt("agentNotFound");
            if (!silent) {
                setAgentState({ connectError: text });
                if (!headless) message.warning(text);
            }
            return;
        }
        errorLoggedRef.current = false;
        setAgentState({ url: nextEndpoint, token: nextToken, authorizedConnection: `${nextEndpoint}\0${nextToken}`, enabled: true, connected: false, confirmTools: true, silentConnect: false, fragmentBootstrap: false, activity: rt("connecting"), connectError: "", activeTab: "setup" });
    };

    return { toggleAgentConnection };
}

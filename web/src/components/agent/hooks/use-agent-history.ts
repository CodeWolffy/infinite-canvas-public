import { useCallback, useRef } from "react";
import type { App } from "antd";
import type { TFunction } from "i18next";

import { agentErrorState, authoritativeHistoryTurnKeys, conversationBootstrapView, delay, HISTORY_RETRY_DELAYS_MS, rt, type AgentStatePatch, type AgentThreadResponse, type AgentThreadsResponse, type AgentWorkspaceEvent, type AgentWorkspaceResponse } from "@/lib/agent/agent-panel-utils";
import { acknowledgeCodexHistory, fetchAgentJson } from "@/services/api/canvas-agent";
import { useAgentSkillStore } from "@/stores/use-agent-skill-store";
import { assertCurrentSession, useUserStore } from "@/stores/use-user-store";
import { useAgentStore, type AgentChatItem, type AgentConversationState, type AgentPendingToolCall, type AgentPermissionMode } from "@/stores/use-agent-store";
import { mergeAgentMessages, normalizeHistoryMessages, scopeChatItem } from "@/components/agent/agent-event-formatters";

type AppContext = ReturnType<typeof App.useApp>;

type UseAgentHistoryOptions = {
    setAgentState: (patch: AgentStatePatch) => void;
    sessionVersion: number;
    endpoint: string;
    token: string;
    clientIdRef: { current: string };
    connectedRef: { current: boolean };
    pendingToolRef: { current: AgentPendingToolCall | null };
    addEventLog: (title: string, text: unknown, raw?: unknown) => void;
    connected: boolean;
    sending: boolean;
    waiting: boolean;
    loadingThreads: boolean;
    permissionMode: AgentPermissionMode;
    message: AppContext["message"];
    modal: AppContext["modal"];
    t: TFunction;
};

export function useAgentHistory({ setAgentState, sessionVersion, endpoint, token, clientIdRef, connectedRef, pendingToolRef, addEventLog, connected, sending, waiting, loadingThreads, permissionMode, message, modal, t }: UseAgentHistoryOptions) {
    const loadThreadsSequenceRef = useRef(0);
    const threadMessagesRef = useRef(new Map<string, AgentChatItem[]>());
    const authoritativeHistoryTurnsRef = useRef(new Set<string>());
    const liveTurnKeysRef = useRef(new Set<string>());
    const threadOperationRef = useRef(0);
    const threadOperationSequenceRef = useRef(0);
    const clearSkillSelection = useAgentSkillStore((state) => state.clearSelection);

    const loadThreadSnapshot = useCallback(async (threadId: string, sequence: number, response?: AgentThreadResponse, expectedTurnId = "") => {
        let thread = response;
        let lastError: unknown;
        for (const delayMs of HISTORY_RETRY_DELAYS_MS) {
            if (delayMs) await delay(delayMs);
            if (useUserStore.getState().sessionVersion !== sessionVersion || sequence !== loadThreadsSequenceRef.current || useAgentStore.getState().activeThreadId !== threadId) return false;
            try {
                thread ||= await fetchAgentJson<AgentThreadResponse>(endpoint, token, `/agent/codex/threads/${encodeURIComponent(threadId)}`);
                lastError = undefined;
            } catch (error) {
                lastError = error;
                thread = undefined;
                continue;
            }
            const history = normalizeHistoryMessages(thread.messages || []);
            const latest = useAgentStore.getState();
            if (useUserStore.getState().sessionVersion !== sessionVersion || sequence !== loadThreadsSequenceRef.current || latest.activeThreadId !== threadId) return false;
            const historyTurns = authoritativeHistoryTurnKeys(threadId, thread.settledTurnIds || []);
            const hasExpectedTurn = !expectedTurnId || historyTurns.has(`${threadId}\0${expectedTurnId}`);
            historyTurns.forEach((key) => liveTurnKeysRef.current.delete(key));
            if (latest.activeTurnId) liveTurnKeysRef.current.add(`${threadId}\0${latest.activeTurnId}`);
            authoritativeHistoryTurnsRef.current = historyTurns;
            const messages = mergeAgentMessages(history, latest.messages, threadId, liveTurnKeysRef.current);
            threadMessagesRef.current.set(threadId, messages);
            setAgentState({ messages, connectError: "" });
            const coveredTurnIds = [...historyTurns].map((key) => key.slice(threadId.length + 1));
            if (coveredTurnIds.length) void acknowledgeCodexHistory(endpoint, token, threadId, coveredTurnIds).catch(() => undefined);
            if (hasExpectedTurn && (thread.historyReady !== false || Boolean(expectedTurnId))) return true;
            thread = undefined;
        }
        if (lastError) throw lastError;
        return false;
    }, [endpoint, setAgentState, token, sessionVersion]);

    const applyWorkspaceChange = useCallback((data: AgentWorkspaceEvent) => {
        const nextThreadId = data.activeThreadId ?? data.threadId ?? "";
        const current = useAgentStore.getState();
        const threadChanged = current.activeThreadId !== nextThreadId;
        const emptyThread = Boolean(data.emptyThread || data.draftThread);
        const pendingMessage = [...current.messages].reverse().find((item) => item.role === "user" && !item.turnId);
        const keepPendingMessage = Boolean(
            data.emptyThread
            && pendingMessage
            && (current.sending || current.waiting)
            && (!data.sourceClientId || data.sourceClientId === clientIdRef.current),
        );
        if (threadChanged && current.activeThreadId) {
            const messages = keepPendingMessage ? current.messages.filter((item) => item.id !== pendingMessage!.id) : current.messages;
            threadMessagesRef.current.set(current.activeThreadId, messages);
        }
        if (emptyThread && nextThreadId) threadMessagesRef.current.delete(nextThreadId);
        if (threadChanged || emptyThread) {
            loadThreadsSequenceRef.current += 1;
            authoritativeHistoryTurnsRef.current.clear();
            liveTurnKeysRef.current.clear();
        }
        const messages = keepPendingMessage
            ? [scopeChatItem(pendingMessage!, nextThreadId, "")]
            : emptyThread ? []
                : threadChanged ? threadMessagesRef.current.get(nextThreadId) || []
                    : current.messages;
        pendingToolRef.current = null;
        setAgentState({
            activeThreadId: nextThreadId,
            activeTurnId: threadChanged || emptyThread ? "" : current.activeTurnId,
            messages,
            tokenUsage: threadChanged || emptyThread ? null : current.tokenUsage,
            pendingTool: null,
            pendingApprovals: threadChanged || emptyThread ? [] : current.pendingApprovals,
        });
        return loadThreadsSequenceRef.current;
    }, [clientIdRef, pendingToolRef, setAgentState]);

    const applyConversationState = useCallback((next: AgentConversationState, force = false) => {
        const current = useAgentStore.getState();
        if (!next?.revision || !force && next.revision <= current.conversation.revision) return false;
        const conversationChanged = next.conversationId !== current.conversation.conversationId;
        if (conversationChanged || next.threadId !== current.activeThreadId) {
            applyWorkspaceChange({
                activeThreadId: next.threadId,
                emptyThread: conversationChanged || !current.activeThreadId,
                draftThread: next.status === "preparing",
                sourceClientId: next.sourceClientId,
            });
        }
        setAgentState({ conversation: next, ...conversationBootstrapView(next) });
        return true;
    }, [applyWorkspaceChange, setAgentState]);

    const loadThreads = useCallback(async (skipHistory = false, expectedTurnId = "") => {
        if (useUserStore.getState().sessionVersion !== sessionVersion) return;
        if (!connectedRef.current && !useAgentStore.getState().connected) return;
        let sequence = ++loadThreadsSequenceRef.current;
        setAgentState({ loadingThreads: true });
        try {
            const data = await fetchAgentJson<AgentThreadsResponse>(endpoint, token, `/agent/codex/threads`);
            if (sequence !== loadThreadsSequenceRef.current) return;
            if (data.conversation) {
                applyConversationState(data.conversation);
                sequence = loadThreadsSequenceRef.current;
            }
            const current = useAgentStore.getState();
            const currentThreadId = current.activeThreadId || data.workspace?.activeThreadId || "";
            if (!data.conversation && currentThreadId !== current.activeThreadId) sequence = applyWorkspaceChange({ activeThreadId: currentThreadId });
            if (sequence !== loadThreadsSequenceRef.current || useAgentStore.getState().activeThreadId !== currentThreadId) return;
            setAgentState({ threads: data.data || [], workspacePath: data.workspace?.workspacePath || "" });
            if (currentThreadId && !skipHistory) {
                await loadThreadSnapshot(currentThreadId, sequence, undefined, expectedTurnId);
            } else {
                authoritativeHistoryTurnsRef.current.clear();
                liveTurnKeysRef.current.clear();
            }
        } catch (error) {
            addEventLog(rt("historyReadFailed"), error);
        } finally {
            if (sequence === loadThreadsSequenceRef.current && !threadOperationRef.current) setAgentState({ loadingThreads: false });
        }
    }, [applyConversationState, applyWorkspaceChange, endpoint, loadThreadSnapshot, sessionVersion, setAgentState, token]);

    const beginThreadOperation = () => {
        if (useUserStore.getState().sessionVersion !== sessionVersion) return 0;
        const operation = ++threadOperationSequenceRef.current;
        threadOperationRef.current = operation;
        setAgentState({ loadingThreads: true });
        return operation;
    };

    const finishThreadOperation = (operation: number) => {
        if (threadOperationRef.current !== operation) return;
        threadOperationRef.current = 0;
        setAgentState({ loadingThreads: false });
    };

    const startNewThread = async () => {
        const current = useAgentStore.getState();
        if (!current.connected || current.sending || current.waiting || current.loadingThreads || ["preparing", "running"].includes(current.conversation.status)) return;
        const operation = beginThreadOperation();
        if (!operation) return;
        clearSkillSelection();
        setAgentState({ activeTab: "chat", activity: rt("creatingConversation") });
        try {
            const result = await fetchAgentJson<AgentWorkspaceResponse>(endpoint, token, "/agent/codex/threads/reset", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ clientId: clientIdRef.current, permissionMode }) });
            if (threadOperationRef.current !== operation) return;
            if (result.conversation) applyConversationState(result.conversation);
            setAgentState({ activeTab: "chat", activity: rt("newConversation") });
        } catch (error) {
            const state = agentErrorState(error);
            if (state) applyConversationState(state);
            addEventLog(rt("newConversationFailed"), error);
            message.error(error instanceof Error ? error.message : rt("newConversationFailed"));
            await loadThreads();
        } finally {
            finishThreadOperation(operation);
        }
    };

    const resumeThread = async (threadId: string) => {
        const current = useAgentStore.getState();
        if (!current.connected || !threadId || current.sending || current.waiting || current.loadingThreads || ["preparing", "running"].includes(current.conversation.status)) return;
        const operation = beginThreadOperation();
        if (!operation) return;
        try {
            const result = await fetchAgentJson<AgentThreadResponse>(endpoint, token, `/agent/codex/threads/${encodeURIComponent(threadId)}/resume`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ permissionMode, clientId: clientIdRef.current }) });
            if (result.conversation) applyConversationState(result.conversation);
            await loadThreads();
            if (useAgentStore.getState().activeThreadId === threadId) setAgentState({ activeTab: "chat", activity: rt("conversationResumed") });
        } catch (error) {
            const state = agentErrorState(error);
            if (state) applyConversationState(state);
            addEventLog(rt("resumeConversationFailed"), error);
            message.error(error instanceof Error ? error.message : rt("resumeConversationFailed"));
            await loadThreads();
        } finally {
            finishThreadOperation(operation);
        }
    };

    const deleteThreads = async (threadIds: string[]) => {
        if (!connected || !threadIds.length || sending || waiting || loadingThreads) return;
        const operation = beginThreadOperation();
        if (!operation) return;
        let deletedCount = 0;
        try {
            for (const threadId of new Set(threadIds)) {
                assertCurrentSession(sessionVersion);
                await fetchAgentJson(endpoint, token, `/agent/codex/threads/${encodeURIComponent(threadId)}/delete`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ clientId: clientIdRef.current }) });
                threadMessagesRef.current.delete(threadId);
                deletedCount += 1;
            }
            await loadThreads();
            message.success(rt("recordsDeleted", { count: deletedCount }));
        } catch (error) {
            await loadThreads();
            addEventLog(rt("deleteConversationFailed"), error);
            message.error(error instanceof Error ? error.message : rt("deleteConversationFailed"));
        } finally {
            finishThreadOperation(operation);
        }
    };

    const confirmDeleteThreads = (threadIds: string[]) => {
        modal.confirm({
            title: rt("deleteConversations", { count: threadIds.length }),
            content: rt("deleteConversationsDescription"),
            okText: t("common.delete"),
            okType: "danger",
            cancelText: t("common.cancel"),
            onOk: () => deleteThreads(threadIds),
        });
    };

    return { loadThreads, applyConversationState, applyWorkspaceChange, startNewThread, resumeThread, deleteThreads, confirmDeleteThreads, loadThreadsSequenceRef, threadMessagesRef, authoritativeHistoryTurnsRef, liveTurnKeysRef, threadOperationRef };
}

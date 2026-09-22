import i18n from "@/i18n";
import { fitNodeSize } from "@/lib/canvas/canvas-node-size";
import { imageMetadata } from "@/lib/canvas/canvas-node-factory";
import { createId, eventScope, importGeneratedImages, rt, scopeEventChatItem, type AgentStatePatch } from "@/lib/agent/agent-panel-utils";
import { postState } from "@/services/api/canvas-agent";
import { assertCurrentSession } from "@/stores/use-user-store";
import { useAgentStore, type AgentCanvasContext, type AgentChatItem } from "@/stores/use-agent-store";
import { activityDeltaFallback, activityDetail, activityKind, activityPlaceholder, agentErrorView, bindPendingTurnMessages, eventUsage, formatAgentActivity, formatAgentEvent, formatAgentEventLog, formatAgentPlan, isReasoningSummary, mergeStreamText, normalizeText, reasoningActivityText, scopeChatItem, stringText, turnPlanStatus, upsertAgentMessage, type AgentEventPayload } from "@/components/agent/agent-event-formatters";
import type { CanvasAgentOp } from "@/lib/canvas/canvas-agent-ops";

type UseAgentEventsOptions = {
    setAgentState: (patch: AgentStatePatch) => void;
    sessionVersion: number;
    endpoint: string;
    token: string;
    clientIdRef: { current: string };
    canvasContextRef: { current: AgentCanvasContext | null };
    liveTurnKeysRef: { current: Set<string> };
    pushMessage: (item: AgentChatItem) => void;
    addMessage: (item: Omit<AgentChatItem, "id"> & { id?: string }) => void;
    addEventLog: (title: string, text: unknown, raw?: unknown) => void;
};

export function useAgentEvents({ setAgentState, sessionVersion, endpoint, token, clientIdRef, canvasContextRef, liveTurnKeysRef, pushMessage, addMessage, addEventLog }: UseAgentEventsOptions) {
    const upsertActivityMessage = (item: AgentChatItem) => {
        setAgentState({ messages: upsertAgentMessage(useAgentStore.getState().messages, item) });
    };

    const appendActivityDelta = (event: AgentEventPayload) => {
        const item = event.item;
        if (!item?.id) return;
        const text = stringText(item.text) || stringText(item.delta);
        const isDelta = Boolean(stringText(item.delta));
        if (!text) return;
        if (item.type === "reasoning") {
            const scoped = scopeEventChatItem(event, activityDeltaFallback(item, text), "synthetic:reasoning");
            const current = useAgentStore.getState().messages.find((message) => message.id === scoped.id);
            const activityItems = { ...(current?.activityItems || {}) };
            const previous = activityItems[item.id] || "";
            activityItems[item.id] = isDelta ? `${previous === activityPlaceholder("reasoning") ? "" : previous}${text}` : text;
            upsertActivityMessage({ ...scoped, title: i18n.t("agent.events.reasoning"), text: reasoningActivityText(activityItems), activityItems, detail: activityDetail(current?.detail || scoped.detail, "reasoning", "inProgress") });
            return;
        }
        const scoped = scopeEventChatItem(event, activityDeltaFallback(item, text), item.id);
        const currentMessages = useAgentStore.getState().messages;
        const index = currentMessages.findIndex((message) => message.id === scoped.id);
        if (index < 0) {
            if (!text.trim()) return;
            upsertActivityMessage(scoped);
            return;
        }
        const current = currentMessages[index];
        if (item.type === "command_execution") {
            const detail = activityDetail(current.detail, "command", "inProgress");
            detail.output = isDelta ? `${stringText(detail.output)}${text}` : text;
            setAgentState({ messages: currentMessages.map((message, itemIndex) => itemIndex === index ? { ...message, detail } : message) });
            return;
        }
        const placeholder = activityPlaceholder(item.type);
        if (!text.trim() && current.text === placeholder) return;
        const nextText = isDelta ? `${current.text === placeholder ? "" : current.text}${text}` : mergeStreamText(current.text, text);
        setAgentState({ messages: currentMessages.map((message, itemIndex) => itemIndex === index ? { ...message, text: nextText, detail: { ...activityDetail(message.detail, activityKind(item.type), "inProgress") } } : message) });
    };

    const upsertEventActivity = (event: AgentEventPayload, item: Omit<AgentChatItem, "id">) => {
        const itemId = event.item?.id;
        if (!itemId) return;
        if (event.item?.type === "reasoning") {
            const scoped = scopeEventChatItem(event, { ...item, id: "synthetic:reasoning" }, "synthetic:reasoning");
            const current = useAgentStore.getState().messages.find((message) => message.id === scoped.id);
            const activityItems = { ...(current?.activityItems || {}) };
            const previous = activityItems[itemId] || "";
            const incoming = normalizeText(item.text);
            activityItems[itemId] = incoming === "已完成分析" && previous && previous !== activityPlaceholder("reasoning") ? previous : incoming;
            upsertActivityMessage({ ...scoped, title: i18n.t("agent.events.reasoning"), text: reasoningActivityText(activityItems, incoming), activityItems });
            return;
        }
        upsertActivityMessage(scopeEventChatItem(event, { ...item, id: itemId }, itemId));
    };

    const finishEmptyReasoningActivity = (event: AgentEventPayload) => {
        const itemId = event.item?.id;
        if (!itemId) return;
        const scopedId = scopeEventChatItem(event, { id: "synthetic:reasoning", role: "tool", text: "" }, "synthetic:reasoning").id;
        const currentMessages = useAgentStore.getState().messages;
        const index = currentMessages.findIndex((message) => message.id === scopedId);
        if (index < 0) return;
        const current = currentMessages[index];
        const activityItems = { ...(current.activityItems || {}) };
        delete activityItems[itemId];
        if (!Object.values(activityItems).some(isReasoningSummary)) {
            setAgentState({ messages: currentMessages.filter((_, itemIndex) => itemIndex !== index) });
            return;
        }
        setAgentState({ messages: currentMessages.map((message, itemIndex) => itemIndex === index ? { ...message, text: reasoningActivityText(activityItems), activityItems, detail: activityDetail(message.detail, "reasoning", "completed") } : message) });
    };

    const finishPlanActivity = (event: AgentEventPayload) => {
        const id = scopeEventChatItem(event, { id: "synthetic:plan", role: "tool", text: "" }, "synthetic:plan").id;
        const currentMessages = useAgentStore.getState().messages;
        const index = currentMessages.findIndex((message) => message.id === id);
        if (index < 0) return;
        const current = currentMessages[index];
        const detail = activityDetail(current.detail, "todo", turnPlanStatus(current.detail, event.status));
        setAgentState({ messages: currentMessages.map((message, itemIndex) => itemIndex === index ? { ...message, detail } : message) });
    };

    const showAgentError = (value: unknown, event?: AgentEventPayload, log = true) => {
        const error = agentErrorView(value);
        const item = event
            ? scopeEventChatItem(event, { id: "synthetic:error", role: "error", title: error.title, text: error.text }, "synthetic:error")
            : scopeChatItem({ id: createId(), role: "error", title: error.title, text: error.text }, useAgentStore.getState().activeThreadId, useAgentStore.getState().activeTurnId);
        const state = useAgentStore.getState();
        const current = state.messages.find((message) => message.id === item.id);
        if (current && !normalizeText(value)) return;
        upsertActivityMessage(item);
        setAgentState({ activity: rt("processingFailed"), pendingApprovals: [] });
        if (log) addEventLog(rt("processingFailed"), error.text, value);
    };

    const appendStreamText = (event: AgentEventPayload, text: string, isDelta = false) => {
        if (!text) return;
        const itemId = event.item?.id;
        if (!itemId) return;
        const scoped = scopeEventChatItem(event, { id: itemId, role: "assistant", title: "Codex", text, streamId: itemId }, itemId);
        const currentMessages = useAgentStore.getState().messages;
        const index = currentMessages.findIndex((message) => message.id === scoped.id);
        if (index < 0) {
            pushMessage(scoped);
            return;
        }
        setAgentState({ messages: currentMessages.map((message, itemIndex) => itemIndex === index ? { ...message, text: isDelta ? `${message.text}${text}` : mergeStreamText(message.text, text) } : message) });
    };

    const handleAgentEvent = async (event: AgentEventPayload) => {
        if (event.type === "usage.updated") setAgentState({ tokenUsage: eventUsage(event) });
        const log = event.replayed ? null : formatAgentEventLog(event);
        const activity = formatAgentActivity(event);
        if (log) addEventLog(log.title, log.text);
        if (event.type === "turn.started" && (event.turnId || event.turn_id)) {
            const scope = eventScope(event);
            const current = useAgentStore.getState();
            if (!scope.threadId || !scope.turnId) return;
            liveTurnKeysRef.current.add(`${scope.threadId}\0${scope.turnId}`);
            setAgentState({ activeTurnId: scope.turnId, bootstrapStatus: null, mcpStartupStatuses: {}, messages: bindPendingTurnMessages(current.messages, scope.threadId, scope.turnId) });
        }
        if (event.type === "item.updated" && event.item?.type === "agent_message" && event.item.id) {
            const delta = stringText(event.item.delta);
            appendStreamText(event, delta || stringText(event.item.text), Boolean(delta));
            return;
        }
        if (event.type === "item.updated" && event.item) {
            appendActivityDelta(event);
            return;
        }
        if (event.type === "plan.updated" && event.turn_id) {
            const plan = formatAgentPlan(event);
            if (plan) upsertActivityMessage(scopeEventChatItem(event, { ...plan, id: "synthetic:plan" }, "synthetic:plan"));
            return;
        }
        if (event.type === "item.completed" && event.item?.type === "error") {
            showAgentError(event.item.message, event, !event.replayed);
            return;
        }
        if (event.type === "item.completed" && event.item?.type === "agent_message" && event.item.id) {
            const scoped = scopeEventChatItem(event, { id: event.item.id, role: "assistant", title: "Codex", text: stringText(event.item.text) }, event.item.id);
            const currentMessages = useAgentStore.getState().messages;
            const index = currentMessages.findIndex((message) => message.id === scoped.id);
            if (index >= 0) {
                const text = stringText(event.item.text);
                setAgentState({ messages: currentMessages.map((message, itemIndex) => itemIndex === index ? { ...message, text: text || message.text, streamId: undefined } : message) });
                return;
            }
            addMessage(scoped);
            return;
        }
        if (event.type === "item.completed" && event.item?.type === "reasoning" && !activity) {
            finishEmptyReasoningActivity(event);
            return;
        }
        if (event.type === "item.completed" && !activity && event.item?.id && event.item.type === "plan") {
            const id = scopeEventChatItem(event, { id: event.item.id, role: "tool", text: "" }, event.item.id).id;
            setAgentState({ messages: useAgentStore.getState().messages.filter((item) => item.id !== id) });
            return;
        }
        if (!event.replayed && event.type === "item.completed" && event.item?.type === "image_generation" && event.item.id && event.sourceClientId === clientIdRef.current) {
            const generated = await importGeneratedImages(endpoint, token, event.item);
            assertCurrentSession(sessionVersion);
            if (generated.length) {
                const context = canvasContextRef.current;
                if (context) {
                    const right = Math.max(0, ...context.snapshot.nodes.map((node) => node.position.x + node.width)) + 80;
                    const ops = generated.map<CanvasAgentOp>((image, index) => {
                        const size = fitNodeSize(image.upload.width, image.upload.height);
                        return {
                            type: "add_node",
                            id: `image-${createId()}`,
                            nodeType: "image",
                            title: image.name,
                            position: { x: right + index * 40, y: index * 40 },
                            ...size,
                            metadata: imageMetadata(image.upload),
                        };
                    });
                    const result = context.applyOps(ops);
                    void postState(endpoint, token, clientIdRef.current, result);
                }
                addEventLog(rt("importGeneratedImages"), rt(context ? "addedToSourceCanvas" : "imageGenerated"));
            }
        }
        if (activity && event.item?.id) {
            upsertEventActivity(event, activity);
            return;
        }
        if (event.type === "turn.completed") {
            const scope = eventScope(event);
            if (scope.turnId) {
                finishPlanActivity(event);
                liveTurnKeysRef.current.add(`${scope.threadId}\0${scope.turnId}`);
            }
            const current = useAgentStore.getState();
            setAgentState({
                activeTurnId: current.activeTurnId === scope.turnId ? "" : current.activeTurnId,
                messages: current.messages.map((message) => message.threadId === scope.threadId && message.turnId === scope.turnId && message.streamId ? { ...message, streamId: undefined } : message),
            });
            if (event.status === "failed") showAgentError(event.error?.message, event, !event.replayed);
        }
        const item = formatAgentEvent(event);
        if (item) addMessage(scopeEventChatItem(event, { ...item, id: event.item?.id || createId() }, event.item?.id || createId()));
    };

    return { handleAgentEvent, showAgentError };
}

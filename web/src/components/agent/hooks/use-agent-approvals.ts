import { useEffect, useRef } from "react";
import type { App } from "antd";
import type { useNavigate } from "react-router-dom";

import { isSiteTool, runSiteTool } from "@/lib/agent/agent-site-tools";
import { isLocalAgentEndpoint } from "@/lib/agent/agent-endpoint";
import { approvalActivity, attachmentNodeOps, rt, type AgentStatePatch } from "@/lib/agent/agent-panel-utils";
import { postCodexApproval, postState, postToolResult } from "@/services/api/canvas-agent";
import { assertCurrentSession, useUserStore } from "@/stores/use-user-store";
import { useAgentStore, type AgentCanvasContext, type AgentPendingApproval, type AgentPendingToolCall } from "@/stores/use-agent-store";
import { isCanvasWriteTool, toolName } from "@/components/agent/agent-event-formatters";
import type { CanvasAgentOp, CanvasAgentSnapshot } from "@/lib/canvas/canvas-agent-ops";

type AppContext = ReturnType<typeof App.useApp>;

type UseAgentApprovalsOptions = {
    setAgentState: (patch: AgentStatePatch) => void;
    sessionVersion: number;
    endpoint: string;
    token: string;
    clientIdRef: { current: string };
    canvasContextRef: { current: AgentCanvasContext | null };
    pendingToolRef: { current: AgentPendingToolCall | null };
    confirmTools: boolean;
    pendingTool: AgentPendingToolCall | null;
    navigate: ReturnType<typeof useNavigate>;
    message: AppContext["message"];
    addEventLog: (title: string, text: unknown, raw?: unknown) => void;
};

export function useAgentApprovals({ setAgentState, sessionVersion, endpoint, token, clientIdRef, canvasContextRef, pendingToolRef, confirmTools, pendingTool, navigate, message, addEventLog }: UseAgentApprovalsOptions) {
    const confirmToolsRef = useRef(confirmTools);

    useEffect(() => {
        confirmToolsRef.current = confirmTools;
    }, [confirmTools]);
    useEffect(() => {
        pendingToolRef.current = pendingTool;
    }, [pendingTool, pendingToolRef]);

    const connectionIsCurrent = () => {
        const current = useAgentStore.getState();
        return useUserStore.getState().sessionVersion === sessionVersion && current.connected && current.enabled && current.authorizedConnection === `${endpoint}\0${token}`;
    };

    const runToolCall = async (endpoint: string, token: string, payload: AgentPendingToolCall) => {
        if (!connectionIsCurrent()) return;
        const toolSessionVersion = sessionVersion;
        if (isSiteTool(payload.name)) {
            try {
                addEventLog(toolName(payload.name), payload, payload);
                const result = await runSiteTool(payload.name, payload.input || {}, navigate, { canvasSnapshot: canvasContextRef.current?.snapshot || null });
                if (!connectionIsCurrent()) return;
                assertCurrentSession(toolSessionVersion);
                await postToolResult(endpoint, token, clientIdRef.current, { requestId: payload.requestId, result });
                assertCurrentSession(toolSessionVersion);
                addEventLog(rt("toolCompleted", { tool: toolName(payload.name) }), result, result);
            } catch (error) {
                if (!connectionIsCurrent()) return;
                const message = error instanceof Error ? error.message : rt("toolExecutionFailed");
                await postToolResult(endpoint, token, clientIdRef.current, { requestId: payload.requestId, error: message });
            }
            return;
        }
        try {
            const input: { ops?: CanvasAgentOp[]; path?: string } = payload.input || {};
            addEventLog(toolName(payload.name), payload, payload);
            let result: unknown;
            let appliedOps = input.ops || [];
            if (payload.name === "site_navigate") {
                const path = input.path || "/";
                if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\")) throw new Error("Agent 只允许跳转站内路径");
                if (/^\/(video|audio)(\/|\?|#|$)/.test(path)) throw new Error("企业平台仅支持图片和文本生成");
                navigate(path);
                result = { ok: true, path };
            } else if (payload.name === "canvas_apply_ops") {
                const context = canvasContextRef.current;
                if (!context) throw new Error(rt("openCanvasFirst"));
                result = context.applyOps(appliedOps);
                void postState(endpoint, token, clientIdRef.current, result as CanvasAgentSnapshot);
            } else if (payload.name === "canvas_create_attachment_nodes") {
                const context = canvasContextRef.current;
                if (!context) throw new Error(rt("openCanvasFirst"));
                appliedOps = await attachmentNodeOps(endpoint, token, clientIdRef.current, payload.input?.nodes);
                if (!connectionIsCurrent()) return;
                assertCurrentSession(toolSessionVersion);
                result = context.applyOps(appliedOps);
                await postState(endpoint, token, clientIdRef.current, result as CanvasAgentSnapshot);
            } else if (["canvas_get_state", "canvas_get_selection", "canvas_export_snapshot"].includes(payload.name)) {
                const snapshot = canvasContextRef.current?.snapshot;
                if (!snapshot) throw new Error(rt("openCanvasFirst"));
                result = snapshot;
            } else {
                throw new Error("不支持的 Agent 工具");
            }
            assertCurrentSession(toolSessionVersion);
            await postToolResult(endpoint, token, clientIdRef.current, { requestId: payload.requestId, result });
            assertCurrentSession(toolSessionVersion);
            addEventLog(rt("toolCompleted", { tool: toolName(payload.name) }), result, result);
        } catch (error) {
            if (!connectionIsCurrent()) return;
            const message = error instanceof Error ? error.message : rt("canvasOperationFailed");
            await postToolResult(endpoint, token, clientIdRef.current, { requestId: payload.requestId, error: message });
        }
    };

    const handleToolCall = async (endpoint: string, token: string, payload: AgentPendingToolCall) => {
        if (!connectionIsCurrent()) return;
        if (!isLocalAgentEndpoint(endpoint) || (confirmToolsRef.current && (isCanvasWriteTool(payload.name) || isSiteTool(payload.name) || payload.name === "site_navigate"))) {
            if (pendingToolRef.current) {
                await postToolResult(endpoint, token, clientIdRef.current, { requestId: payload.requestId, error: rt("pendingCanvasTool") });
                return;
            }
            pendingToolRef.current = payload;
            setAgentState({ pendingTool: payload });
            addEventLog(rt("awaitingConfirmation"), payload, payload);
            return;
        }
        await runToolCall(endpoint, token, payload);
    };

    const rejectPendingTool = async () => {
        if (!pendingTool) return;
        await postToolResult(endpoint, token, clientIdRef.current, { requestId: pendingTool.requestId, error: rt("canvasToolCanceled") });
        pendingToolRef.current = null;
        setAgentState({ pendingTool: null });
    };

    const approvePendingTool = async () => {
        if (!pendingTool) return;
        const tool = pendingTool;
        pendingToolRef.current = null;
        setAgentState({ pendingTool: null });
        await runToolCall(endpoint, token, tool);
    };

    const decideApproval = async (approval: AgentPendingApproval, decision: "accept" | "acceptForSession" | "decline") => {
        const current = useAgentStore.getState();
        const pending = current.pendingApprovals.find((item) => item.requestId === approval.requestId);
        if (!pending || pending.deciding) return;
        setAgentState({ pendingApprovals: current.pendingApprovals.map((item) => item.requestId === approval.requestId ? { ...item, deciding: decision } : item), activity: rt("submittingApproval") });
        try {
            await postCodexApproval(endpoint, token, approval.requestId, decision);
            const latest = useAgentStore.getState();
            if (latest.pendingApprovals.some((item) => item.requestId === approval.requestId)) setAgentState({ activity: rt("waitingCodexApproval") });
        } catch (error) {
            const latest = useAgentStore.getState();
            const expired = error instanceof Error && error.message.includes("审批请求已失效");
            const resolved = expired || !latest.pendingApprovals.some((item) => item.requestId === approval.requestId);
            const pendingApprovals = resolved
                ? latest.pendingApprovals.filter((item) => item.requestId !== approval.requestId)
                : latest.pendingApprovals.map((item) => item.requestId === approval.requestId ? { ...item, deciding: undefined } : item);
            setAgentState({ pendingApprovals, activity: approvalActivity(pendingApprovals, latest.waiting, latest.activity) });
            if (resolved) return;
            addEventLog(rt("approvalFailed"), error);
            message.error(error instanceof Error ? error.message : rt("approvalFailed"));
        }
    };

    return { handleToolCall, rejectPendingTool, approvePendingTool, decideApproval };
}

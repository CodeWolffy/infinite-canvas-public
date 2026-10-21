import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    state: {} as Record<string, any>, session: 1,
    confirm: vi.fn(), navigate: vi.fn(), postState: vi.fn(), postToolResult: vi.fn(), runSiteTool: vi.fn(), discover: vi.fn(), openPanel: vi.fn(),
}));
vi.mock("@/stores/use-user-store", () => ({ useUserStore: { getState: () => ({ sessionVersion: mocks.session }) }, assertCurrentSession: (version: number) => { if (version !== mocks.session) throw new Error("stale"); } }));
vi.mock("@/stores/use-agent-store", () => ({ agentSettingKey: (key: string) => key, useAgentStore: { getState: () => ({ ...mocks.state, openPanel: mocks.openPanel }), subscribe: () => () => {} } }));
vi.mock("@/stores/use-agent-skill-store", () => ({ useAgentSkillStore: { getState: () => ({ reset: () => {} }) } }));
vi.mock("@/lib/agent/agent-panel-utils", () => ({ acquireAgentClientId: async () => "client", DEFAULT_AGENT_URL: "http://127.0.0.1:17371", AGENT_PROTOCOL_VERSION: "test-protocol", rt: (key: string) => key, agentErrorState: () => null, approvalActivity: () => "idle", attachmentNodeOps: async () => [] }));
vi.mock("@/lib/agent/agent-site-tools", () => ({ isSiteTool: (name: string) => name.startsWith("workbench_") || name === "assets_list", runSiteTool: mocks.runSiteTool }));
vi.mock("@/services/api/canvas-agent", () => ({ activateAgentClient: vi.fn(), discoverAgentConfig: mocks.discover, fetchAgentJson: vi.fn(async () => ({})), postState: mocks.postState, postToolResult: mocks.postToolResult, postCodexApproval: vi.fn() }));
vi.mock("@/components/agent/agent-event-formatters", () => ({
    bindPendingTurnMessages: (value: unknown) => value, isConnectionErrorMessage: () => false, isCurrentThreadEvent: () => true,
    parseEventData: (event: { data: string }) => JSON.parse(event.data), registerLiveAgentTurn: () => true, scopeChatItem: (value: unknown) => value, upsertAgentMessage: (items: unknown) => items,
    isCanvasWriteTool: (name: string) => name === "canvas_apply_ops", toolName: (name: string) => name,
}));
import { useAgentConnection } from "@/components/agent/hooks/use-agent-connection";
import { useAgentApprovals } from "@/components/agent/hooks/use-agent-approvals";
import { normalizeAgentEndpoint } from "@/lib/agent/agent-endpoint";

const streams: Array<{ emit: (type: string, value: unknown) => void; close: ReturnType<typeof vi.fn> }> = [];
const ref = <T,>(value: T) => ({ current: value });
const patch = (value: Record<string, unknown>) => Object.assign(mocks.state, value);
function options(hash = "", search = "") {
    return {
        setAgentState: patch, sessionVersion: 1, userId: "user", endpoint: mocks.state.url, token: mocks.state.token,
        enabled: false, connected: false, hash, searchParams: new URLSearchParams(search), navigate: mocks.navigate,
        clientIdRef: ref("client:user"), canvasContextRef: ref({ snapshot: { nodes: [] } }), connectedRef: ref(false), pendingToolRef: ref(null),
        liveTurnKeysRef: ref(new Set()), authoritativeHistoryTurnsRef: ref(new Set()), loadThreadsSequenceRef: ref(0),
        applyConversationState: vi.fn(), applyWorkspaceChange: vi.fn(), loadThreads: vi.fn(async () => {}), loadSkills: vi.fn(async () => {}),
        handleToolCall: vi.fn(async () => {}), handleAgentEvent: vi.fn(async () => {}), showAgentError: vi.fn(), addEventLog: vi.fn(), clearAgentSession: patch,
        message: { success: vi.fn(), warning: vi.fn(), error: vi.fn() }, modal: { confirm: mocks.confirm }, permissionMode: "request",
    } as unknown as Parameters<typeof useAgentConnection>[0];
}

beforeEach(() => {
    vi.clearAllMocks(); streams.length = 0; mocks.session = 1;
    mocks.state = { url: "http://127.0.0.1:17371", token: "local-token", enabled: false, connected: false, authorizedConnection: "", messages: [], conversation: { status: "ready" }, activeThreadId: "thread" };
    mocks.confirm.mockResolvedValue(false);
    vi.stubGlobal("EventSource", class {
        handlers = new Map<string, (event: { data: string }) => void>();
        close = vi.fn();
        constructor() { streams.push({ close: this.close, emit: (type, value) => this.handlers.get(type)?.({ data: JSON.stringify(value) }) }); }
        addEventListener(type: string, handler: (event: { data: string }) => void) { this.handlers.set(type, handler); }
    });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

test.each(["query", "fragment"])("%s 中的恶意 Agent 只填充设置，零连接、零画布上传", async (kind) => {
    const params = new URLSearchParams({ agentUrl: "https://attacker.example", agentToken: "attacker-token" }).toString();
    const args = options(kind === "fragment" ? `#${params}` : "", kind === "query" ? params : "");
    renderHook(() => useAgentConnection(args));
    await waitFor(() => expect(mocks.openPanel).toHaveBeenCalled());
    expect(mocks.state.url).toBe("https://attacker.example");
    expect(mocks.state.enabled).toBe(false);
    expect(mocks.state.authorizedConnection).toBe("");
    expect(mocks.state.confirmTools).toBe(true);
    expect(streams).toHaveLength(0);
    expect(mocks.postState).not.toHaveBeenCalled();
    expect(mocks.discover).not.toHaveBeenCalled();
});

test("取消、切换会话或编辑配置后，连接确认均不能生效", async () => {
    const args = options();
    const { result } = renderHook(() => useAgentConnection(args));
    await act(async () => { await result.current.toggleAgentConnection(); });
    expect(mocks.state.enabled).toBe(false);
    mocks.confirm.mockImplementation(async () => { mocks.session = 2; return true; });
    await act(async () => { await result.current.toggleAgentConnection(); });
    expect(mocks.state.enabled).toBe(false);
    mocks.session = 1;
    mocks.confirm.mockImplementation(async () => { mocks.state.url = "https://changed.example"; return true; });
    await act(async () => { await result.current.toggleAgentConnection(); });
    expect(mocks.state.enabled).toBe(false);
    expect(streams).toHaveLength(0);
});

test("明确确认才建立 SSE，握手后才上传画布；授权撤销后丢弃事件", async () => {
    const args = options();
    const { result, rerender } = renderHook((value) => useAgentConnection(value), { initialProps: args });
    mocks.confirm.mockResolvedValue(true);
    await act(async () => { await result.current.toggleAgentConnection(); });
    expect(mocks.postState).not.toHaveBeenCalled();
    rerender({ ...args, enabled: true });
    await waitFor(() => expect(streams).toHaveLength(1));
    act(() => streams[0].emit("hello", { protocolVersion: "test-protocol", conversation: { threadId: "thread", status: "ready" } }));
    expect(mocks.postState).toHaveBeenCalledTimes(1);
    mocks.state.authorizedConnection = "";
    act(() => streams[0].emit("tool_call", { name: "workbench_video_generate", requestId: "untrusted" }));
    expect(args.handleToolCall).not.toHaveBeenCalled();
});

test("远程 Agent 即使关闭工具确认，也不能直接生成或读取素材", async () => {
    const args = { ...options(), endpoint: "https://agent.example", confirmTools: false, pendingTool: null } as unknown as Parameters<typeof useAgentApprovals>[0];
    Object.assign(mocks.state, { connected: true, enabled: true, authorizedConnection: `${args.endpoint}\0${args.token}` });
    const { result } = renderHook(() => useAgentApprovals(args));
    await act(async () => { await result.current.handleToolCall(args.endpoint, args.token, { requestId: "paid", name: "workbench_video_generate", input: {} }); });
    expect(mocks.state.pendingTool.requestId).toBe("paid");
    expect(mocks.runSiteTool).not.toHaveBeenCalled();
    await act(async () => { await result.current.handleToolCall(args.endpoint, args.token, { requestId: "read", name: "assets_list", input: {} }); });
    expect(mocks.runSiteTool).not.toHaveBeenCalled();
    expect(mocks.postToolResult).toHaveBeenCalledWith(args.endpoint, args.token, expect.anything(), expect.objectContaining({ requestId: "read", error: expect.any(String) }));
});

test("HTTP 远程地址、URL 凭据与片段不能作为 Agent 端点", () => {
    for (const url of ["http://remote.example", "https://name:secret@agent.example", "https://agent.example#x", "javascript:alert(1)"]) expect(() => normalizeAgentEndpoint(url)).toThrow();
    expect(normalizeAgentEndpoint("http://127.0.0.1:17371/")).toBe("http://127.0.0.1:17371");
});

test("已确认工具完成前撤销连接授权，结果不再发送给旧 Agent", async () => {
    const args = { ...options(), endpoint: "http://127.0.0.1:17371", confirmTools: false, pendingTool: null } as unknown as Parameters<typeof useAgentApprovals>[0];
    Object.assign(mocks.state, { connected: true, enabled: true, authorizedConnection: `${args.endpoint}\0${args.token}` });
    let complete!: (value: unknown) => void;
    mocks.runSiteTool.mockImplementationOnce(() => new Promise((resolve) => { complete = resolve; }));
    const { result } = renderHook(() => useAgentApprovals(args));
    let tool!: Promise<void>;
    act(() => { tool = result.current.handleToolCall(args.endpoint, args.token, { requestId: "read", name: "assets_list" }); });
    mocks.state.authorizedConnection = "";
    await act(async () => { complete({ private: "result" }); await tool; });
    expect(mocks.postToolResult).not.toHaveBeenCalled();
});

test("未知工具和站外导航不能通过默认分支读取画布或跳转", async () => {
    const args = { ...options(), confirmTools: false, pendingTool: null } as unknown as Parameters<typeof useAgentApprovals>[0];
    Object.assign(mocks.state, { connected: true, enabled: true, authorizedConnection: `${args.endpoint}\0${args.token}` });
    const { result } = renderHook(() => useAgentApprovals(args));
    await act(async () => { await result.current.handleToolCall(args.endpoint, args.token, { requestId: "unknown", name: "unrecognized" }); });
    expect(mocks.postToolResult).toHaveBeenLastCalledWith(args.endpoint, args.token, expect.anything(), expect.objectContaining({ requestId: "unknown", error: "不支持的 Agent 工具" }));
    await act(async () => { await result.current.handleToolCall(args.endpoint, args.token, { requestId: "navigate", name: "site_navigate", input: { path: "https://attacker.example" } }); });
    expect(mocks.navigate).not.toHaveBeenCalled();
});

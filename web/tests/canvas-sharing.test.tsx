import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { App } from "antd";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { ShareDialog } from "@/components/share-dialog";
import { CanvasInvitations } from "@/components/canvas/canvas-invitations";
import type { CanvasCollaboration, CanvasInvitation } from "@/services/api/canvas-collaboration";
import type { ShareLink } from "@/services/api/sharing";

const mocks = vi.hoisted(() => ({
    session: { sessionVersion: 1 }, copy: vi.fn(), navigate: vi.fn(), getCollaboration: vi.fn(), invite: vi.fn(), update: vi.fn(), remove: vi.fn(), logs: vi.fn(),
    getShare: vi.fn(), createShare: vi.fn(), resetShare: vi.fn(), revokeShare: vi.fn(), invitations: vi.fn(), respond: vi.fn(),
}));
vi.mock("@/stores/use-user-store", () => ({ useUserStore: Object.assign((select: (state: typeof mocks.session) => unknown) => select(mocks.session), { getState: () => mocks.session }) }));
vi.mock("@/hooks/use-copy-text", () => ({ useCopyText: () => mocks.copy }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("react-router-dom", async (original) => ({ ...await original<typeof import("react-router-dom")>(), useNavigate: () => mocks.navigate }));
vi.mock("@/services/api/canvas-collaboration", () => ({
    getCanvasCollaboration: mocks.getCollaboration, inviteCanvasMember: mocks.invite, updateCanvasMember: mocks.update, removeCanvasMember: mocks.remove,
    getCanvasAccessLog: mocks.logs, listCanvasInvitations: mocks.invitations, respondCanvasInvitation: mocks.respond,
}));
vi.mock("@/services/api/sharing", () => ({
    getShareLink: mocks.getShare, createShareLink: mocks.createShare, resetShareLink: mocks.resetShare, revokeShareLink: mocks.revokeShare,
    sharePageUrl: (token: string) => `${window.location.origin}/s/${token}`,
}));

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => { resolve = done; });
    return { promise, resolve };
}
const owner = { userId: "owner", username: "alice", displayName: "所有者甲" };
const collaboration = (overrides: Partial<CanvasCollaboration> = {}): CanvasCollaboration => ({
    owner, canManage: true, workspace: null, members: [{ ...owner, role: "owner", source: "owner", status: "accepted" }], share: null, ...overrides,
});
const share = (token: string): ShareLink => ({ token, url: `/s/${token}`, createdAt: "2026-01-01T00:00:00Z", expiresAt: null, createdBy: owner });
const invitation: CanvasInvitation = { projectId: "invited-canvas", title: "受邀画布", invitedBy: owner, role: "viewer", createdAt: "2026-01-01T00:00:00Z" };
const dialog = (targetId = "canvas-a", open = true) => <App><MemoryRouter><ShareDialog kind="canvas" targetId={targetId} open={open} onClose={vi.fn()} /></MemoryRouter></App>;
const inbox = () => <App><MemoryRouter><CanvasInvitations /></MemoryRouter></App>;

beforeEach(() => {
    vi.clearAllMocks();
    mocks.session.sessionVersion = 1;
    mocks.getCollaboration.mockResolvedValue(collaboration());
    mocks.invite.mockResolvedValue(undefined);
    mocks.update.mockResolvedValue(undefined);
    mocks.remove.mockResolvedValue(undefined);
    mocks.createShare.mockResolvedValue({ share: share("new-token") });
    mocks.resetShare.mockResolvedValue({ share: share("reset-token") });
    mocks.revokeShare.mockResolvedValue(undefined);
    mocks.invitations.mockResolvedValue([invitation]);
    mocks.respond.mockResolvedValue(undefined);
    mocks.logs.mockResolvedValue({ items: [], total: 0 });
    vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} })));
    vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

test("打开分享只加载权限，复制账号链接不创建公开权限，邀请默认viewer", async () => {
    render(dialog());
    const input = await screen.findByLabelText("画布账号访问地址");
    expect(input).toHaveValue(`${window.location.origin}/canvas/canvas-a`);
    expect(mocks.createShare).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /^复\s*制$/ }));
    expect(mocks.copy).toHaveBeenCalledWith(`${window.location.origin}/canvas/canvas-a`, "画布地址已复制");
    fireEvent.change(screen.getByLabelText("受邀账号"), { target: { value: "bob" } });
    fireEvent.click(screen.getByRole("button", { name: /^邀\s*请$/ }));
    await waitFor(() => expect(mocks.invite).toHaveBeenCalledWith("canvas-a", "bob", "viewer"));
    expect(mocks.createShare).not.toHaveBeenCalled();
});

test("匿名链接仅在明确确认后创建，重置替换链接，撤销恢复账号访问", async () => {
    render(dialog());
    fireEvent.click(await screen.findByRole("button", { name: "开启任何持链接的人可查看" }));
    expect(mocks.createShare).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByRole("button", { name: "启用只读链接" }));
    await waitFor(() => expect(screen.getByLabelText("匿名只读地址")).toHaveValue(`${window.location.origin}/s/new-token`));
    expect(screen.getByText("创建者：所有者甲")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "重置链接" }));
    expect(mocks.resetShare).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByRole("button", { name: /^重\s*置$/ }));
    await waitFor(() => expect(screen.getByLabelText("匿名只读地址")).toHaveValue(`${window.location.origin}/s/reset-token`));
    fireEvent.click(screen.getByRole("button", { name: "share.revoke" }));
    fireEvent.click(await screen.findByRole("button", { name: /^撤\s*销$/ }));
    await waitFor(() => expect(screen.queryByLabelText("匿名只读地址")).not.toBeInTheDocument());
    expect(screen.getByLabelText("画布账号访问地址")).toBeInTheDocument();
    expect(mocks.revokeShare).toHaveBeenCalledWith("canvas", "canvas-a");
});

test("成员权限按来源独立展示，继承权限不提供本地修改或移除", async () => {
    const member = { userId: "bob", username: "bob", displayName: "成员乙" };
    mocks.getCollaboration.mockResolvedValue(collaboration({ workspace: { id: "workspace-a", name: "团队" }, members: [
        { ...member, role: "editor", source: "workspace", status: "accepted" },
        { ...member, role: "viewer", source: "direct", status: "pending", invitedBy: owner },
    ] }));
    render(dialog());
    expect(await screen.findByText("工作区继承")).toBeInTheDocument();
    expect(screen.getByText("单独邀请 · 待接受 · 所有者甲 邀请")).toBeInTheDocument();
    expect(screen.getAllByLabelText("成员乙的权限")).toHaveLength(1);
    expect(screen.getAllByLabelText("移除成员乙的单独邀请")).toHaveLength(1);
    expect(screen.getByRole("link", { name: "团队 · 工作区权限" })).toHaveAttribute("href", "/user/workspaces?id=workspace-a");
});

test("非所有者可查看分享信息，但没有成员与匿名链接管理操作", async () => {
    mocks.getCollaboration.mockResolvedValue(collaboration({ canManage: false, share: share("existing") }));
    render(dialog());
    await screen.findByLabelText("匿名只读地址");
    expect(screen.queryByLabelText("受邀账号")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "重置链接" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "share.revoke" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "访问与权限记录" })).not.toBeInTheDocument();
});

test("切换画布时旧成员读取不能覆盖新画布", async () => {
    const old = deferred<CanvasCollaboration>();
    mocks.getCollaboration.mockImplementation((id: string) => id === "canvas-a" ? old.promise : Promise.resolve(collaboration({ owner: { ...owner, displayName: "新画布主人" } })));
    const view = render(dialog());
    view.rerender(dialog("canvas-b"));
    await screen.findByText("所有者：新画布主人 @alice");
    await act(async () => old.resolve(collaboration()));
    expect(screen.getByText("所有者：新画布主人 @alice")).toBeInTheDocument();
    expect(screen.getByLabelText("画布账号访问地址")).toHaveValue(`${window.location.origin}/canvas/canvas-b`);
    expect(screen.queryByText("所有者：所有者甲 @alice")).not.toBeInTheDocument();
});

test("关闭再打开同一画布时旧创建结果不能回填匿名链接", async () => {
    const old = deferred<{ share: ShareLink }>();
    mocks.createShare.mockReturnValue(old.promise);
    const view = render(dialog());
    fireEvent.click(await screen.findByRole("button", { name: "开启任何持链接的人可查看" }));
    fireEvent.click(await screen.findByRole("button", { name: "启用只读链接" }));
    await waitFor(() => expect(mocks.createShare).toHaveBeenCalledOnce());
    view.rerender(dialog("canvas-a", false));
    view.rerender(dialog());
    await screen.findByLabelText("画布账号访问地址");
    await act(async () => old.resolve({ share: share("old-result") }));
    expect(screen.queryByLabelText("匿名只读地址")).not.toBeInTheDocument();
});

test("切换账号后旧邀请响应不能触发当前账号的后续读取", async () => {
    const old = deferred<void>();
    mocks.invite.mockReturnValue(old.promise);
    const view = render(dialog());
    fireEvent.change(await screen.findByLabelText("受邀账号"), { target: { value: "bob" } });
    fireEvent.click(screen.getByRole("button", { name: /^邀\s*请$/ }));
    mocks.session.sessionVersion++;
    view.rerender(dialog());
    await waitFor(() => expect(mocks.getCollaboration).toHaveBeenCalledTimes(2));
    await act(async () => old.resolve());
    expect(mocks.getCollaboration).toHaveBeenCalledTimes(2);
    expect(screen.getByLabelText("受邀账号")).toHaveValue("");
});

test("邀请收件区接受后才跳转画布，拒绝后刷新列表", async () => {
    const view = render(inbox());
    await screen.findByText("受邀画布");
    fireEvent.click(screen.getByRole("button", { name: "接受并打开" }));
    await waitFor(() => expect(mocks.navigate).toHaveBeenCalledWith("/canvas/invited-canvas"));
    expect(mocks.respond).toHaveBeenCalledWith("invited-canvas", true);
    view.unmount();
    mocks.respond.mockClear();
    mocks.navigate.mockClear();
    render(inbox());
    await screen.findByText("受邀画布");
    mocks.invitations.mockResolvedValue([]);
    fireEvent.click(screen.getByRole("button", { name: /^拒\s*绝$/ }));
    await screen.findByText("暂无待处理的画布邀请");
    expect(mocks.respond).toHaveBeenCalledWith("invited-canvas", false);
    expect(mocks.navigate).not.toHaveBeenCalled();
});

test("后端邀请者已删除时仍可显示和处理邀请", async () => {
    mocks.invitations.mockResolvedValue([{ ...invitation, invitedBy: null }]);
    render(inbox());
    expect(await screen.findByText("原邀请者 邀请你 · 可查看 · 接受后生效")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "接受并打开" }));
    await waitFor(() => expect(mocks.navigate).toHaveBeenCalledWith("/canvas/invited-canvas"));
});

test("账号切换后旧邀请列表不能回填", async () => {
    const old = deferred<CanvasInvitation[]>();
    mocks.invitations.mockReturnValueOnce(old.promise).mockResolvedValue([]);
    const view = render(inbox());
    mocks.session.sessionVersion++;
    view.rerender(inbox());
    await screen.findByText("暂无待处理的画布邀请");
    await act(async () => old.resolve([invitation]));
    expect(screen.queryByText("受邀画布")).not.toBeInTheDocument();
});

test("账号切换后旧接受响应不跳转", async () => {
    const oldResponse = deferred<void>();
    mocks.respond.mockReturnValue(oldResponse.promise);
    const view = render(inbox());
    fireEvent.click(await screen.findByRole("button", { name: "接受并打开" }));
    mocks.session.sessionVersion++;
    mocks.invitations.mockResolvedValue([]);
    view.rerender(inbox());
    await screen.findByText("暂无待处理的画布邀请");
    await act(async () => oldResponse.resolve());
    expect(mocks.navigate).not.toHaveBeenCalled();
    expect(screen.queryByText("受邀画布")).not.toBeInTheDocument();
});

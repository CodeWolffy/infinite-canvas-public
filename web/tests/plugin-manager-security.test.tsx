import { webcrypto } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App, ConfigProvider } from "antd";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({ plugins: [] as any[], register: vi.fn(), imports: vi.fn() }));
vi.mock("@/stores/canvas/use-plugin-store", () => {
    const getState = () => ({ plugins: mocks.plugins, upsert: (record: any) => { mocks.plugins = [...mocks.plugins.filter((item) => item.id !== record.id), record]; } });
    return { usePluginStore: Object.assign((select: (state: ReturnType<typeof getState>) => unknown) => select(getState()), { getState }) };
});
vi.mock("@/stores/use-user-store", () => ({ useUserStore: { getState: () => ({ sessionVersion: 1, user: { id: "user-a" } }), subscribe: vi.fn() }, assertCurrentSession: vi.fn() }));
vi.mock("@/lib/canvas/node-registry", () => ({ registerNodeDefinitions: mocks.register, unregisterPluginNodes: vi.fn() }));
vi.mock("@/lib/canvas/plugin-runtime", () => ({ getPluginRuntime: () => ({ injectCSS: () => () => {} }) }));
vi.mock("@/lib/canvas/plugin-registry", () => ({ fetchOfficialPlugins: async () => [{ id: "official-list-item", name: "官方测试项", version: "1", url: "https://plugins.example/official.js", sha256: "0".repeat(64) }] }));
vi.mock("@/i18n", () => ({ default: { t: (key: string) => key } }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("@/stores/use-theme-store", () => ({ useThemeStore: (select: (state: { theme: string }) => unknown) => select({ theme: "light" }) }));
// 真实 UI 静态导入，冷加载不占用交互时限；加载器测试单独保留模块重置隔离。
import { CanvasPluginManagerModal } from "@/components/canvas/canvas-plugin-manager-modal";

beforeEach(() => {
    vi.clearAllMocks(); mocks.plugins = [];
    const fixture = resolve(process.cwd(), "tests/fixtures/approved-plugin.ts");
    const source = readFileSync(fixture, "utf8");
    vi.stubGlobal("crypto", webcrypto);
    vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false, addListener: vi.fn(), removeListener: vi.fn() })));
    vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
    const NativeURL = URL;
    vi.stubGlobal("URL", class extends NativeURL {
        static createObjectURL = mocks.imports.mockImplementation(() => pathToFileURL(fixture).href);
        static revokeObjectURL = vi.fn();
    });
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, text: async () => source })));
    const getStyle = window.getComputedStyle;
    vi.spyOn(window, "getComputedStyle").mockImplementation((element) => getStyle(element));
    // jsdom 不播放动画，测试仅验证授权流程。
    render(<ConfigProvider theme={{ token: { motion: false } }}><App><CanvasPluginManagerModal open onClose={vi.fn()} /></App></ConfigProvider>);
});

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); delete (globalThis as any).__approvedPluginExecutions; });

async function openThirdPartyInstall() {
    const user = userEvent.setup();
    await user.click(screen.getByRole("tab", { name: "canvas.plugins.thirdParty" }));
    await user.click(screen.getByPlaceholderText("canvas.plugins.urlPlaceholder"));
    await user.paste("https://plugins.example/plugin.js");
    await user.click(screen.getByRole("button", { name: "canvas.plugins.install", exact: true }));
    expect((await screen.findAllByText("确认插件来源与权限")).length).toBeGreaterThan(0);
    expect(screen.getByText(/来源：https:\/\/plugins.example/)).toBeInTheDocument();
    expect(screen.getByText(/可读取页面与画布内容/)).toBeInTheDocument();
    expect(mocks.imports).not.toHaveBeenCalled();
    return user;
}

test("真实插件管理弹窗展示来源与权限，取消不执行", async () => {
    const user = await openThirdPartyInstall();
    await user.click(screen.getByRole("button", { name: /取\s*消/ }));
    await waitFor(() => expect(screen.getByRole("button", { name: "canvas.plugins.install", exact: true })).not.toHaveClass("ant-btn-loading"));
    expect(mocks.plugins).toHaveLength(0);
    expect(mocks.imports).not.toHaveBeenCalled();
    expect(mocks.register).not.toHaveBeenCalled();
});

test("真实插件管理弹窗仅在明确同意后执行插件", async () => {
    const user = await openThirdPartyInstall();
    const confirm = await screen.findByRole("button", { name: "信任此版本并执行" });
    expect(mocks.imports).not.toHaveBeenCalled();
    await user.click(confirm);
    await waitFor(() => expect(mocks.plugins).toHaveLength(1));
    expect(mocks.imports).toHaveBeenCalledTimes(1);
    expect(mocks.register).toHaveBeenCalledTimes(1);
    expect(mocks.plugins[0].approval.url).toBe("https://plugins.example/plugin.js");
});

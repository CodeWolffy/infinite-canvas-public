import { webcrypto } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({ session: 1, plugins: [] as any[], source: "", official: [] as any[], register: vi.fn(), subscribe: vi.fn(), imports: vi.fn() }));
const store = {
    getState: () => ({ plugins: mocks.plugins, upsert: (record: any) => { mocks.plugins = [...mocks.plugins.filter((item) => item.id !== record.id), record]; }, setEnabled: (id: string, enabled: boolean) => { const record = mocks.plugins.find((item) => item.id === id); if (record) record.enabled = enabled; }, remove: (id: string) => { mocks.plugins = mocks.plugins.filter((record) => record.id !== id); } }),
    setState: (update: any) => { const next = typeof update === "function" ? update({ plugins: mocks.plugins }) : update; mocks.plugins = next.plugins; },
    persist: { rehydrate: async () => {} },
};
vi.mock("@/stores/canvas/use-plugin-store", () => ({ usePluginStore: Object.assign((select: (state: ReturnType<typeof store.getState>) => unknown) => select(store.getState()), store) }));
vi.mock("@/stores/use-user-store", () => ({ useUserStore: { getState: () => ({ sessionVersion: mocks.session, user: { id: "user-a" } }), subscribe: mocks.subscribe }, assertCurrentSession: (version: number) => { if (version !== mocks.session) throw new Error("会话已变更"); } }));
vi.mock("@/lib/canvas/node-registry", () => ({ registerNodeDefinitions: mocks.register, unregisterPluginNodes: vi.fn() }));
vi.mock("@/lib/canvas/plugin-runtime", () => ({ getPluginRuntime: () => ({ injectCSS: () => () => {} }) }));
vi.mock("@/lib/canvas/plugin-registry", () => ({ fetchOfficialPlugins: async () => mocks.official }));
vi.mock("@/i18n", () => ({ default: { t: (key: string) => key } }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("@/stores/use-theme-store", () => ({ useThemeStore: (select: (state: { theme: string }) => unknown) => select({ theme: "light" }) }));

let loader: typeof import("@/lib/canvas/plugin-loader");
let sourceTools: typeof import("@/lib/canvas/plugin-source");
beforeEach(async () => {
    vi.resetModules(); vi.clearAllMocks(); mocks.plugins = []; mocks.official = []; mocks.session = 1;
    const fixture = resolve(process.cwd(), "tests/fixtures/approved-plugin.ts");
    mocks.source = readFileSync(fixture, "utf8");
    vi.stubGlobal("crypto", webcrypto);
    vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false, addListener: vi.fn(), removeListener: vi.fn() })));
    vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
    const NativeURL = URL;
    vi.stubGlobal("URL", class extends NativeURL {
        static createObjectURL = mocks.imports.mockImplementation(() => pathToFileURL(fixture).href);
        static revokeObjectURL = vi.fn();
    });
    vi.stubGlobal("fetch", vi.fn(async (url: string) => ({ ok: true, status: 200, text: async () => mocks.source, json: async () => url === "/plugins/index.json" ? [] : {} })));
    loader = await import("@/lib/canvas/plugin-loader");
    sourceTools = await import("@/lib/canvas/plugin-source");
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); delete (globalThis as any).__approvedPluginExecutions; });

test("下载与指纹确认之前不执行模块；取消或摘要不符不执行", async () => {
    const prepared = await loader.preparePluginFromUrl("https://plugins.example/plugin.js");
    expect(mocks.imports).not.toHaveBeenCalled();
    expect(mocks.register).not.toHaveBeenCalled();
    expect(mocks.plugins).toHaveLength(0);
    await expect(loader.installPreparedPlugin(prepared, "wrong-hash")).rejects.toThrow("尚未确认");
    expect(mocks.imports).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledWith(prepared.url, expect.objectContaining({ redirect: "error", credentials: "omit" }));
});

test("确认当前版本后才执行，写入来源、摘要和用户授权", async () => {
    const prepared = await loader.preparePluginFromUrl("https://plugins.example/plugin.js");
    const plugin = await loader.installPreparedPlugin(prepared, prepared.sha256);
    expect(plugin.id).toBe("security-plugin");
    expect(mocks.imports).toHaveBeenCalledTimes(1);
    expect(mocks.register).toHaveBeenCalledTimes(1);
    expect(mocks.plugins[0].approval).toEqual({ url: prepared.url, sha256: prepared.sha256, userId: "user-a" });
});

test("官方包摘要错误、未授权缓存、跨账号和内容改变均阻止执行", async () => {
    const url = "https://plugins.example/official.js";
    mocks.official = [{ id: "security-plugin", version: "1.0.0", url, sha256: "0".repeat(64) }];
    await expect(loader.preparePluginFromUrl(url, { official: true })).rejects.toThrow("指纹");
    const record = { id: "security-plugin", name: "cached", version: "1", url, source: mocks.source, enabled: true };
    await expect(loader.setPluginEnabled(record as any, true)).rejects.toThrow("重新确认");
    const sha256 = await sourceTools.pluginSourceHash(mocks.source);
    await expect(loader.setPluginEnabled({ ...record, approval: { url, sha256, userId: "another-user" } } as any, true)).rejects.toThrow("重新确认");
    await expect(loader.setPluginEnabled({ ...record, source: `${mocks.source}\n//changed`, approval: { url, sha256, userId: "user-a" } } as any, true)).rejects.toThrow("重新确认");
    expect(mocks.imports).not.toHaveBeenCalled();
});

test("本地发现与启动恢复不会执行未批准的旧记录，发现后保持停用", async () => {
    mocks.plugins = [{ id: "old", url: "https://plugins.example/old.js", source: mocks.source, enabled: true }];
    vi.mocked(fetch).mockImplementation(async () => ({ ok: true, status: 200, json: async () => ["/plugins/local.js"], text: async () => mocks.source }) as Response);
    await loader.ensurePluginsLoaded();
    expect(mocks.plugins.find((record) => record.id === "old").enabled).toBe(false);
    expect(mocks.plugins.some((record) => record.id.startsWith("local:") && !record.enabled)).toBe(true);
    expect(mocks.imports).not.toHaveBeenCalled();
});

test("确认期间切换登录会话后不得执行或写入插件状态", async () => {
    const prepared = await loader.preparePluginFromUrl("https://plugins.example/plugin.js");
    mocks.session = 2;
    await expect(loader.installPreparedPlugin(prepared, prepared.sha256)).rejects.toThrow("会话");
    expect(mocks.plugins).toHaveLength(0);
    expect(mocks.imports).not.toHaveBeenCalled();
});

import { registerNodeDefinitions, unregisterPluginNodes } from "@/lib/canvas/node-registry";
import { getPluginRuntime } from "@/lib/canvas/plugin-runtime";
import { usePluginStore, type InstalledPlugin } from "@/stores/canvas/use-plugin-store";
import type { CanvasPlugin } from "@/types/canvas-plugin";
import i18n from "@/i18n";
import { fetchOfficialPlugins } from "@/lib/canvas/plugin-registry";
import { fetchPluginSource, normalizePluginUrl, pluginSourceHash } from "@/lib/canvas/plugin-source";
import { assertCurrentSession, useUserStore } from "@/stores/use-user-store";

const cleanups = new Map<string, () => void>();

// A remote plugin may export CanvasPlugin directly or a factory that receives runtime and returns CanvasPlugin.
// The factory uses runtime.React so the bundle does not need its own React copy.
async function evaluatePluginSource(source: string): Promise<CanvasPlugin> {
    const blob = new Blob([source], { type: "text/javascript" });
    const url = URL.createObjectURL(blob);
    try {
        const mod = (await import(/* @vite-ignore */ url)) as { default?: unknown; plugin?: unknown };
        const exported = mod.default ?? mod.plugin;
        const plugin = typeof exported === "function" ? (exported as (runtime: unknown) => unknown)(getPluginRuntime()) : exported;
        assertPlugin(plugin);
        return plugin;
    } finally {
        URL.revokeObjectURL(url);
    }
}

function assertPlugin(plugin: unknown): asserts plugin is CanvasPlugin {
    const value = plugin as Partial<CanvasPlugin> | null;
    if (!value || typeof value !== "object") throw new Error(i18n.t("canvas.pluginErrors.invalidExport"));
    if (!value.id || !Array.isArray(value.nodes) || !value.nodes.length) throw new Error(i18n.t("canvas.pluginErrors.missingFields"));
}

export function activatePlugin(plugin: CanvasPlugin) {
    registerNodeDefinitions(plugin.nodes, plugin.id);
    const runtime = getPluginRuntime();
    const disposers: Array<() => void> = [];
    // Inject declared styles when enabled and remove them when disabled or uninstalled.
    if (plugin.css) disposers.push(runtime.injectCSS(plugin.css, plugin.id));
    const cleanup = plugin.setup?.(runtime);
    if (typeof cleanup === "function") disposers.push(cleanup);
    if (disposers.length) cleanups.set(plugin.id, () => disposers.forEach((dispose) => dispose()));
}

export function deactivatePlugin(pluginId: string) {
    cleanups.get(pluginId)?.();
    cleanups.delete(pluginId);
    unregisterPluginNodes(pluginId);
}

type PluginSourceOptions = { official?: boolean; local?: boolean; expectedId?: string; replaceId?: string };
export type PreparedPlugin = Readonly<PluginSourceOptions & { url: string; source: string; sha256: string; sessionVersion: number; expectedVersion?: string }>;

async function prepareSource(url: string, source: string, sessionVersion: number, options: PluginSourceOptions): Promise<PreparedPlugin> {
    url = normalizePluginUrl(url);
    const sha256 = await pluginSourceHash(source);
    const official = options.official ? (await fetchOfficialPlugins()).find((entry) => entry.url === url && (!options.expectedId || entry.id === options.expectedId)) : undefined;
    assertCurrentSession(sessionVersion);
    if (options.official && (!official || official.sha256 !== sha256)) throw new Error("官方插件不在已固定的版本清单中，或包内容指纹不匹配");
    return Object.freeze({ ...options, url, source, sha256, sessionVersion, ...(official ? { expectedId: official.id, expectedVersion: official.version } : {}) });
}

// 准备阶段只下载和计算摘要，绝不 import 插件来读取元数据。
export async function preparePluginFromUrl(value: string, options: PluginSourceOptions = {}) {
    const sessionVersion = useUserStore.getState().sessionVersion;
    const url = normalizePluginUrl(value);
    const source = await fetchPluginSource(url);
    assertCurrentSession(sessionVersion);
    return prepareSource(url, source, sessionVersion, options);
}

export function prepareInstalledPlugin(record: InstalledPlugin) {
    return prepareSource(record.url, record.source, useUserStore.getState().sessionVersion, { official: record.official, local: record.local, expectedId: record.id.startsWith("local:") ? undefined : record.id, replaceId: record.id });
}

// 调用者必须在展示来源、内容指纹和页面权限后，提交用户确认的同一个摘要。
export async function installPreparedPlugin(prepared: PreparedPlugin, approvedHash: string) {
    assertCurrentSession(prepared.sessionVersion);
    if (approvedHash !== prepared.sha256 || await pluginSourceHash(prepared.source) !== approvedHash) throw new Error("插件内容尚未确认或已变更");
    assertCurrentSession(prepared.sessionVersion);
    const plugin = await evaluatePluginSource(prepared.source);
    assertCurrentSession(prepared.sessionVersion);
    if ((prepared.expectedId && plugin.id !== prepared.expectedId) || (prepared.expectedVersion && plugin.version !== prepared.expectedVersion)) throw new Error("插件标识或版本与已确认的来源不符");
    const existing = usePluginStore.getState().plugins.find((record) => record.id === plugin.id);
    if (existing && normalizePluginUrl(existing.url) !== prepared.url && !(existing.official && prepared.official)) throw new Error("同名插件来自其他来源，请先卸载后再安装");
    deactivatePlugin(plugin.id);
    if (prepared.replaceId && prepared.replaceId !== plugin.id) usePluginStore.getState().remove(prepared.replaceId);
    usePluginStore.getState().upsert({ id: plugin.id, name: plugin.name || plugin.id, version: plugin.version || "0.0.0", description: plugin.description, url: prepared.url, source: prepared.source, enabled: true, official: prepared.official, local: prepared.local, approval: { url: prepared.url, sha256: approvedHash, userId: useUserStore.getState().user?.id || "" } });
    activatePlugin(plugin);
    return plugin;
}

export async function setPluginEnabled(record: InstalledPlugin, enabled: boolean) {
    if (!enabled) {
        usePluginStore.getState().setEnabled(record.id, false);
        deactivatePlugin(record.id);
        return;
    }
    const prepared = await prepareInstalledPlugin(record);
    if (!record.approval || record.approval.userId !== (useUserStore.getState().user?.id || "") || record.approval.url !== prepared.url || record.approval.sha256 !== prepared.sha256) throw new Error("插件需要重新确认来源与页面权限");
    await installPreparedPlugin(prepared, record.approval.sha256);
}

export function uninstallPlugin(id: string) {
    deactivatePlugin(id);
    usePluginStore.getState().remove(id);
}

let loaded = false;

// Load installed and enabled plugins at application startup.
export async function ensurePluginsLoaded() {
    if (loaded) return;
    loaded = true;
    const sessionVersion = useUserStore.getState().sessionVersion;
    await usePluginStore.persist.rehydrate();
    if (sessionVersion !== useUserStore.getState().sessionVersion) { loaded = false; return; }
    await loadLocalPlugins();
    if (sessionVersion !== useUserStore.getState().sessionVersion) { loaded = false; return; }
    const records = usePluginStore.getState().plugins.filter((record) => record.enabled);
    await Promise.all(
        records.map(async (record) => {
            try {
                await setPluginEnabled(record, true);
            } catch (error) {
                if (sessionVersion !== useUserStore.getState().sessionVersion) return;
                usePluginStore.getState().setEnabled(record.id, false);
                console.error(`[plugin] Failed to load: ${record.id}`, error);
            }
        }),
    );
}

// 本地与开发目录只发现待确认来源，不执行模块，也不替换已批准的缓存版本。
async function loadLocalPlugins() {
    const sessionVersion = useUserStore.getState().sessionVersion;
    let urls: unknown = [];
    try {
        const response = await fetch("/plugins/index.json", { credentials: "omit", redirect: "error" });
        if (response.ok) urls = await response.json();
    } catch { /* 没有本地插件清单时仍可发现开发配置。 */ }
    const configured = import.meta.env.DEV ? (import.meta.env.VITE_DEV_PLUGINS || "").split(",").map((url) => url.trim()).filter(Boolean) : [];
    const discovered = [...(Array.isArray(urls) ? urls.filter((url): url is string => typeof url === "string" && url.startsWith("/plugins/") && !url.includes("..")) : []), ...configured];
    await Promise.all(
        discovered.map(async (value) => {
            try {
                const url = normalizePluginUrl(value);
                if (usePluginStore.getState().plugins.some((record) => normalizePluginUrl(record.url) === url)) return;
                const source = await fetchPluginSource(url);
                assertCurrentSession(sessionVersion);
                usePluginStore.getState().upsert({ id: `local:${url}`, name: new URL(url).pathname.split("/").pop() || url, version: "待确认", url, source, enabled: false, local: true });
            } catch (error) {
                console.error(`[plugin] Failed to discover local plugin: ${value}`, error);
            }
        }),
    );
}

useUserStore.subscribe((state, previous) => {
    if (state.sessionVersion === previous.sessionVersion) return;
    loaded = false;
    for (const record of usePluginStore.getState().plugins) deactivatePlugin(record.id);
    usePluginStore.setState((current) => ({ plugins: current.plugins.map((record) => ({ ...record, enabled: false })) }));
});

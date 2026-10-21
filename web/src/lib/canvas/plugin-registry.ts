import { PLUGIN_REGISTRY_URL, PLUGIN_REGISTRY_SHA256 } from "@/constant/env";
import { OFFICIAL_PLUGINS } from "@/constant/official-plugins";
import { fetchPluginSource, normalizePluginUrl, pluginSourceHash } from "@/lib/canvas/plugin-source";

// An official registry item whose entry has been resolved to an absolute URL.
export type OfficialPluginEntry = {
    id: string;
    name: string;
    version: string;
    description?: string;
    icon?: string;
    url: string;
    sha256: string;
};

type RawEntry = { id?: string; name?: string; version?: string; description?: string; icon?: string; entry?: string; url?: string; sha256?: string };
type RawManifest = { plugins?: RawEntry[] };

// Fetch the official registry and resolve relative entries against its URL for the existing URL installation flow.
export async function fetchOfficialPlugins(registryUrl: string = PLUGIN_REGISTRY_URL): Promise<OfficialPluginEntry[]> {
    if (!registryUrl) return OFFICIAL_PLUGINS;
    if (!/^[a-f0-9]{64}$/.test(PLUGIN_REGISTRY_SHA256)) throw new Error("自托管插件清单需配置 VITE_PLUGIN_REGISTRY_SHA256");
    const source = await fetchPluginSource(registryUrl);
    if (await pluginSourceHash(source) !== PLUGIN_REGISTRY_SHA256) throw new Error("插件清单内容指纹与部署配置不符，已拒绝加载");
    const data = JSON.parse(source) as RawManifest;
    const list = Array.isArray(data?.plugins) ? data.plugins : [];
    return list
        .filter((item): item is RawEntry & { id: string; sha256: string } => Boolean(item && item.id && (item.entry || item.url) && /^[a-f0-9]{64}$/.test(item.sha256 || "")))
        .map((item) => ({
            id: item.id,
            name: item.name || item.id,
            version: item.version || "0.0.0",
            description: item.description,
            icon: item.icon,
            url: normalizePluginUrl(new URL(item.url || (item.entry as string), normalizePluginUrl(registryUrl)).href),
            sha256: item.sha256,
        }));
}

// Compare semantic versions: positive means a is newer, negative means b is newer, and zero means equal.
// Compare numeric major.minor.patch components only and ignore non-numeric parts such as prerelease labels.
function compareSemver(a: string, b: string): number {
    const parse = (v: string) => v.split(".").map((part) => parseInt(part, 10) || 0);
    const [pa, pb] = [parse(a), parse(b)];
    for (let i = 0; i < 3; i++) {
        const diff = (pa[i] || 0) - (pb[i] || 0);
        if (diff !== 0) return diff;
    }
    return 0;
}

// Return whether the remote version is newer than the installed version.
export function hasUpgrade(installedVersion: string, remoteVersion: string): boolean {
    return compareSemver(remoteVersion, installedVersion) > 0;
}

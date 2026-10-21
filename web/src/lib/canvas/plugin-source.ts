export function normalizePluginUrl(value: string) {
    const url = new URL(value, window.location.origin);
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (url.username || url.password || url.hash || (url.protocol !== "https:" && !(url.protocol === "http:" && local))) throw new Error("插件来源必须使用 HTTPS，本机回环地址可使用 HTTP");
    return url.href;
}

export async function pluginSourceHash(source: string) {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(source));
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function fetchPluginSource(url: string) {
    const response = await fetch(normalizePluginUrl(url), { credentials: "omit", redirect: "error", cache: "no-cache" });
    if (!response.ok) throw new Error(`插件下载失败（${response.status}）`);
    return response.text();
}

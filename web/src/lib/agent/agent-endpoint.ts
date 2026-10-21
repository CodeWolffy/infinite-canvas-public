export function isLocalAgentEndpoint(endpoint: string) {
    try {
        return ["127.0.0.1", "localhost", "[::1]"].includes(new URL(endpoint).hostname);
    } catch {
        return false;
    }
}

export function normalizeAgentEndpoint(value: string) {
    const url = new URL(value.trim());
    if (url.username || url.password || url.search || url.hash || (url.protocol !== "https:" && !(url.protocol === "http:" && isLocalAgentEndpoint(url.href)))) {
        throw new Error("Agent 地址必须使用 HTTPS，本机回环地址可使用 HTTP；地址不能包含凭据、查询参数或片段");
    }
    return url.href.replace(/\/$/, "");
}

export function authReturnPath(value: unknown) {
    if (typeof value !== "string") return "/";
    try {
        const url = new URL(value, window.location.origin);
        if (url.origin !== window.location.origin || url.pathname === "/login" || url.pathname === "/change-password") return "/";
        return `${url.pathname}${url.search}${url.hash}`;
    } catch {
        return "/";
    }
}

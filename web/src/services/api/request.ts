import { assertCurrentSession, useUserStore } from "@/stores/use-user-store";

export type ApiParams = Record<string, string | string[] | number | number[] | undefined>;

export class ApiError extends Error {
    constructor(
        message: string,
        public readonly status: number,
        public readonly code?: string,
    ) {
        super(message);
        this.name = "ApiError";
    }
}

type ApiRequestOptions = Omit<RequestInit, "body"> & {
    body?: unknown;
};

export async function apiRequest<T>(path: string, options: ApiRequestOptions = {}) {
    const sessionVersion = useUserStore.getState().sessionVersion;
    const headers = new Headers(options.headers);
    const body = options.body === undefined ? undefined : JSON.stringify(options.body);
    if (body) headers.set("Content-Type", "application/json");
    const response = await fetch(path, { ...options, body, headers, credentials: "include" });
    assertCurrentSession(sessionVersion);
    if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as { error?: string; message?: string } | null;
        assertCurrentSession(sessionVersion);
        if (response.status === 401) window.dispatchEvent(new Event("auth:unauthorized"));
        if (payload?.error === "password_change_required") window.dispatchEvent(new Event("auth:password-change-required"));
        throw new ApiError(payload?.message || `请求失败（HTTP ${response.status}）`, response.status, payload?.error);
    }
    if (response.status === 204) return undefined as T;
    const result = (await response.json()) as T;
    assertCurrentSession(sessionVersion);
    return result;
}

export function compactApiParams(params: ApiParams) {
    return Object.fromEntries(Object.entries(params).filter(([, value]) => value !== "" && value !== undefined && (!Array.isArray(value) || value.length > 0))) as ApiParams;
}

export function serializeApiParams(params?: ApiParams) {
    const queryParams = new URLSearchParams();
    for (const [key, value] of Object.entries(params || {})) {
        if (value === undefined) continue;
        if (Array.isArray(value)) value.forEach((item) => queryParams.append(key, String(item)));
        else queryParams.set(key, String(value));
    }
    return queryParams;
}

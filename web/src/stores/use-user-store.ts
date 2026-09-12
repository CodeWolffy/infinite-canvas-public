import { create } from "zustand";

import * as authApi from "@/services/api/auth";
import type { AuthUser, MfaChallenge } from "@/services/api/auth";
import { updateUserProfile } from "@/services/api/user-center";
import { ApiError } from "@/services/api/request";

type UserStore = {
    user: AuthUser | null;
    sessionVersion: number;
    status: "idle" | "loading" | "authenticated" | "unauthenticated" | "error";
    error: string;
    initialize: () => Promise<void>;
    login: (input: { username: string; password: string }) => Promise<AuthUser | MfaChallenge>;
    completeMfa: (input: { challenge: string; code: string }) => Promise<AuthUser>;
    register: (input: { username: string; displayName: string; password: string; invitationCode: string; referralCode?: string }) => Promise<AuthUser>;
    changePassword: (input: { currentPassword: string; newPassword: string }) => Promise<AuthUser>;
    updateDisplayName: (displayName: string) => Promise<AuthUser>;
    logout: () => Promise<void>;
    clearSession: () => void;
    requirePasswordChange: () => void;
};

export const useUserStore = create<UserStore>()((set, get) => ({
    user: null,
    sessionVersion: 0,
    status: "idle",
    error: "",
    initialize: async () => {
        // 允许从 error 重新进入，否则启动时一次网络抖动就把用户永久踢到登录页。
        if (get().status !== "idle" && get().status !== "error") return;
        const sessionVersion = get().sessionVersion;
        set({ status: "loading", error: "" });
        try {
            const user = await authApi.getCurrentUser();
            if (get().sessionVersion !== sessionVersion) return;
            set({ user, status: "authenticated", sessionVersion: sessionVersion + 1 });
        } catch (error) {
            if (get().sessionVersion !== sessionVersion) return;
            if (error instanceof ApiError && error.status === 401) invalidateSession();
            else set({ user: null, status: "error", error: error instanceof Error ? error.message : "无法连接到服务" });
        }
    },
    login: async (input) => {
        const sessionVersion = get().sessionVersion;
        const user = await authApi.login(input);
        assertCurrentSession(sessionVersion);
        if ("mfaRequired" in user) return user;
        set({ user, status: "authenticated", error: "", sessionVersion: sessionVersion + 1 });
        authChannel?.postMessage("session-changed");
        return user;
    },
    completeMfa: async (input) => {
        const sessionVersion = get().sessionVersion;
        const user = await authApi.completeMfa(input);
        assertCurrentSession(sessionVersion);
        set({ user, status: "authenticated", error: "", sessionVersion: sessionVersion + 1 });
        authChannel?.postMessage("session-changed");
        return user;
    },
    register: async (input) => {
        const sessionVersion = get().sessionVersion;
        const user = await authApi.register(input);
        assertCurrentSession(sessionVersion);
        set({ user, status: "authenticated", error: "", sessionVersion: sessionVersion + 1 });
        authChannel?.postMessage("session-changed");
        return user;
    },
    changePassword: async (input) => {
        const sessionVersion = get().sessionVersion;
        const user = await authApi.changePassword(input);
        assertCurrentSession(sessionVersion);
        set({ user, status: "authenticated", error: "", sessionVersion: sessionVersion + 1 });
        authChannel?.postMessage("session-changed");
        return user;
    },
    updateDisplayName: async (displayName) => {
        const sessionVersion = get().sessionVersion;
        const user = await updateUserProfile({ displayName });
        assertCurrentSession(sessionVersion);
        set({ user });
        return user;
    },
    logout: async () => {
        const sessionVersion = get().sessionVersion;
        try {
            await authApi.logout();
        } finally {
            if (get().sessionVersion === sessionVersion) get().clearSession();
        }
    },
    clearSession: () => {
        invalidateSession();
        authChannel?.postMessage("session-changed");
    },
    requirePasswordChange: () => set((state) => ({ user: state.user ? { ...state.user, mustChangePassword: true } : null })),
}));

export function assertCurrentSession(version: number) {
    if (useUserStore.getState().sessionVersion !== version) throw new DOMException("登录会话已变更", "AbortError");
}

function invalidateSession() {
    useUserStore.setState((state) => ({ user: null, status: "unauthenticated", error: "", sessionVersion: state.sessionVersion + 1 }));
}

// Cookie is shared by tabs; invalidate their cached private data when it changes.
const authChannel = typeof window === "undefined" ? null : new BroadcastChannel("infinite-canvas:auth");
if (authChannel) authChannel.onmessage = invalidateSession;

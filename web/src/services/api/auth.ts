import { apiRequest } from "@/services/api/request";

export type UserRole = "admin" | "user";
export type UserStatus = "active" | "disabled";

export type AuthUser = {
    id: string;
    username: string;
    displayName: string;
    role: UserRole;
    status: UserStatus;
    mustChangePassword: boolean;
    lastLoginAt: string | null;
    createdAt: string;
    groupId?: string | null;
    groupName?: string | null;
};

type UserResponse = { user: AuthUser };
export type MfaChallenge = { mfaRequired: true; challenge: string };

export async function register(input: { username: string; displayName: string; password: string; invitationCode: string; referralCode?: string }) {
    return (await apiRequest<UserResponse>("/api/auth/register", { method: "POST", body: input })).user;
}

export async function login(input: { username: string; password: string }) {
    const result = await apiRequest<UserResponse | MfaChallenge>("/api/auth/login", { method: "POST", body: input });
    return "mfaRequired" in result ? result : result.user;
}

export async function completeMfa(input: { challenge: string; code: string }) {
    return (await apiRequest<UserResponse>("/api/auth/mfa", { method: "POST", body: input })).user;
}

export async function getCurrentUser() {
    return (await apiRequest<UserResponse>("/api/auth/me")).user;
}

export async function changePassword(input: { currentPassword: string; newPassword: string }) {
    return (await apiRequest<UserResponse>("/api/auth/change-password", { method: "POST", body: input })).user;
}

export async function logout() {
    await apiRequest<void>("/api/auth/logout", { method: "POST" });
}

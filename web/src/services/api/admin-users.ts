import type { AuthUser, UserRole, UserStatus } from "@/services/api/auth";
import { apiRequest } from "@/services/api/request";

type UserResponse = { user: AuthUser };

export async function getAdminUsers() {
    return (await apiRequest<{ users: AuthUser[] }>("/api/admin/users")).users;
}

export async function createAdminUser(input: { username: string; displayName: string; temporaryPassword: string; role: UserRole }) {
    return (await apiRequest<UserResponse>("/api/admin/users", { method: "POST", body: input })).user;
}

export async function updateAdminUserStatus(id: string, status: UserStatus) {
    return (await apiRequest<UserResponse>(`/api/admin/users/${id}/status`, { method: "PATCH", body: { status } })).user;
}

export async function updateAdminUserRole(id: string, role: UserRole) {
    return (await apiRequest<UserResponse>(`/api/admin/users/${id}/role`, { method: "PATCH", body: { role } })).user;
}

export async function resetAdminUserPassword(id: string, temporaryPassword: string) {
    return (await apiRequest<UserResponse>(`/api/admin/users/${id}/reset-password`, { method: "POST", body: { temporaryPassword } })).user;
}

import { apiRequest, serializeApiParams } from "./request";

export type SecurityProof = { password: string; code?: string };
export type AccountSecurity = { email: string | null; emailVerifiedAt: string | null; mfaEnabled: boolean; recoveryAvailable: boolean };
export type LoginSession = { id: string; ip: string; userAgent: string; createdAt: string; expiresAt: string; current: boolean };
export const getAccountSecurity = () => apiRequest<{ security: AccountSecurity }>("/api/user/security");
export const getLoginSessions = () => apiRequest<{ sessions: LoginSession[] }>("/api/user/security/sessions");
export const revokeLoginSession = (id: string) => apiRequest<{ current: boolean }>(`/api/user/security/sessions/${id}`, { method: "DELETE" });
export const revokeOtherSessions = () => apiRequest<void>("/api/user/security/sessions/revoke-others", { method: "POST" });
export const bindEmail = (input: SecurityProof & { email: string }) => apiRequest<{ message: string }>("/api/user/security/email", { method: "POST", body: input });
export const setupMfa = (input: SecurityProof) => apiRequest<{ secret: string; uri: string }>("/api/user/security/mfa/setup", { method: "POST", body: input });
export const enableMfa = (code: string) => apiRequest<{ recoveryCode: string }>("/api/user/security/mfa/enable", { method: "POST", body: { code } });
export const disableMfa = (input: SecurityProof) => apiRequest<void>("/api/user/security/mfa/disable", { method: "POST", body: input });
export const requestPasswordReset = (email: string) => apiRequest<{ message: string }>("/api/auth/password-reset", { method: "POST", body: { email } });
export const completePasswordReset = (token: string, password: string) => apiRequest<{ message: string }>("/api/auth/password-reset/complete", { method: "POST", body: { token, password } });
export const verifyEmail = (token: string) => apiRequest<{ message: string }>("/api/auth/email/verify", { method: "POST", body: { token } });

export type MailSettings = { host: string; port: number; mode: "tls" | "starttls"; username: string; password: string; from: string; enabled: boolean };
export const getMailSettings = () => apiRequest<{ settings: MailSettings; passwordConfigured: boolean }>("/api/admin/mail-settings");
export const saveMailSettings = (body: MailSettings) => apiRequest<void>("/api/admin/mail-settings", { method: "PUT", body });
export const getMailDeliveries = () => apiRequest<{ deliveries: Array<{ id: string; status: string; createdAt: string; finishedAt: string | null }> }>("/api/admin/mail-deliveries");
export type PlatformNotification = { id: string; kind: string; title: string; content: string; createdAt: string; read: boolean };
export const getNotifications = () => apiRequest<{ notifications: PlatformNotification[] }>("/api/user/notifications");
export const readNotification = (id: string) => apiRequest<void>(`/api/user/notifications/${id}/read`, { method: "POST" });
export const readAllNotifications = () => apiRequest<void>("/api/user/notifications/read-all", { method: "POST" });

export type GroupPolicy = { modelIds: string[] | null; grantAmount: string; grantPeriod: "day" | "week" | "month"; spendLimit: string; spendPeriod: "day" | "week" | "month"; storageQuotaBytes: number };
export const saveGroupPolicy = (id: string, body: GroupPolicy) => apiRequest<void>(`/api/admin/user-groups/${id}/policy`, { method: "PUT", body });
export const getGroupGrant = () => apiRequest<{ grant: { groupId: string; groupName: string; amount: string; period: GroupPolicy["grantPeriod"]; periodStart: string; claimed: boolean } | null }>("/api/user/group-grant");
export const claimGroupGrant = () => apiRequest<{ amount: string; alreadyClaimed: boolean }>("/api/user/group-grant/claim", { method: "POST" });
export const getSensitiveEvents = () => apiRequest<{ events: Array<{ id: string; username: string; detail: { pattern: string; action: "block" | "review" }; createdAt: string }> }>("/api/admin/sensitive-events");

export type MonitoringConfig = { intervalMinutes: number; bindingIds: string[]; prompt: string; parameters: Record<string, unknown>; checkModels: boolean; balanceThreshold: string | null };
export const saveMonitoring = (id: string, body: MonitoringConfig) => apiRequest<void>(`/api/admin/channels/${id}/monitoring`, { method: "PUT", body });
export const checkChannel = (id: string) => apiRequest<{ queued: boolean }>(`/api/admin/channels/${id}/check`, { method: "POST" });
export const checkAllChannels = () => apiRequest<{ queued: number }>("/api/admin/channels/check-all", { method: "POST" });
export const getChannelChecks = (id: string) => apiRequest<{ checks: Array<{ id: string; status: string; detail: Record<string, unknown>; durationMs: number; createdAt: string }> }>(`/api/admin/channels/${id}/checks`);
export const getChannelBindings = (id: string) => apiRequest<{ models: Array<{ id: string; modelId: string; displayName: string; capability: string; upstreamModel: string }> }>(`/api/admin/channels/${id}/bindings`);
export const acknowledgeModelChanges = (id: string) => apiRequest<void>(`/api/admin/channels/${id}/model-changes/ack`, { method: "POST" });

export type CostConfig = Partial<Record<"fixed" | "input" | "cached" | "output" | "second", string>>;
export const saveChannelCost = (modelId: string, channelId: string, body: CostConfig) => apiRequest<void>(`/api/admin/models/${modelId}/channels/${channelId}/cost`, { method: "PUT", body });
export const saveBindingCost = (modelId: string, bindingId: string, body: CostConfig) => apiRequest<void>(`/api/admin/models/${modelId}/bindings/${bindingId}/cost`, { method: "PUT", body });
export type CostEntry = { id: string; taskId: string | null; modelName: string; channelName: string; username: string | null; capability: string; amount?: string; userPaid: string; source: "unknown" | "configured" | "actual"; status: string; note: string; createdAt: string };
export const getCosts = (offset = 0, params: { from?: string; to?: string; source?: string; modelId?: string; channelId?: string } = {}) => apiRequest<{ totals: { knownCost: string; userPaid: string; subsidy: string; grants: string; unknownCount: number; reconciledCount: number }; entries: CostEntry[] }>(`/api/admin/costs?${serializeApiParams({ offset, limit: 50, ...params })}`);
export const getAdminStatus = () => apiRequest<{ startedAt: string; workerConcurrency: number; database: boolean; redis: boolean; storage: boolean; queue: { queued: number; running: number }; mail: { queued: number; sending: number; failed: number }; channels: { active: number; cooling: number; monitorFailed: number; checking: number } }>("/api/admin/status");
export const reconcileCost = (id: string, body: { amount: string; note: string }) => apiRequest<void>(`/api/admin/costs/${id}`, { method: "PUT", body });

export type GenerationQuote = { pricingKind: "fixed" | "token"; estimatedHold: string; unitHold: string; seconds: string | null; groupDiscount: string; variable: boolean };
export const quoteGeneration = (body: { modelId: string; count: number; content: string; conversationId?: string; systemPrompt?: string; parameters?: Record<string, unknown> }, signal?: AbortSignal) => apiRequest<{ quote: GenerationQuote }>("/api/generation-quote", { method: "POST", body, signal });

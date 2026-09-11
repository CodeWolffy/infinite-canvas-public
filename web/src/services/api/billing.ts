import { apiRequest, serializeApiParams } from "./request";

export type PaymentMethod = "alipay" | "wxpay";
export type PaymentProvider = "epay" | "alipay" | "wechat";
export type PaymentChannel = { id: string; name: string; provider: PaymentProvider; methods: PaymentMethod[]; enabled: boolean; config: Record<string, string>; configuredSecrets: string[] };
export type PaymentOrder = { id: string; channelId: string; provider: PaymentProvider; method: PaymentMethod; amount: string; status: "pending" | "paid" | "closed"; paymentUrl?: string; expiresAt: string; paidAt: string | null; createdAt: string; username?: string; tradeNo?: string };
export type WalletEntry = { id: string; userId: string; username?: string; kind: string; reference: string; deltaBalance: string; deltaFrozen: string; balanceAfter: string; frozenAfter: string; note: string; createdAt: string };
export type WalletOverview = { wallet: { balance: string; frozen: string }; checkin: { enabled: boolean; day: string; checkedIn: boolean; rewardMin: string; rewardMax: string; timezone: string }; paymentChannels: Pick<PaymentChannel, "id" | "name" | "provider" | "methods">[]; summary?: { spent: string; recharge: string; grants: string; checkin: string; adjustment: string; spendLimit?: string; spendPeriod?: "day" | "week" | "month"; periodSpent?: string; periodFrozen?: string } };
export type PlatformSettings = { generationEnabled: boolean; checkinEnabled: boolean; rewardMin: string; rewardMax: string; userRPM: number; ipRPM: number; activeTasks: number; paymentOrderMinutes: number };
export type Invitation = { id: string; codeHint: string; note: string; maxUses: number; usedCount: number; expiresAt: string | null; disabled: boolean; createdAt: string };

export const paymentMethodLabels: Record<PaymentMethod, string> = { alipay: "支付宝", wxpay: "微信支付" };
export const paymentProviderLabels: Record<PaymentProvider, string> = { epay: "易支付兼容", alipay: "支付宝官方", wechat: "微信支付官方" };
export const walletEntryLabels: Record<string, string> = { recharge: "充值到账", checkin: "签到奖励", grant: "周期公益额度", hold: "生成冻结", charge: "生成结算", release: "余额退回", adjustment: "管理员调整" };

export const getWallet = () => apiRequest<WalletOverview>("/api/user/wallet");
export const checkin = () => apiRequest<{ reward: string; alreadyCheckedIn: boolean }>("/api/user/checkin", { method: "POST", body: {} });
export const getWalletEntries = (offset = 0, params: { kind?: string; from?: string; to?: string } = {}) => apiRequest<{ entries: WalletEntry[]; total: number }>(`/api/user/wallet/entries?${serializeApiParams({ limit: 50, offset, ...params })}`);
export const getPaymentOrders = (offset = 0) => apiRequest<{ orders: PaymentOrder[] }>(`/api/user/payment-orders?limit=50&offset=${offset}`);
export const createPaymentOrder = (body: { channelId: string; method: PaymentMethod; amount: string; requestId: string }) => apiRequest<{ order: PaymentOrder }>("/api/user/payment-orders", { method: "POST", body });
export const getPaymentOrder = (id: string) => apiRequest<{ order: PaymentOrder }>(`/api/user/payment-orders/${id}`);
export const refreshPaymentOrder = (id: string) => apiRequest<{ order: PaymentOrder }>(`/api/user/payment-orders/${id}/refresh`, { method: "POST", body: {} });
export const getPaymentChannels = () => apiRequest<{ channels: PaymentChannel[] }>("/api/admin/payment-channels");
export const savePaymentChannel = (id: string | undefined, body: Omit<PaymentChannel, "id" | "configuredSecrets">) => apiRequest<{ id: string }>(`/api/admin/payment-channels${id ? `/${id}` : ""}`, { method: id ? "PUT" : "POST", body });
export const getAdminPaymentOrders = (status = "", offset = 0) => apiRequest<{ orders: PaymentOrder[] }>(`/api/admin/payment-orders?${serializeApiParams({ status, offset, limit: 50 })}`);
export const reconcilePaymentOrder = (id: string) => apiRequest<void>(`/api/admin/payment-orders/${id}/reconcile`, { method: "POST", body: {} });
export const getAdminWalletEntries = (userId = "", offset = 0) => apiRequest<{ entries: WalletEntry[] }>(`/api/admin/wallet-entries?${serializeApiParams({ userId, offset, limit: 50 })}`);
export const adjustBalance = (id: string, body: { amount: string; note: string; requestId: string }) => apiRequest<void>(`/api/admin/users/${id}/balance`, { method: "POST", body });
export const getPlatformSettings = () => apiRequest<{ settings: PlatformSettings }>("/api/admin/platform-settings");
export const savePlatformSettings = (body: PlatformSettings) => apiRequest<{ settings: PlatformSettings }>("/api/admin/platform-settings", { method: "PUT", body });
export const getInvitations = (offset = 0) => apiRequest<{ invitations: Invitation[] }>(`/api/admin/invitations?limit=50&offset=${offset}`);
export const createInvitation = (body: { note: string; maxUses: number; expiresAt?: string }) => apiRequest<{ invitation: Invitation; code: string }>("/api/admin/invitations", { method: "POST", body });
export const setInvitationDisabled = (id: string, disabled: boolean) => apiRequest<void>(`/api/admin/invitations/${id}`, { method: "PATCH", body: { disabled } });
export const getAuditLogs = (offset = 0) => apiRequest<{ logs: Array<{ id: string; username: string; action: string; target: string; detail: Record<string, unknown>; createdAt: string }> }>(`/api/admin/audit-logs?limit=50&offset=${offset}`);

export type UserGroup = { id: string; name: string; discount: string; createdAt: string; memberCount: number; modelIds?: string[] | null; grantAmount?: string; grantPeriod?: "day" | "week" | "month"; spendLimit?: string; spendPeriod?: "day" | "week" | "month"; storageQuotaBytes?: number };
export type RedeemCode = { id: string; codeHint: string; note: string; amount: string; maxUses: number; usedCount: number; expiresAt: string | null; disabled: boolean; createdAt: string };
export type SensitiveWord = { id: string; pattern: string; action: "block" | "review"; createdAt: string };

export const getUserGroups = () => apiRequest<{ groups: UserGroup[] }>("/api/admin/user-groups");
export const createUserGroup = (body: { name: string; discount: string }) => apiRequest<{ group: UserGroup }>("/api/admin/user-groups", { method: "POST", body });
export const updateUserGroup = (id: string, body: { name: string; discount: string }) => apiRequest<{ group: UserGroup }>(`/api/admin/user-groups/${id}`, { method: "PUT", body });
export const deleteUserGroup = (id: string) => apiRequest<void>(`/api/admin/user-groups/${id}`, { method: "DELETE" });
export const setUserGroup = (id: string, groupId: string | null) => apiRequest<void>(`/api/admin/users/${id}/group`, { method: "PATCH", body: { groupId } });
export const getRedeemCodes = (offset = 0) => apiRequest<{ codes: RedeemCode[] }>(`/api/admin/redeem-codes?limit=50&offset=${offset}`);
export const createRedeemCode = (body: { note: string; amount: string; maxUses: number; count?: number; expiresAt?: string }) => apiRequest<{ code: RedeemCode; secret: string; codes?: RedeemCode[]; secrets?: string[] }>("/api/admin/redeem-codes", { method: "POST", body });
export const setRedeemCodeDisabled = (id: string, disabled: boolean) => apiRequest<void>(`/api/admin/redeem-codes/${id}`, { method: "PATCH", body: { disabled } });
export const getSensitiveWords = () => apiRequest<{ words: SensitiveWord[] }>("/api/admin/sensitive-words");
export const saveSensitiveWord = (body: { pattern: string; action: "block" | "review" }) => apiRequest<{ word: SensitiveWord }>("/api/admin/sensitive-words", { method: "POST", body });
export const deleteSensitiveWord = (id: string) => apiRequest<void>(`/api/admin/sensitive-words/${id}`, { method: "DELETE" });
export const queryChannelBalance = (id: string) => apiRequest<{ balance?: number; quota?: number; used?: number }>(`/api/admin/channels/${id}/balance`, { method: "POST", body: {} });
export const redeemCode = (code: string) => apiRequest<{ amount: string; alreadyRedeemed: boolean }>("/api/user/redeem", { method: "POST", body: { code } });

import { apiRequest } from "./request";

export type TaskBillingAttempt = { run: number; estimated: string; charged: string | null; refunded: string; additional: string; settled: boolean; createdAt: string; updatedAt: string };
export type TaskBilling = { taskId: string; status: string; current: TaskBillingAttempt | null; attempts: TaskBillingAttempt[]; totalCharged: string };

export const getTaskBilling = (id: string, signal?: AbortSignal) => apiRequest<TaskBilling>(`/api/generation-tasks/${id}/billing`, { signal });

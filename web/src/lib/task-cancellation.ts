import type { TaskCancellation } from "@/services/api/tasks";
import { formatMoney } from "./format-money";

export function taskCancellationMessage(result: TaskCancellation) {
    if (result.canceled) return Number(result.refunded) > 0 ? `任务已取消，已退回 ${formatMoney(result.refunded)}` : "任务已取消，本次未收费";
    if (result.status === "succeeded") return "任务已完成，未执行取消";
    if (result.status === "failed") return "任务已失败，无需取消";
    if (result.status === "canceled") return "任务此前已取消";
    return "任务状态已变化，请刷新查看";
}

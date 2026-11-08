import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button, Popover, Spin } from "antd";
import { getTaskBilling } from "@/services/api/task-billing";
import { useUserStore } from "@/stores/use-user-store";
import { formatMoney } from "@/lib/format-money";

export function TaskBillingButton({ taskId }: { taskId: string }) {
    const session = useUserStore((state) => state.sessionVersion);
    const [openFor, setOpenFor] = useState("");
    const scope = `${session}:${taskId}`;
    const open = openFor === scope;
    const billing = useQuery({ queryKey: ["task-billing", session, taskId], queryFn: ({ signal }) => getTaskBilling(taskId, signal), enabled: open });
    const current = billing.data?.current;
    return <Popover key={scope} trigger="click" open={open} onOpenChange={(next) => setOpenFor(next ? scope : "")} content={<div className="w-72 max-w-[calc(100vw-48px)] space-y-3 text-sm" aria-label="生成费用详情">
        <div className="flex items-center justify-between"><span className="font-medium">生成费用</span><Button type="text" size="small" loading={billing.isFetching} onClick={() => void billing.refetch()}>刷新</Button></div>
        {billing.error ? <p role="alert">费用暂时无法读取，请刷新重试。</p> : billing.isPending ? <Spin size="small" /> : current ? <>
            <div className="flex items-baseline justify-between gap-3"><span>{current.settled ? "本次消费" : "预计消费"}</span><span className="font-mono text-xl">{formatMoney(current.settled ? current.charged : current.estimated)}</span></div>
            {Number(current.refunded) > 0 ? <div className="flex justify-between text-xs text-muted-foreground"><span>退回余额</span><span className="font-mono">{formatMoney(current.refunded)}</span></div> : null}
            <p className="text-xs leading-5 text-muted-foreground">{!current.settled ? "完成后按实际用量计费，未使用金额会退回。" : current.charged == null ? "消费金额暂不可读取，请刷新核对。" : Number(current.additional) > 0 ? `实际用量超过预计，余额另扣 ${formatMoney(current.additional)}，已计入本次消费。` : Number(current.charged) === 0 ? "本次未收费。" : "已按实际用量计入消费。"}</p>
            {(billing.data?.attempts.length || 0) > 1 ? <details className="text-xs text-muted-foreground"><summary className="cursor-pointer">历史重试 · 累计消费 {formatMoney(billing.data?.totalCharged)}</summary><div className="mt-2 space-y-2">{billing.data!.attempts.filter((item) => item.run !== current.run).map((item) => <div key={item.run} className="flex justify-between gap-3"><span>{item.run === 1 ? "首次生成" : `第 ${item.run - 1} 次重试`}</span><span>{item.settled ? `消费 ${formatMoney(item.charged)}` : "待结算"}{Number(item.refunded) > 0 ? ` · 退回 ${formatMoney(item.refunded)}` : ""}</span></div>)}</div></details> : null}
        </> : <p className="text-xs text-muted-foreground">该任务暂无可核对的费用记录。</p>}
    </div>}><Button type="text" size="small" className="!px-0 !text-xs" onClick={(event) => event.stopPropagation()}>费用详情</Button></Popover>;
}

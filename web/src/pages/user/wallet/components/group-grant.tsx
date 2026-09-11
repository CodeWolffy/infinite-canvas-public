import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, App, Button } from "antd";
import { Gift } from "lucide-react";

import { claimGroupGrant, getGroupGrant } from "@/services/api/platform-operations";
import { useUserStore } from "@/stores/use-user-store";

export default function GroupGrant() {
    const { message } = App.useApp();
    const client = useQueryClient();
    const session = useUserStore((state) => state.sessionVersion);
    const query = useQuery({ queryKey: ["group-grant", session], queryFn: getGroupGrant });
    const claim = useMutation({ mutationFn: claimGroupGrant, onSuccess: (result) => { void client.invalidateQueries({ queryKey: ["group-grant"] }); void client.invalidateQueries({ queryKey: ["wallet"] }); void client.invalidateQueries({ queryKey: ["wallet-entries"] }); message.success(result.alreadyClaimed ? "本周期已领取" : `已领取 ¥${result.amount}`); }, onError: (error: Error) => message.error(error.message) });
    const grant = query.data?.grant;
    if (query.error) return <Alert className="my-5" type="error" title={query.error.message} />;
    if (!grant) return null;
    return <section className="my-6 flex flex-wrap items-center justify-between gap-4 border-y border-border py-5"><div><h2 className="flex items-center gap-2 font-medium"><Gift className="size-4" />{grant.groupName} · 周期公益额度</h2><p className="mt-2 text-sm text-muted-foreground">{({ day: "每日", week: "每周", month: "每月" })[grant.period]}可领取 ¥{grant.amount}，北京时间计算，已领余额保留。</p></div><Button type="primary" disabled={grant.claimed} loading={claim.isPending} onClick={() => claim.mutate()}>{grant.claimed ? "本周期已领取" : "领取公益额度"}</Button></section>;
}

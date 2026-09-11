import { useQuery } from "@tanstack/react-query";
import { Alert, Button, Tag } from "antd";
import { Activity, Database, HardDrive, Mail, Server, Waypoints } from "lucide-react";

import { getAdminStatus } from "@/services/api/platform-operations";

export default function AdminStatusPage() {
    const query = useQuery({ queryKey: ["admin", "status"], queryFn: getAdminStatus, refetchInterval: 2500 });
    const data = query.data;
    const items = [
        { icon: Database, label: "PostgreSQL", ok: data?.database },
        { icon: Server, label: "Redis", ok: data?.redis },
        { icon: HardDrive, label: "对象存储", ok: data?.storage },
    ];
    return <div className="w-full px-5 py-8 lg:px-8">
        <div className="mb-7 flex flex-wrap items-end justify-between gap-4"><div><Activity className="mb-3 size-5 text-muted-foreground" /><h1 className="text-2xl font-semibold">平台状态</h1><p className="mt-2 text-sm text-muted-foreground">查看队列、邮件积压、渠道冷却和存储依赖，不替代用量统计。</p></div><Button onClick={() => void query.refetch()}>刷新</Button></div>
        {query.error ? <Alert className="mb-5" type="error" title={query.error.message} /> : null}
        <div className="grid gap-4 sm:grid-cols-3">{items.map(({ icon: Icon, label, ok }) => <div key={label} className="rounded-xl border border-border p-4"><div className="flex items-center gap-2 text-sm text-muted-foreground"><Icon className="size-4" />{label}</div><Tag className="mt-3" color={ok ? "green" : "red"}>{ok ? "可用" : "不可用"}</Tag></div>)}</div>
        <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Metric label="排队任务" value={data?.queue.queued ?? "—"} />
            <Metric label="运行中任务" value={data?.queue.running ?? "—"} />
            <Metric label="工作协程" value={data?.workerConcurrency ?? "—"} />
            <Metric label="启动时间" value={data?.startedAt ? new Date(data.startedAt).toLocaleString() : "—"} />
        </div>
        <div className="mt-6 grid gap-4 sm:grid-cols-2">
            <section className="rounded-xl border border-border p-5"><h2 className="mb-4 flex items-center gap-2 font-medium"><Waypoints className="size-4" />渠道</h2><p className="text-sm text-muted-foreground">启用 {data?.channels.active ?? "—"} · 冷却中 {data?.channels.cooling ?? "—"} · 检测失败 {data?.channels.monitorFailed ?? "—"} · 正在检测 {data?.channels.checking ?? "—"}</p></section>
            <section className="rounded-xl border border-border p-5"><h2 className="mb-4 flex items-center gap-2 font-medium"><Mail className="size-4" />邮件积压</h2><p className="text-sm text-muted-foreground">排队 {data?.mail.queued ?? "—"} · 发送中 {data?.mail.sending ?? "—"} · 失败 {data?.mail.failed ?? "—"}</p></section>
        </div>
    </div>;
}

function Metric({ label, value }: { label: string; value: string | number }) {
    return <div className="rounded-xl border border-border p-4"><p className="text-xs text-muted-foreground">{label}</p><p className="mt-2 break-all font-mono text-xl">{value}</p></div>;
}

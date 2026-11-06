import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Alert, Badge, Button, Drawer, Empty, Pagination, Select, Spin, Tabs, Tooltip, theme } from "antd";
import dayjs from "dayjs";
import { ArrowUpRight, FileText, Image as ImageIcon, Music2, RefreshCw, Video } from "lucide-react";
import { useNavigate } from "react-router-dom";

import { GENERATION_PAGE_SIZE } from "@/services/api/generation";
import { getUserGenerationTasks, getUserTaskSourcePath, type UserGenerationTask, type UserTaskCapability, type UserTaskFilterStatus } from "@/services/api/user-tasks";
import { assertCurrentSession, useUserStore } from "@/stores/use-user-store";

const capabilityLabels: Record<UserTaskCapability, string> = { image: "图片", video: "视频", audio: "音频", text: "文本" };
const capabilityIcons = { image: ImageIcon, video: Video, audio: Music2, text: FileText };
const taskStates = {
    reviewing: { label: "审核中", badge: "warning" },
    queued: { label: "排队中", badge: "default" },
    running: { label: "生成中", badge: "processing" },
    succeeded: { label: "成功", badge: "success" },
    failed: { label: "失败", badge: "error" },
    canceled: { label: "已取消", badge: "default" },
} as const;
const capabilityOptions = [{ value: "", label: "全部类型" }, ...Object.entries(capabilityLabels).map(([value, label]) => ({ value, label }))];
const statusOptions = [{ value: "", label: "全部状态" }, ...Object.entries(taskStates).map(([value, state]) => ({ value, label: state.label }))];

export default function GenerationTaskCenter({ onClose }: { onClose: () => void }) {
    const navigate = useNavigate();
    const { token } = theme.useToken();
    const session = useUserStore((state) => state.sessionVersion);
    const user = useUserStore((state) => state.user);
    const [filters, setFilters] = useState({ capability: "" as UserTaskCapability | "", status: "" as UserTaskFilterStatus | "", page: 1 });
    const tasks = useQuery({
        queryKey: ["user-generation-tasks", session, filters.capability, filters.status, filters.page],
        queryFn: ({ signal }) => {
            assertCurrentSession(session);
            return getUserGenerationTasks({ capability: filters.capability, status: filters.status, offset: (filters.page - 1) * GENERATION_PAGE_SIZE }, signal);
        },
        enabled: Boolean(user),
        refetchOnMount: "always",
        refetchOnWindowFocus: "always",
    });
    const { refetch } = tasks;

    useEffect(() => {
        const refresh = () => { if (!document.hidden) void refetch({ cancelRefetch: false }); };
        window.addEventListener("focus", refresh);
        return () => window.removeEventListener("focus", refresh);
    }, [refetch]);

    const openSource = (path: string) => { onClose(); navigate(path); };
    const summary = tasks.data?.summary;
    const activeCount = summary ? summary.reviewing + summary.queued + summary.running : 0;

    return (
        <Drawer
            open
            title="我的任务"
            size="min(100vw, 560px)"
            onClose={onClose}
            styles={{ body: { paddingTop: 12 } }}
            extra={<Tooltip title="切回窗口时更新，也可手动刷新任务状态。"><Button type="text" size="small" icon={<RefreshCw className="size-4" />} loading={tasks.isFetching} onClick={() => void refetch()}>刷新</Button></Tooltip>}
            footer={tasks.data?.total ? <Pagination size="small" current={filters.page} pageSize={GENERATION_PAGE_SIZE} total={tasks.data.total} showSizeChanger={false} disabled={tasks.isFetching} showTotal={(total) => `共 ${total} 个任务`} onChange={(page) => setFilters((current) => ({ ...current, page }))} /> : null}
        >
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                <Tabs className="min-w-32 flex-1 [&_.ant-tabs-nav]:!mb-0 [&_.ant-tabs-nav::before]:!border-0" size="small" activeKey={filters.status === "active" ? "active" : "all"} items={[{ key: "all", label: "全部" }, { key: "active", label: "进行中" }]} onChange={(key) => setFilters((current) => ({ ...current, status: key === "active" ? "active" : "", page: 1 }))} />
                <div className="flex items-center gap-1">
                    <Select aria-label="任务类型" variant="borderless" size="small" className="min-w-24" value={filters.capability} options={capabilityOptions} onChange={(capability: UserTaskCapability | "") => setFilters((current) => ({ ...current, capability, page: 1 }))} />
                    {filters.status !== "active" ? <Select aria-label="任务状态" variant="borderless" size="small" className="min-w-24" value={filters.status} options={statusOptions} onChange={(status: UserTaskFilterStatus | "") => setFilters((current) => ({ ...current, status, page: 1 }))} /> : null}
                </div>
            </div>
            {summary ? <div className="flex items-center gap-5 py-3 text-xs" role="group" aria-label="进行中任务概况" style={{ color: token.colorTextSecondary }}>
                {activeCount ? (["reviewing", "queued", "running"] as const).map((status) => <span key={status}>{taskStates[status].label} <strong className="ml-1 font-medium tabular-nums" style={{ color: token.colorText }}>{summary[status]}</strong></span>) : "暂无进行中的任务"}
            </div> : null}
            {tasks.error ? <Alert className="my-3" type="error" showIcon title={tasks.data ? "任务刷新失败" : "任务读取失败"} description={<><p>{tasks.error.message}</p>{tasks.data ? <p className="mt-1">当前显示上次读取的任务，可重试更新。</p> : null}</>} action={<Button type="text" size="small" onClick={() => void refetch()}>重试</Button>} /> : null}
            {tasks.isPending ? (
                <div className="flex items-center justify-center gap-2 py-12" role="status" style={{ color: token.colorTextSecondary }}><Spin size="small" /><span className="text-sm">正在读取任务…</span></div>
            ) : tasks.data?.tasks.length ? (
                <div>{tasks.data.tasks.map((task) => <TaskRow key={`${session}:${task.id}`} task={task} onOpenSource={openSource} />)}</div>
            ) : tasks.data ? (
                <Empty className="py-8" image={Empty.PRESENTED_IMAGE_SIMPLE} description={tasks.data?.total ? "当前页暂无任务，请切换上一页" : filters.capability || filters.status ? "没有符合筛选条件的任务" : "还没有生成任务"} />
            ) : null}
        </Drawer>
    );
}

function TaskRow({ task, onOpenSource }: { task: UserGenerationTask; onOpenSource: (path: string) => void }) {
    const { token } = theme.useToken();
    const [previewError, setPreviewError] = useState("");
    const [errorExpanded, setErrorExpanded] = useState(false);
    const Icon = capabilityIcons[task.capability];
    const state = taskStates[task.status];
    const source = getUserTaskSourcePath(task);
    const sourceAction = task.canvasProjectId ? "查看画布" : task.capability === "text" ? "查看对话" : "查看批次";
    const sourceLabel = task.sourceTitle && task.sourceTitle !== task.prompt ? `${sourceAction} · ${task.sourceTitle}` : sourceAction;
    const queuedAt = dayjs(task.queuedAt);
    const unavailable = task.sourceUnavailable === "canvas" ? "来源画布已不可访问，内容已隐藏" : task.sourceUnavailable === "conversation" ? "来源对话已删除或不可访问，内容已隐藏" : "";

    return (
        <article className="flex gap-3 border-b py-4 sm:gap-4" style={{ borderColor: token.colorBorderSecondary }}>
            <div className="flex size-14 shrink-0 items-start justify-center pt-1 sm:size-20" style={{ color: token.colorTextSecondary }}>
                {task.capability === "image" && task.output && !unavailable && !previewError ? <img src={task.output.url} alt="生成结果" loading="lazy" className="max-h-full max-w-full rounded-md object-contain" onError={() => setPreviewError("产物暂不可读取")} /> : <Icon className="size-6" />}
            </div>
            <div className="min-w-0 flex-1">
                <div className="flex items-start justify-between gap-3">
                    <p className="min-w-0 line-clamp-2 whitespace-pre-wrap break-words text-sm font-medium leading-6">{unavailable || task.prompt || `${capabilityLabels[task.capability]}任务`}</p>
                    <Badge className="shrink-0 pt-0.5" status={state.badge} text={<span className="text-xs">{state.label}</span>} />
                </div>
                <p className="mt-1 break-words text-xs" style={{ color: token.colorTextSecondary }}>{capabilityLabels[task.capability]} · {task.modelDisplayName || "未命名模型"}</p>
                <div className="mt-2 flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-xs" style={{ color: token.colorTextSecondary }}>
                    {source ? <Tooltip title={sourceLabel}><Button type="text" size="small" className="max-w-full !px-0 !text-xs" icon={<ArrowUpRight className="size-3.5" />} onClick={() => onOpenSource(source)}><span className="truncate">{sourceLabel}</span></Button></Tooltip> : <span>{unavailable ? "来源不可用" : task.capability === "audio" ? "音频任务" : "无可返回的来源"}</span>}
                    <Tooltip title={queuedAt.format("YYYY/MM/DD HH:mm:ss")}><time className="shrink-0 tabular-nums" dateTime={task.queuedAt}>{queuedAt.format(queuedAt.year() === dayjs().year() ? "MM/DD HH:mm" : "YYYY/MM/DD HH:mm")}</time></Tooltip>
                </div>
                {!unavailable && task.errorMessage ? <div className="mt-2 flex items-start gap-2 text-xs" style={{ color: token.colorError }}>
                    <p className={errorExpanded ? "min-w-0 flex-1 whitespace-pre-wrap break-words" : "min-w-0 flex-1 truncate"}>{errorExpanded ? task.errorMessage : task.errorMessage.split(/\r?\n/, 1)[0]}</p>
                    <Button type="text" size="small" className="shrink-0 !h-auto !px-0 !text-xs" aria-expanded={errorExpanded} onClick={() => setErrorExpanded((current) => !current)}>{errorExpanded ? "收起原因" : "查看原因"}</Button>
                </div> : null}
                {task.capability === "audio" && task.status === "succeeded" && task.output && !unavailable ? <audio className="mt-3 w-full" controls preload="none" src={task.output.url} aria-label="音频生成结果" onError={() => setPreviewError("音频产物暂不可读取")} /> : null}
                {task.status === "succeeded" && task.capability !== "text" && !task.output && !unavailable ? <p className="mt-2 text-xs" style={{ color: token.colorTextSecondary }}>产物已不可读取</p> : null}
                {previewError ? <p className="mt-2 text-xs" style={{ color: token.colorError }}>{previewError}</p> : null}
            </div>
        </article>
    );
}

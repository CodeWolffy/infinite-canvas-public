import { useCallback, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, Badge, Button, Empty, Popover, Tabs, Tag } from "antd";
import { Bell, CheckCheck, RefreshCw } from "lucide-react";
import { useTranslation } from "react-i18next";

import { getNotifications, readAllNotifications, readNotification } from "@/services/api/platform-operations";
import { getAnnouncement } from "@/services/api/preferences";
import { MarkdownLite } from "@/lib/markdown-lite";
import { useUserStore } from "@/stores/use-user-store";
import { useThemeStore } from "@/stores/use-theme-store";
import { canvasThemes } from "@/lib/canvas-theme";

const ANNOUNCEMENT_SEEN_KEY = "announcementSeenAt";

function readSeenAnnouncement(): string {
    try {
        return localStorage.getItem(ANNOUNCEMENT_SEEN_KEY) || "";
    } catch {
        return "";
    }
}

export function NotificationCenter() {
    const { t } = useTranslation();
    const [open, setOpen] = useState(false);
    const [activeTab, setActiveTab] = useState<"system" | "announcement">("system");
    const session = useUserStore((state) => state.sessionVersion);
    const user = useUserStore((state) => state.user);
    const theme = useThemeStore((state) => state.theme);
    const client = useQueryClient();

    // 1. 系统通知查询：移除 2.5s 暴力轮询，仅在挂载/打开浮层或窗口聚焦时刷新，缓存 3 分钟
    const notificationsQuery = useQuery({
        queryKey: ["notifications", session],
        queryFn: getNotifications,
        enabled: Boolean(user),
        staleTime: 1000 * 60 * 3,
        refetchOnWindowFocus: true,
    });

    // 2. 全站公告查询：缓存 5 分钟
    const announcementQuery = useQuery({
        queryKey: ["announcement"],
        queryFn: getAnnouncement,
        staleTime: 1000 * 60 * 5,
    });

    const [seenAt, setSeenAt] = useState(readSeenAnnouncement);

    const announcement = announcementQuery.data;
    const hasAnnouncementContent = Boolean(announcement && (announcement.content.trim() || announcement.entries.length > 0));
    const announcementUnread = Boolean(
        hasAnnouncementContent &&
        announcement?.publishedAt &&
        announcement.publishedAt !== seenAt
    );

    const markAnnouncementSeen = useCallback(() => {
        if (!announcement?.publishedAt) return;
        try {
            localStorage.setItem(ANNOUNCEMENT_SEEN_KEY, announcement.publishedAt);
        } catch {
            // ignore
        }
        setSeenAt(announcement.publishedAt);
    }, [announcement]);

    const read = useMutation({
        mutationFn: readNotification,
        onSuccess: () => client.invalidateQueries({ queryKey: ["notifications"] }),
    });

    const readAll = useMutation({
        mutationFn: readAllNotifications,
        onSuccess: () => client.invalidateQueries({ queryKey: ["notifications"] }),
    });

    const entries = notificationsQuery.data?.notifications || [];
    const unreadSystemCount = useMemo(() => entries.filter((entry) => !entry.read).length, [entries]);
    const totalHasUnread = unreadSystemCount > 0 || announcementUnread;

    const handleOpenChange = (nextOpen: boolean) => {
        setOpen(nextOpen);
        if (nextOpen) {
            void notificationsQuery.refetch();
            void announcementQuery.refetch();
            if (activeTab === "announcement" && announcementUnread) {
                markAnnouncementSeen();
            }
        }
    };

    const handleTabChange = (key: string) => {
        const nextTab = key as "system" | "announcement";
        setActiveTab(nextTab);
        if (nextTab === "announcement" && announcementUnread) {
            markAnnouncementSeen();
        }
    };

    const popoverContent = (
        <div className="w-[380px] sm:w-[440px]">
            <div className="flex items-center justify-between border-b border-stone-200 pb-2.5 dark:border-stone-800">
                <span className="text-sm font-semibold text-stone-950 dark:text-stone-100">通知中心</span>
                <div className="flex items-center gap-1">
                    {activeTab === "system" && unreadSystemCount > 0 ? (
                        <Button
                            type="text"
                            size="small"
                            icon={<CheckCheck className="size-3.5" />}
                            loading={readAll.isPending}
                            onClick={() => readAll.mutate()}
                            className="text-xs text-stone-500 hover:text-stone-900 dark:text-stone-400 dark:hover:text-stone-100"
                        >
                            全部已读
                        </Button>
                    ) : null}
                    <Button
                        type="text"
                        size="small"
                        icon={<RefreshCw className={`size-3.5 ${notificationsQuery.isFetching ? "animate-spin" : ""}`} />}
                        onClick={() => {
                            void notificationsQuery.refetch();
                            void announcementQuery.refetch();
                        }}
                        className="text-xs text-stone-500 hover:text-stone-900 dark:text-stone-400 dark:hover:text-stone-100"
                    >
                        刷新
                    </Button>
                </div>
            </div>

            <Tabs
                size="small"
                activeKey={activeTab}
                onChange={handleTabChange}
                className="[&_.ant-tabs-nav]:mb-2"
                items={[
                    {
                        key: "system",
                        label: (
                            <span className="flex items-center gap-1.5 text-xs">
                                <span>系统通知</span>
                                {unreadSystemCount > 0 ? (
                                    <span className="rounded-full bg-blue-500 px-1.5 py-0.2 text-[10px] text-white">
                                        {unreadSystemCount}
                                    </span>
                                ) : null}
                            </span>
                        ),
                        children: (
                            <div className="max-h-[380px] overflow-y-auto pr-1">
                                {notificationsQuery.error ? (
                                    <Alert type="error" showIcon message={notificationsQuery.error.message} className="my-2" />
                                ) : entries.length ? (
                                    <div className="divide-y divide-stone-100 dark:divide-stone-800">
                                        {entries.map((entry) => (
                                            <article key={entry.id} className="py-2.5 px-2 rounded-lg hover:bg-stone-100/60 dark:hover:bg-stone-800/40 transition-colors">
                                                <div className="flex items-start justify-between gap-2">
                                                    <h4 className="text-xs font-medium text-stone-900 dark:text-stone-100">{entry.title}</h4>
                                                    {entry.read ? null : <Tag color="blue" className="!mr-0 text-[10px] scale-90">未读</Tag>}
                                                </div>
                                                <p className="mt-1 whitespace-pre-wrap text-xs leading-relaxed text-stone-600 dark:text-stone-300">{entry.content}</p>
                                                <div className="mt-2 flex items-center justify-between gap-2">
                                                    <time className="text-[11px] text-stone-400">{new Date(entry.createdAt).toLocaleString()}</time>
                                                    {entry.read ? null : (
                                                        <Button
                                                            type="link"
                                                            size="small"
                                                            className="!h-auto !p-0 text-xs text-blue-600 hover:text-blue-500 dark:text-blue-400"
                                                            onClick={() => read.mutate(entry.id)}
                                                        >
                                                            标为已读
                                                        </Button>
                                                    )}
                                                </div>
                                            </article>
                                        ))}
                                    </div>
                                ) : (
                                    <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无系统通知" className="my-8" />
                                )}
                            </div>
                        ),
                    },
                    {
                        key: "announcement",
                        label: (
                            <span className="flex items-center gap-1.5 text-xs">
                                <span>全站公告</span>
                                {announcementUnread ? (
                                    <span className="size-1.5 rounded-full bg-red-500" />
                                ) : null}
                            </span>
                        ),
                        children: (
                            <div className="max-h-[380px] overflow-y-auto pr-1">
                                {hasAnnouncementContent && announcement ? (
                                    <div className="py-2 text-xs">
                                        {announcement.title ? (
                                            <h3 className="mb-2 font-semibold text-stone-900 dark:text-stone-100">{announcement.title}</h3>
                                        ) : null}
                                        {announcement.content ? (
                                            <div className="text-stone-700 dark:text-stone-300">
                                                <MarkdownLite content={announcement.content} />
                                            </div>
                                        ) : null}
                                        {announcement.entries?.length ? (
                                            <div className="mt-3 border-t border-stone-200 pt-3 dark:border-stone-800">
                                                <p className="mb-2 font-medium text-stone-900 dark:text-stone-100">更新日志</p>
                                                <div className="space-y-2.5">
                                                    {announcement.entries.map((item, idx) => (
                                                        <div key={idx} className="border-l-2 border-stone-300 pl-2 dark:border-stone-700">
                                                            <div className="flex items-center gap-2">
                                                                {item.date ? <span className="font-mono text-[10px] text-stone-400">{item.date}</span> : null}
                                                                {item.tag ? <Tag className="!mr-0 text-[10px] scale-90">{item.tag}</Tag> : null}
                                                                <span className="font-medium text-stone-800 dark:text-stone-200">{item.title}</span>
                                                            </div>
                                                            {item.body ? <p className="mt-1 text-stone-500 dark:text-stone-400">{item.body}</p> : null}
                                                        </div>
                                                    ))}
                                                </div>
                                            </div>
                                        ) : null}
                                    </div>
                                ) : (
                                    <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无全站公告" className="my-8" />
                                )}
                            </div>
                        ),
                    },
                ]}
            />
        </div>
    );

    return (
        <Popover
            content={popoverContent}
            trigger="click"
            open={open}
            onOpenChange={handleOpenChange}
            placement="bottomRight"
            arrow={false}
            overlayInnerStyle={{ padding: "12px 14px", borderRadius: 12 }}
        >
            <Badge dot={totalHasUnread} offset={[-2, 4]}>
                <button
                    type="button"
                    aria-label="通知中心"
                    title="通知中心"
                    style={{ color: canvasThemes[theme].node.text }}
                    className="inline-flex size-7 items-center justify-center rounded-md hover:bg-black/5 dark:hover:bg-white/10"
                >
                    <Bell className="size-4" />
                </button>
            </Badge>
        </Popover>
    );
}

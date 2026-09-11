import { useCallback, useEffect, useMemo, useState } from "react";
import { Badge, Button, Checkbox, Empty, Modal, Tabs, Tooltip } from "antd";
import { Bell } from "lucide-react";
import { useTranslation } from "react-i18next";

import { MarkdownLite } from "@/lib/markdown-lite";
import { getAnnouncement, type Announcement } from "@/services/api/preferences";

const SEEN_KEY = "announcementSeenAt";

const TAG_CLASS: Record<string, string> = {
    new: "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900/60 dark:bg-emerald-950/40 dark:text-emerald-300",
    fix: "border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-300",
    update: "border-sky-200 bg-sky-50 text-sky-700 dark:border-sky-900/60 dark:bg-sky-950/40 dark:text-sky-300",
};

function readSeenAt() {
    try {
        return localStorage.getItem(SEEN_KEY) || "";
    } catch {
        return "";
    }
}

function tagClass(tag: string) {
    return TAG_CLASS[tag.trim().toLowerCase()] || "border-stone-200 bg-stone-100 text-stone-600 dark:border-stone-700 dark:bg-stone-800 dark:text-stone-300";
}

export function AnnouncementCenter() {
    const { t } = useTranslation();
    const [announcement, setAnnouncement] = useState<Announcement | null>(null);
    const [open, setOpen] = useState(false);
    const [seenAt, setSeenAt] = useState(readSeenAt);

    useEffect(() => {
        let cancelled = false;
        void getAnnouncement()
            .then((value) => {
                if (cancelled) return;
                setAnnouncement(value);
                // Auto-surface only when this publish has never been acknowledged.
                if (hasContent(value) && value.publishedAt && value.publishedAt !== readSeenAt()) setOpen(true);
            })
            .catch(() => undefined);
        return () => {
            cancelled = true;
        };
    }, []);

    const unread = useMemo(
        () => Boolean(announcement && hasContent(announcement) && announcement.publishedAt && announcement.publishedAt !== seenAt),
        [announcement, seenAt],
    );

    const markSeen = useCallback(() => {
        if (!announcement?.publishedAt) return;
        try {
            localStorage.setItem(SEEN_KEY, announcement.publishedAt);
        } catch {
            // A blocked localStorage only means the notice shows again next visit.
        }
        setSeenAt(announcement.publishedAt);
    }, [announcement]);

    const handleOpen = useCallback(() => {
        setOpen(true);
        markSeen();
    }, [markSeen]);

    const close = useCallback(() => {
        setOpen(false);
        markSeen();
    }, [markSeen]);

    if (!announcement || !hasContent(announcement)) return null;

    const entries = announcement.entries.filter((entry) => entry.title.trim() || entry.body.trim());
    const hasNotice = Boolean(announcement.content.trim());
    const defaultTab = hasNotice ? "notice" : "changelog";

    const items = [
        {
            key: "notice",
            label: t("announcement.noticeTab"),
            children: hasNotice
                ? <MarkdownLite content={announcement.content} />
                : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t("announcement.emptyNotice")} />,
        },
        {
            key: "changelog",
            label: `${t("announcement.changelogTab")}${entries.length ? ` (${entries.length})` : ""}`,
            children: entries.length ? (
                <ol className="m-0 list-none space-y-4 p-0">
                    {entries.map((entry, index) => (
                        <li key={`${entry.date}-${index}`} className="relative ps-4 before:absolute before:start-0 before:top-[0.45rem] before:size-1.5 before:rounded-full before:bg-stone-300 after:absolute after:start-[0.1875rem] after:top-4 after:bottom-[-1rem] after:w-px after:bg-stone-200 last:after:hidden dark:before:bg-stone-600 dark:after:bg-stone-800">
                            <div className="flex flex-wrap items-center gap-2">
                                {entry.date ? <span className="font-mono text-xs text-stone-500 dark:text-stone-400">{entry.date}</span> : null}
                                {entry.tag ? <span className={`rounded-md border px-1.5 py-0.5 text-[0.6875rem] leading-4 ${tagClass(entry.tag)}`}>{entry.tag}</span> : null}
                                {entry.title ? <span className="text-sm font-medium text-stone-950 dark:text-stone-100">{entry.title}</span> : null}
                            </div>
                            {entry.body ? <MarkdownLite content={entry.body} className="mt-1" /> : null}
                        </li>
                    ))}
                </ol>
            ) : (
                <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t("announcement.emptyChangelog")} />
            ),
        },
    ];

    return (
        <>
            <Tooltip title={t("announcement.open")}>
                <Badge dot offset={[-4, 4]} count={unread ? 1 : 0}>
                    <Button type="text" shape="circle" className="!h-8 !w-8 !min-w-8" icon={<Bell className="size-4" />} onClick={handleOpen} aria-label={t("announcement.open")} />
                </Badge>
            </Tooltip>
            <Modal
                open={open}
                onCancel={close}
                title={announcement.title.trim() || t("announcement.title")}
                width={580}
                centered
                destroyOnHidden
                footer={
                    <div className="flex items-center justify-end">
                        <Button type="primary" onClick={close}>{t("announcement.confirm")}</Button>
                    </div>
                }
            >
                <Tabs defaultActiveKey={defaultTab} items={items} size="small" className="[&_.ant-tabs-nav]:!mb-3" />
            </Modal>
        </>
    );
}

function hasContent(value: Announcement) {
    return Boolean(value.content.trim() || value.entries.some((entry) => entry.title.trim() || entry.body.trim()));
}

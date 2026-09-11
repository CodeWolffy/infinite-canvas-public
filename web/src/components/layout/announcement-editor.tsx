import { useEffect, useState } from "react";
import { App, Button, Checkbox, Empty, Input, Modal, Popconfirm, Select, Space, Tabs, Tooltip } from "antd";
import { ArrowDown, ArrowUp, Calendar, Eye, HelpCircle, Plus, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";

import { MarkdownLite } from "@/lib/markdown-lite";
import { getAnnouncement, updateAnnouncement, type ChangelogEntry } from "@/services/api/preferences";

const TAG_OPTIONS = [
    { value: "new", label: "new (新增)" },
    { value: "update", label: "update (更新)" },
    { value: "fix", label: "fix (修复)" },
];

const TAG_CLASS: Record<string, string> = {
    new: "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900/60 dark:bg-emerald-950/40 dark:text-emerald-300",
    fix: "border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-300",
    update: "border-sky-200 bg-sky-50 text-sky-700 dark:border-sky-900/60 dark:bg-sky-950/40 dark:text-sky-300",
};

function tagClass(tag: string) {
    return TAG_CLASS[tag.trim().toLowerCase()] || "border-stone-200 bg-stone-100 text-stone-600 dark:border-stone-700 dark:bg-stone-800 dark:text-stone-300";
}

function getTodayString() {
    const date = new Date();
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
}

const emptyEntry: ChangelogEntry = { date: "", tag: "new", title: "", body: "" };

export function AnnouncementEditor({ open, onClose }: { open: boolean; onClose: () => void }) {
    const { t } = useTranslation();
    const { message } = App.useApp();
    const [title, setTitle] = useState("");
    const [content, setContent] = useState("");
    const [entries, setEntries] = useState<ChangelogEntry[]>([]);
    const [forceAlert, setForceAlert] = useState(false);
    const [saving, setSaving] = useState(false);
    const [activeTab, setActiveTab] = useState("notice");

    useEffect(() => {
        if (!open) return;
        setActiveTab("notice");
        setForceAlert(false);
        void getAnnouncement()
            .then((value) => {
                setTitle(value.title || "");
                setContent(value.content || "");
                setEntries(value.entries || []);
            })
            .catch(() => undefined);
    }, [open]);

    const updateEntry = (index: number, patch: Partial<ChangelogEntry>) => {
        setEntries((value) => value.map((entry, position) => (position === index ? { ...entry, ...patch } : entry)));
    };

    const moveEntry = (index: number, direction: "up" | "down") => {
        const targetIndex = direction === "up" ? index - 1 : index + 1;
        if (targetIndex < 0 || targetIndex >= entries.length) return;
        setEntries((prev) => {
            const next = [...prev];
            const temp = next[index];
            next[index] = next[targetIndex];
            next[targetIndex] = temp;
            return next;
        });
    };

    const handleClearAll = () => {
        setTitle("");
        setContent("");
        setEntries([]);
    };

    const save = async () => {
        setSaving(true);
        try {
            const draft = {
                title: title.trim(),
                content: content.trim(),
                entries: entries.filter((entry) => entry.title.trim() || entry.body.trim()),
                forceAlert,
            };
            await updateAnnouncement(draft);
            message.success(draft.content || draft.entries.length ? t("announcement.publishSuccess") : t("announcement.clearSuccess"));
            onClose();
        } catch (error) {
            message.error(error instanceof Error ? error.message : t("announcement.saveFailed"));
        } finally {
            setSaving(false);
        }
    };

    const validEntries = entries.filter((entry) => entry.title.trim() || entry.body.trim());

    const noticeTab = (
        <div className="space-y-3">
            <Input
                value={title}
                maxLength={80}
                onChange={(event) => setTitle(event.target.value)}
                placeholder={t("announcement.noticeTitlePlaceholder")}
            />
            <Input.TextArea
                rows={12}
                maxLength={8000}
                showCount
                value={content}
                onChange={(event) => setContent(event.target.value)}
                placeholder={t("announcement.noticeContentPlaceholder")}
            />
            <p className="m-0 text-xs leading-5 text-stone-500">{t("announcement.noticeHelp")}</p>
        </div>
    );

    const changelogTab = (
        <div className="space-y-3">
            <div className="max-h-[26rem] space-y-3 overflow-y-auto pe-1">
                {entries.map((entry, index) => (
                    <div key={index} className="space-y-2 rounded-xl border border-stone-200 p-3 dark:border-stone-800">
                        <Space.Compact block>
                            <Input
                                value={entry.date}
                                maxLength={40}
                                onChange={(event) => updateEntry(index, { date: event.target.value })}
                                placeholder={t("announcement.datePlaceholder")}
                                className="!w-[8.5rem]"
                            />
                            <Tooltip title={t("announcement.today")}>
                                <Button
                                    icon={<Calendar className="size-3.5" />}
                                    onClick={() => updateEntry(index, { date: getTodayString() })}
                                />
                            </Tooltip>
                            <Select
                                value={entry.tag || "new"}
                                onChange={(value) => updateEntry(index, { tag: value })}
                                options={TAG_OPTIONS}
                                className="!w-[8rem]"
                            />
                            <Input
                                value={entry.title}
                                maxLength={120}
                                onChange={(event) => updateEntry(index, { title: event.target.value })}
                                placeholder={t("announcement.entryTitlePlaceholder")}
                            />
                            <Tooltip title={t("announcement.moveUp")}>
                                <Button
                                    icon={<ArrowUp className="size-3.5" />}
                                    disabled={index === 0}
                                    onClick={() => moveEntry(index, "up")}
                                    aria-label={t("announcement.moveUp")}
                                />
                            </Tooltip>
                            <Tooltip title={t("announcement.moveDown")}>
                                <Button
                                    icon={<ArrowDown className="size-3.5" />}
                                    disabled={index === entries.length - 1}
                                    onClick={() => moveEntry(index, "down")}
                                    aria-label={t("announcement.moveDown")}
                                />
                            </Tooltip>
                            <Tooltip title={t("announcement.deleteEntry")}>
                                <Button
                                    danger
                                    icon={<Trash2 className="size-3.5" />}
                                    onClick={() => setEntries((value) => value.filter((_, position) => position !== index))}
                                    aria-label={t("announcement.deleteEntry")}
                                />
                            </Tooltip>
                        </Space.Compact>
                        <Input.TextArea
                            rows={2}
                            maxLength={1000}
                            value={entry.body}
                            onChange={(event) => updateEntry(index, { body: event.target.value })}
                            placeholder={t("announcement.entryBodyPlaceholder")}
                        />
                    </div>
                ))}
            </div>
            <Button
                block
                icon={<Plus className="size-4" />}
                onClick={() => setEntries((value) => [{ ...emptyEntry, date: getTodayString() }, ...value])}
                disabled={entries.length >= 30}
            >
                {t("announcement.addEntry")}
            </Button>
            <p className="m-0 text-xs leading-5 text-stone-500">{t("announcement.changelogHelp")}</p>
        </div>
    );

    const previewTab = (
        <div className="space-y-4 rounded-xl border border-stone-200 p-4 dark:border-stone-800">
            <h4 className="m-0 text-base font-semibold text-stone-950 dark:text-stone-100">
                {title.trim() || t("announcement.title")}
            </h4>
            <Tabs
                size="small"
                items={[
                    {
                        key: "p-notice",
                        label: t("announcement.noticeTab"),
                        children: content.trim() ? (
                            <div className="max-h-[22rem] overflow-y-auto">
                                <MarkdownLite content={content} />
                            </div>
                        ) : (
                            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t("announcement.emptyNotice")} />
                        ),
                    },
                    {
                        key: "p-changelog",
                        label: `${t("announcement.changelogTab")}${validEntries.length ? ` (${validEntries.length})` : ""}`,
                        children: validEntries.length ? (
                            <div className="max-h-[22rem] overflow-y-auto">
                                <ol className="m-0 list-none space-y-4 p-0">
                                    {validEntries.map((entry, index) => (
                                        <li key={index} className="relative ps-4 before:absolute before:start-0 before:top-[0.45rem] before:size-1.5 before:rounded-full before:bg-stone-300 after:absolute after:start-[0.1875rem] after:top-4 after:bottom-[-1rem] after:w-px after:bg-stone-200 last:after:hidden dark:before:bg-stone-600 dark:after:bg-stone-800">
                                            <div className="flex flex-wrap items-center gap-2">
                                                {entry.date ? <span className="font-mono text-xs text-stone-500 dark:text-stone-400">{entry.date}</span> : null}
                                                {entry.tag ? <span className={`rounded-md border px-1.5 py-0.5 text-[0.6875rem] leading-4 ${tagClass(entry.tag)}`}>{entry.tag}</span> : null}
                                                {entry.title ? <span className="text-sm font-medium text-stone-950 dark:text-stone-100">{entry.title}</span> : null}
                                            </div>
                                            {entry.body ? <MarkdownLite content={entry.body} className="mt-1" /> : null}
                                        </li>
                                    ))}
                                </ol>
                            </div>
                        ) : (
                            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t("announcement.emptyChangelog")} />
                        ),
                    },
                ]}
            />
        </div>
    );

    return (
        <Modal
            title={t("announcement.editorTitle")}
            open={open}
            onCancel={onClose}
            width={720}
            destroyOnHidden
            footer={
                <div className="flex items-center justify-between gap-3">
                    <div className="flex items-center gap-4">
                        <Popconfirm
                            title={t("announcement.clearConfirmTitle")}
                            description={t("announcement.clearConfirmDesc")}
                            onConfirm={handleClearAll}
                            okText={t("announcement.clearAll")}
                            cancelText={t("announcement.cancel")}
                            okButtonProps={{ danger: true }}
                        >
                            <Button danger type="text" size="small">
                                {t("announcement.clearAll")}
                            </Button>
                        </Popconfirm>
                        <Checkbox checked={forceAlert} onChange={(e) => setForceAlert(e.target.checked)}>
                            <span className="inline-flex items-center gap-1 text-xs text-stone-600 dark:text-stone-400">
                                {t("announcement.forceAlertLabel")}
                                <Tooltip title={t("announcement.forceAlertTooltip")}>
                                    <HelpCircle className="size-3.5 text-stone-400" />
                                </Tooltip>
                            </span>
                        </Checkbox>
                    </div>
                    <Space>
                        <Button onClick={onClose}>{t("announcement.cancel")}</Button>
                        <Button type="primary" loading={saving} onClick={() => void save()}>
                            {t("announcement.save")}
                        </Button>
                    </Space>
                </div>
            }
        >
            <Tabs
                activeKey={activeTab}
                onChange={setActiveTab}
                size="small"
                items={[
                    { key: "notice", label: t("announcement.noticeTab"), children: noticeTab },
                    { key: "changelog", label: `${t("announcement.changelogTab")}${entries.length ? ` (${entries.length})` : ""}`, children: changelogTab },
                    { key: "preview", label: <span className="inline-flex items-center gap-1.5"><Eye className="size-3.5" />{t("announcement.userPreview")}</span>, children: previewTab },
                ]}
            />
        </Modal>
    );
}


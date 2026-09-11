import { useState } from "react";
import { App, Button, Empty, Input, Modal, Popconfirm, Spin, Tag } from "antd";
import { Clock, History, Plus, RotateCcw } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";

import { canvasThemes } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";
import { useCanvasStore } from "@/stores/canvas/use-canvas-store";
import { assertCurrentSession, useUserStore } from "@/stores/use-user-store";
import {
    listCanvasProjectHistory,
    createCanvasProjectSnapshot,
    restoreCanvasProjectHistory,
    type CanvasProjectHistoryRecord,
    type CanvasProjectDetail,
} from "@/services/api/canvas-projects";

type Props = {
    projectId: string;
    open: boolean;
    onClose: () => void;
    onRestored: (project: CanvasProjectDetail) => void;
};

async function flushBeforeHistoryChange(projectId: string) {
    const sessionVersion = useUserStore.getState().sessionVersion;
    await useCanvasStore.getState().flushProject(projectId);
    assertCurrentSession(sessionVersion);
    const error = useCanvasStore.getState().saveError;
    if (error?.projectId === projectId) throw new Error(error.message);
}

export function CanvasHistoryModal({ projectId, open, onClose, onRestored }: Props) {
    const { t } = useTranslation();
    const { message } = App.useApp();
    const colorTheme = useThemeStore((state) => state.theme);
    const theme = canvasThemes[colorTheme];
    const queryClient = useQueryClient();
    const [snapshotNote, setSnapshotNote] = useState("");

    const queryKey = ["canvas-project-history", projectId];

    const { data: history = [], isLoading } = useQuery({
        queryKey,
        queryFn: () => listCanvasProjectHistory(projectId),
        enabled: open && Boolean(projectId),
    });

    const createMutation = useMutation({
        mutationFn: async (note?: string) => {
            await flushBeforeHistoryChange(projectId);
            return createCanvasProjectSnapshot(projectId, note);
        },
        onSuccess: () => {
            message.success(t("canvas.history.createSuccess", "快照创建成功"));
            setSnapshotNote("");
            queryClient.invalidateQueries({ queryKey });
        },
        onError: (err) => {
            message.error(err instanceof Error ? err.message : t("canvas.history.createFailed", "创建快照失败"));
        },
    });

    const restoreMutation = useMutation({
        mutationFn: async (historyId: string) => {
            await flushBeforeHistoryChange(projectId);
            return restoreCanvasProjectHistory(projectId, historyId);
        },
        onSuccess: (project) => {
            message.success(t("canvas.history.restoreSuccess", "已成功还原到历史版本"));
            onRestored(project);
            onClose();
        },
        onError: (err) => {
            message.error(err instanceof Error ? err.message : t("canvas.history.restoreFailed", "还原历史版本失败"));
        },
    });

    const handleCreateSnapshot = () => {
        createMutation.mutate(snapshotNote.trim() || undefined);
    };

    return (
        <Modal
            open={open}
            onCancel={onClose}
            footer={null}
            centered
            width={640}
            title={
                <div className="flex items-center gap-2 text-base font-semibold">
                    <History className="size-5" />
                    <span>{t("canvas.versionHistory", "版本历史")}</span>
                </div>
            }
        >
            <div className="space-y-4 pt-2">
                {/* 顶部创建手动快照区 */}
                <div
                    className="flex items-center gap-2 rounded-xl border p-3"
                    style={{ borderColor: theme.toolbar.border, background: theme.toolbar.panel }}
                >
                    <Input
                        value={snapshotNote}
                        onChange={(e) => setSnapshotNote(e.target.value)}
                        onPressEnter={handleCreateSnapshot}
                        placeholder={t("canvas.history.notePlaceholder", "输入快照备注（例如：方案A定稿、大改前备份）")}
                        maxLength={100}
                        allowClear
                        className="!bg-transparent"
                    />
                    <Button
                        type="primary"
                        icon={<Plus className="size-4" />}
                        onClick={handleCreateSnapshot}
                        loading={createMutation.isPending}
                        className="shrink-0"
                    >
                        {t("canvas.history.createSnapshot", "创建快照")}
                    </Button>
                </div>

                {/* 历史版本列表 */}
                <div className="max-h-[420px] overflow-y-auto pr-1">
                    {isLoading ? (
                        <div className="flex h-48 items-center justify-center">
                            <Spin />
                        </div>
                    ) : history.length === 0 ? (
                        <div className="py-12">
                            <Empty description={t("canvas.history.empty", "暂无历史版本记录")} />
                        </div>
                    ) : (
                        <div className="space-y-2">
                            {history.map((item) => (
                                <HistoryItem
                                    key={item.id}
                                    item={item}
                                    onRestore={() => restoreMutation.mutate(item.id)}
                                    isRestoring={restoreMutation.isPending}
                                />
                            ))}
                        </div>
                    )}
                </div>
            </div>
        </Modal>
    );
}

function formatDate(value: string) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function HistoryItem({
    item,
    onRestore,
    isRestoring,
}: {
    item: CanvasProjectHistoryRecord;
    onRestore: () => void;
    isRestoring: boolean;
}) {
    const { t } = useTranslation();
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const isManual = Boolean(item.note);

    return (
        <div
            className="flex items-center justify-between gap-3 rounded-xl border p-3 transition hover:border-black/20 dark:hover:border-white/20"
            style={{ borderColor: theme.toolbar.border }}
        >
            <div className="min-w-0 flex-1 space-y-1">
                <div className="flex items-center gap-2">
                    {isManual ? (
                        <Tag color="blue" className="!mr-0 font-medium">
                            {t("canvas.history.manualBackup", "手动快照")}
                        </Tag>
                    ) : (
                        <Tag className="!mr-0 opacity-70">
                            {t("canvas.history.autoBackup", "自动备份")}
                        </Tag>
                    )}
                    <span className="truncate font-medium text-sm">
                        {item.note || item.title}
                    </span>
                </div>
                <div className="flex items-center gap-3 text-xs opacity-60">
                    <span className="flex items-center gap-1">
                        <Clock className="size-3.5" />
                        {formatDate(item.createdAt)}
                    </span>
                    <span>•</span>
                    <span>{t("canvas.history.nodesCount", "{{count}} 个节点", { count: item.nodeCount })}</span>
                    <span>•</span>
                    <span>{t("canvas.history.connectionsCount", "{{count}} 条连线", { count: item.connectionCount })}</span>
                </div>
            </div>

            <Popconfirm
                title={t("canvas.history.restoreConfirmTitle", "确认还原此版本？")}
                description={t("canvas.history.restoreConfirm", "确定还原到该历史版本吗？当前未保存的修改可能会被覆盖。")}
                onConfirm={onRestore}
                okText={t("common.confirm", "确定")}
                cancelText={t("common.cancel", "取消")}
                okButtonProps={{ loading: isRestoring }}
            >
                <Button
                    type="text"
                    size="small"
                    icon={<RotateCcw className="size-3.5" />}
                    disabled={isRestoring}
                    className="shrink-0 hover:!bg-black/5 dark:hover:!bg-white/10"
                >
                    {t("canvas.history.restore", "还原")}
                </Button>
            </Popconfirm>
        </div>
    );
}

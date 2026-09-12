import { useMemo, useState } from "react";
import { App, Button, Card, Empty, Image, Input, Popconfirm, Select, Spin, Tag, Tooltip } from "antd";
import { Clock, Copy, Download, FolderPlus, FolderSync, Info, RefreshCw, Search, Sparkles, Trash2, Wand2 } from "lucide-react";
import { Link, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import dayjs from "dayjs";
import { saveAs } from "file-saver";

import { createZip } from "@/lib/zip";
import { formatBytes } from "@/lib/image-utils";
import { useCopyText } from "@/hooks/use-copy-text";
import {
    deleteGenerationBatch,
    getGenerationBatch,
    listGenerationBatches,
    GENERATION_PAGE_SIZE,
    type GenerationBatchListItem,
} from "@/services/api/generation";
import { createAsset } from "@/services/api/assets";
import { useAssetStore } from "@/stores/use-asset-store";

/** 与服务端 ORPHAN_MEDIA_GRACE_DAYS 的默认值保持一致，接口没带 retentionDays 时用它兜底。 */
const DEFAULT_RETENTION_DAYS = 45;
const listKey = (offset: number) => ["user-generations", offset] as const;
const detailKey = (id: string) => ["user-generation-batch", id] as const;

function expirationDays(createdAt: string, retentionDays = DEFAULT_RETENTION_DAYS) {
    const expiresAt = new Date(createdAt).getTime() + retentionDays * 24 * 60 * 60 * 1000;
    return Math.ceil((expiresAt - Date.now()) / (24 * 60 * 60 * 1000));
}

function hasActiveTasks(batches: GenerationBatchListItem[]) {
    return batches.some((batch) => (batch.summary?.activeCount ?? 0) > 0);
}

/** 批次内所有成功出图都已转存进素材库，才算「已永久保存」。 */
function isBatchSaved(batch: GenerationBatchListItem) {
    const summary = batch.summary;
    return Boolean(summary && summary.succeededCount > 0 && summary.savedCount >= summary.succeededCount);
}

export default function UserGenerationsPage() {
    const { t } = useTranslation();
    const [offset, setOffset] = useState(0);
    const [searchPrompt, setSearchPrompt] = useState("");
    const [statusFilter, setStatusFilter] = useState<"all" | "temporary" | "permanent" | "expiring">("all");

    const { data, isLoading, isFetching, refetch } = useQuery({
        queryKey: listKey(offset),
        queryFn: () => listGenerationBatches(GENERATION_PAGE_SIZE, offset),
        // 只在这一页还有排队/运行中的任务时轮询；标签页隐藏时 react-query 会自动暂停。
        refetchInterval: (query) => (hasActiveTasks(query.state.data?.batches ?? []) ? 3000 : false),
    });

    const batches = data?.batches ?? [];
    const filteredBatches = useMemo(() => {
        const keyword = searchPrompt.trim().toLowerCase();
        return batches.filter((batch) => {
            if (keyword && !batch.prompt.toLowerCase().includes(keyword)) return false;
            if (statusFilter === "expiring") return expirationDays(batch.createdAt, batch.retentionDays) <= 3;
            // 「已转存 / 未转存」直接用列表返回的 savedCount 判断，不必为每个批次再拉一次详情。
            if (statusFilter === "permanent") return isBatchSaved(batch);
            if (statusFilter === "temporary") return !isBatchSaved(batch);
            return true;
        });
    }, [batches, searchPrompt, statusFilter]);

    return (
        <div className="mx-auto max-w-5xl space-y-6 p-4 sm:p-6 lg:p-8">
            <div className="flex flex-wrap items-center justify-between gap-4">
                <div>
                    <h2 className="m-0 text-xl font-semibold text-stone-950 dark:text-stone-100">{t("userCenter.generationsTitle")}</h2>
                    <p className="mt-1 text-sm text-stone-500">{t("userCenter.generationsDesc")}</p>
                </div>
                <div className="flex items-center gap-2">
                    <Button icon={<RefreshCw className="size-4" />} onClick={() => void refetch()} loading={isFetching}>
                        {t("common.refresh")}
                    </Button>
                    <Link to="/image">
                        <Button type="primary" icon={<Sparkles className="size-4" />}>
                            {t("userCenter.goToGenerate")}
                        </Button>
                    </Link>
                </div>
            </div>

            <div className="flex items-center gap-2 rounded-xl border border-sky-200 bg-sky-50/70 p-3.5 text-xs leading-5 text-sky-900 dark:border-sky-900/50 dark:bg-sky-950/30 dark:text-sky-200">
                <Info className="size-4 shrink-0 text-sky-600 dark:text-sky-400" />
                <span>{t("userCenter.retentionHint", { days: batches[0]?.retentionDays || DEFAULT_RETENTION_DAYS })}</span>
            </div>

            <div className="flex flex-wrap items-center gap-3">
                <Input
                    prefix={<Search className="size-4 text-stone-400" />}
                    placeholder={t("userCenter.searchPromptPlaceholder")}
                    value={searchPrompt}
                    onChange={(event) => setSearchPrompt(event.target.value)}
                    allowClear
                    className="max-w-xs"
                />
                <Select
                    value={statusFilter}
                    onChange={setStatusFilter}
                    className="w-36"
                    options={[
                        { value: "all", label: t("userCenter.filterStatusAll") },
                        { value: "temporary", label: t("userCenter.filterStatusTemporary") },
                        { value: "permanent", label: t("userCenter.filterStatusPermanent") },
                        { value: "expiring", label: t("userCenter.filterStatusExpiring") },
                    ]}
                />
            </div>

            {isLoading ? (
                <div className="flex h-64 items-center justify-center">
                    <Spin size="large" />
                </div>
            ) : !filteredBatches.length ? (
                <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t("userCenter.emptyGenerations")} className="my-16">
                    <Link to="/image">
                        <Button type="primary" icon={<Sparkles className="size-4" />}>
                            {t("userCenter.goToGenerate")}
                        </Button>
                    </Link>
                </Empty>
            ) : (
                <div className="space-y-4">
                    {filteredBatches.map((batch) => (
                        <GenerationBatchCard key={batch.id} batch={batch} listOffset={offset} />
                    ))}
                </div>
            )}

            {batches.length ? (
                <div className="flex items-center justify-center gap-2">
                    <Button disabled={offset === 0 || isFetching} onClick={() => setOffset((current) => Math.max(current - GENERATION_PAGE_SIZE, 0))}>
                        {t("common.previousPage")}
                    </Button>
                    <span className="text-xs text-stone-500">{t("common.pageIndex", { page: offset / GENERATION_PAGE_SIZE + 1 })}</span>
                    <Button disabled={!data?.hasMore || isFetching} onClick={() => setOffset((current) => current + GENERATION_PAGE_SIZE)}>
                        {t("common.nextPage")}
                    </Button>
                </div>
            ) : null}
        </div>
    );
}

function GenerationBatchCard({ batch, listOffset }: { batch: GenerationBatchListItem; listOffset: number }) {
    const { t } = useTranslation();
    const { message } = App.useApp();
    const navigate = useNavigate();
    const copyText = useCopyText();
    const queryClient = useQueryClient();
    const hydrateAssets = useAssetStore((state) => state.hydrateAssets);
    const [expanded, setExpanded] = useState(false);
    const [savingMedia, setSavingMedia] = useState<Record<string, boolean>>({});

    const remainingDays = expirationDays(batch.createdAt, batch.retentionDays);
    const isExpired = remainingDays <= 0;

    const { data: detail, isFetching: isLoadingDetail } = useQuery({
        queryKey: detailKey(batch.id),
        queryFn: () => getGenerationBatch(batch.id),
        enabled: expanded,
        // 只有该批次仍有未完成任务时才继续轮询详情。
        refetchInterval: (query) =>
            (query.state.data?.tasks ?? []).some((task) => task.status === "reviewing" || task.status === "queued" || task.status === "running") ? 3000 : false,
    });

    const isAllSaved = Boolean(detail && detail.tasks.length > 0 && detail.tasks.every((task) => task.image?.isSaved));

    const deleteMutation = useMutation({
        mutationFn: () => deleteGenerationBatch(batch.id),
        onSuccess: async () => {
            message.success(t("userCenter.deleteBatchSuccess"));
            await queryClient.invalidateQueries({ queryKey: listKey(listOffset) });
        },
        onError: (error) => message.error(error instanceof Error ? error.message : t("userCenter.deleteBatchFailed")),
    });

    /** 转存成功后强制刷新素材 store，否则「我的素材」页会一直显示旧数据。 */
    const syncAssets = async () => {
        await queryClient.invalidateQueries({ queryKey: detailKey(batch.id) });
        const userId = useAssetStore.getState().hydratedUserId;
        if (userId) await hydrateAssets(userId, true);
    };

    const saveMedia = async (mediaId: string) => {
        setSavingMedia((current) => ({ ...current, [mediaId]: true }));
        try {
            await createAsset({ type: "image", mediaId, title: batch.prompt.slice(0, 40) || t("userCenter.generatedAssetTitle"), scope: "private" });
            message.success(t("userCenter.savedSuccess"));
            await syncAssets();
        } catch (error) {
            message.error(error instanceof Error ? error.message : t("userCenter.saveFailedToAsset"));
        } finally {
            setSavingMedia((current) => ({ ...current, [mediaId]: false }));
        }
    };

    const saveBatchMutation = useMutation({
        mutationFn: async () => {
            const pending = (detail?.tasks ?? []).flatMap((task) => (task.image?.mediaId && !task.image.isSaved ? [task.image.mediaId] : []));
            if (!pending.length) return { saved: 0, failed: 0 };
            const results = await Promise.allSettled(
                pending.map((mediaId) =>
                    createAsset({ type: "image", mediaId, title: batch.prompt.slice(0, 40) || t("userCenter.generatedAssetTitle"), scope: "private" }),
                ),
            );
            return { saved: results.filter((item) => item.status === "fulfilled").length, failed: results.filter((item) => item.status === "rejected").length };
        },
        onSuccess: async ({ saved, failed }) => {
            // 只按实际成功数提示；失败的图片保持未转存状态，最终以服务端返回的详情为准。
            if (!saved && !failed) message.info(t("userCenter.allAlreadySaved"));
            else if (failed) message.warning(t("userCenter.saveAllPartial", { count: saved, failed }));
            else message.success(t("userCenter.saveAllSuccess", { count: saved }));
            await syncAssets();
        },
        onError: (error) => message.error(error instanceof Error ? error.message : t("userCenter.saveAllFailed")),
    });

    const downloadMutation = useMutation({
        mutationFn: async () => {
            const images = (detail?.tasks ?? []).flatMap((task) => (task.image?.url ? [{ url: task.image.url, name: `image_${task.sequence + 1}.png` }] : []));
            if (!images.length) throw new Error(t("userCenter.downloadEmpty"));
            const files = await Promise.all(
                images.map(async (image) => ({ name: image.name, data: await (await fetch(image.url, { credentials: "include" })).blob() })),
            );
            saveAs(await createZip(files), `batch_${batch.id.slice(0, 8)}.zip`);
        },
        onError: (error) => message.error(error instanceof Error ? error.message : t("userCenter.downloadZipFailed")),
    });

    return (
        <Card className="overflow-hidden border-stone-200 transition-shadow hover:shadow-sm dark:border-stone-800" styles={{ body: { padding: "1rem" } }}>
            <div className="flex flex-col gap-3">
                <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="flex flex-wrap items-center gap-2">
                        <span className="font-mono text-xs text-stone-500">{dayjs(batch.createdAt).format("YYYY-MM-DD HH:mm:ss")}</span>
                        {isAllSaved ? (
                            <Tag color="success">{t("userCenter.savedPermanent")}</Tag>
                        ) : isExpired ? (
                            <Tag color="error">{t("userCenter.expiresToday")}</Tag>
                        ) : (
                            <Tag color={remainingDays <= 3 ? "warning" : "default"} icon={<Clock className="size-3" />}>
                                {t("userCenter.expiresInDays", { days: remainingDays })}
                            </Tag>
                        )}
                        {batch.summary ? (
                            <span className="text-xs text-stone-500">
                                {t("userCenter.batchCounts", { total: batch.summary.totalCount, succeeded: batch.summary.succeededCount })}
                            </span>
                        ) : null}
                    </div>
                    <div className="flex items-center gap-1.5">
                        <Tooltip title={t("userCenter.remixPrompt")}>
                            <Button
                                size="small"
                                type="text"
                                className="text-purple-600 hover:text-purple-700 dark:text-purple-400"
                                icon={<Wand2 className="size-3.5" />}
                                onClick={() => navigate("/image", { state: { prompt: batch.prompt, modelId: batch.modelId } })}
                            />
                        </Tooltip>
                        <Tooltip title={t("common.copyPrompt")}>
                            <Button size="small" type="text" icon={<Copy className="size-3.5" />} onClick={() => copyText(batch.prompt, t("common.promptCopied"))} />
                        </Tooltip>
                        {detail && !isAllSaved ? (
                            <Tooltip title={t("userCenter.saveAllToAsset")}>
                                <Button
                                    size="small"
                                    type="text"
                                    className="text-amber-600 hover:text-amber-700 dark:text-amber-400"
                                    icon={<FolderSync className="size-3.5" />}
                                    loading={saveBatchMutation.isPending}
                                    onClick={() => saveBatchMutation.mutate()}
                                />
                            </Tooltip>
                        ) : null}
                        {detail ? (
                            <Tooltip title={t("userCenter.downloadAllImages")}>
                                <Button size="small" type="text" icon={<Download className="size-3.5" />} loading={downloadMutation.isPending} onClick={() => downloadMutation.mutate()} />
                            </Tooltip>
                        ) : null}
                        <Popconfirm
                            title={t("userCenter.deleteBatchConfirm")}
                            description={t("userCenter.deleteBatchDesc")}
                            onConfirm={() => deleteMutation.mutate()}
                            okText={t("common.delete")}
                            cancelText={t("common.cancel")}
                            okButtonProps={{ danger: true, loading: deleteMutation.isPending }}
                        >
                            <Button size="small" type="text" danger icon={<Trash2 className="size-3.5" />} />
                        </Popconfirm>
                    </div>
                </div>

                <div className="rounded-lg bg-stone-50 px-3 py-2 text-sm text-stone-800 dark:bg-stone-900/60 dark:text-stone-200">
                    <span className="font-medium">{batch.prompt}</span>
                </div>

                {!detail ? (
                    <div className="flex items-center justify-between pt-1">
                        <div className="flex items-center gap-2 overflow-hidden">
                            {batch.summary?.thumbnailMediaIds.map((mediaId) => (
                                <img
                                    key={mediaId}
                                    src={`/api/media/${mediaId}`}
                                    alt={batch.prompt}
                                    className="size-12 rounded-lg border border-stone-200 object-cover dark:border-stone-800"
                                    loading="lazy"
                                />
                            ))}
                        </div>
                        <Button size="small" loading={isLoadingDetail} onClick={() => setExpanded(true)}>
                            {t("userCenter.viewDetail")}
                        </Button>
                    </div>
                ) : (
                    <div className="grid grid-cols-2 gap-3 pt-2 sm:grid-cols-3 md:grid-cols-4">
                        {detail.tasks.map((task) => (
                            <div
                                key={task.id}
                                className="group relative flex flex-col overflow-hidden rounded-xl border border-stone-200 bg-stone-50 dark:border-stone-800 dark:bg-stone-900/40"
                            >
                                {task.image?.url ? (
                                    <div className="relative aspect-square w-full overflow-hidden bg-stone-100 dark:bg-stone-950">
                                        <Image src={task.image.url} alt={batch.prompt} className="h-full w-full object-cover" preview={{ mask: t("userCenter.previewMask") }} />
                                        {task.image.isSaved ? (
                                            <div className="absolute right-2 top-2 z-10">
                                                <Tag color="success" className="!m-0">
                                                    {t("userCenter.savedPermanent")}
                                                </Tag>
                                            </div>
                                        ) : null}
                                    </div>
                                ) : (
                                    <div className="flex aspect-square w-full items-center justify-center p-3 text-center text-xs text-stone-400">
                                        {task.status === "failed" ? (
                                            <span className="text-red-500">{t("userCenter.taskFailedReason", { reason: task.errorMessage || t("userCenter.unknownError") })}</span>
                                        ) : (
                                            <span>{t(`userCenter.task${task.status.charAt(0).toUpperCase() + task.status.slice(1)}`)}</span>
                                        )}
                                    </div>
                                )}

                                {task.image?.mediaId ? (
                                    <div className="flex items-center justify-between border-t border-stone-200 p-2 text-xs dark:border-stone-800">
                                        <span className="font-mono text-stone-400">{task.image.bytes ? formatBytes(task.image.bytes) : ""}</span>
                                        <div className="flex items-center gap-1">
                                            {!task.image.isSaved ? (
                                                <Tooltip title={t("userCenter.saveToAsset")}>
                                                    <Button
                                                        size="small"
                                                        type="text"
                                                        icon={<FolderPlus className="size-3.5 text-amber-600" />}
                                                        loading={savingMedia[task.image.mediaId]}
                                                        onClick={() => void saveMedia(task.image!.mediaId)}
                                                    />
                                                </Tooltip>
                                            ) : null}
                                            <a
                                                href={task.image.url}
                                                download={`image_${task.sequence + 1}.png`}
                                                className="inline-flex size-6 items-center justify-center rounded text-stone-500 hover:text-stone-900 dark:hover:text-stone-100"
                                            >
                                                <Download className="size-3.5" />
                                            </a>
                                        </div>
                                    </div>
                                ) : null}
                            </div>
                        ))}
                    </div>
                )}
            </div>
        </Card>
    );
}

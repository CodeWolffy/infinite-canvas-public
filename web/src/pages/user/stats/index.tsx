import { useEffect, useState } from "react";
import { App, Button, Card, Progress, Spin } from "antd";
import { Database, FolderHeart, HardDrive, Image as ImageIcon, MessageSquare, RefreshCw, ShieldCheck } from "lucide-react";
import { useTranslation } from "react-i18next";

import { formatBytes } from "@/lib/image-utils";
import { getUserStats, type UserStats } from "@/services/api/user-center";

export default function UserStatsPage() {
    const { t } = useTranslation();
    const { message } = App.useApp();
    const [stats, setStats] = useState<UserStats | null>(null);
    const [loading, setLoading] = useState(false);

    const loadStats = async () => {
        setLoading(true);
        try {
            const data = await getUserStats();
            setStats(data);
        } catch {
            message.error("获取个人统计失败");
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        void loadStats();
    }, []);

    if (loading && !stats) {
        return (
            <div className="flex h-64 items-center justify-center">
                <Spin size="large" />
            </div>
        );
    }

    const imageSuccessRate = stats && stats.images.total > 0
        ? Math.round((stats.images.succeeded / stats.images.total) * 100)
        : 100;

    const totalMedia = stats?.storage.totalCount || 0;
    const permanentCount = stats?.assetCount || 0;
    const tempCount = Math.max(0, totalMedia - permanentCount);
    const permanentPercent = totalMedia > 0 ? Math.min(100, Math.round((permanentCount / totalMedia) * 100)) : 100;

    return (
        <div className="mx-auto max-w-5xl space-y-6 p-4 sm:p-6 lg:p-8">
            <div className="flex flex-wrap items-center justify-between gap-4">
                <div>
                    <h2 className="m-0 text-xl font-semibold text-stone-950 dark:text-stone-100">
                        {t("userCenter.statsTitle")}
                    </h2>
                    <p className="mt-1 text-sm text-stone-500">
                        {t("userCenter.statsDesc")}
                    </p>
                </div>
                <Button icon={<RefreshCw className="size-4" />} onClick={() => void loadStats()} loading={loading}>
                    刷新
                </Button>
            </div>

            {stats && (
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
                    <Card className="border-stone-200 dark:border-stone-800">
                        <div className="flex items-center gap-3">
                            <div className="flex size-10 items-center justify-center rounded-xl bg-purple-50 text-purple-600 dark:bg-purple-950/40 dark:text-purple-400">
                                <ImageIcon className="size-5" />
                            </div>
                            <div>
                                <div className="text-xs text-stone-500">{t("userCenter.cardImages")}</div>
                                <div className="text-2xl font-bold text-stone-950 dark:text-stone-100">
                                    {stats.images.total}
                                </div>
                            </div>
                        </div>
                        <div className="mt-3 flex items-center justify-between text-xs text-stone-500 border-t border-stone-100 pt-2 dark:border-stone-800/60">
                            <span>{t("userCenter.cardImagesSub", { succeeded: stats.images.succeeded, failed: stats.images.failed })}</span>
                        </div>
                    </Card>

                    <Card className="border-stone-200 dark:border-stone-800">
                        <div className="flex items-center gap-3">
                            <div className="flex size-10 items-center justify-center rounded-xl bg-sky-50 text-sky-600 dark:bg-sky-950/40 dark:text-sky-400">
                                <HardDrive className="size-5" />
                            </div>
                            <div>
                                <div className="text-xs text-stone-500">{t("userCenter.cardStorage")}</div>
                                <div className="text-2xl font-bold text-stone-950 dark:text-stone-100">
                                    {formatBytes(stats.storage.totalBytes) || "0 B"}
                                </div>
                            </div>
                        </div>
                        <div className="mt-3 flex items-center justify-between text-xs text-stone-500 border-t border-stone-100 pt-2 dark:border-stone-800/60">
                            <span>{stats.storage.quotaBytes ? `${formatBytes(stats.storage.totalBytes) || "0 B"} / ${formatBytes(stats.storage.quotaBytes)}` : t("userCenter.cardStorageSub", { count: stats.storage.totalCount })}</span>
                        </div>
                    </Card>

                    <Card className="border-stone-200 dark:border-stone-800">
                        <div className="flex items-center gap-3">
                            <div className="flex size-10 items-center justify-center rounded-xl bg-emerald-50 text-emerald-600 dark:bg-emerald-950/40 dark:text-emerald-400">
                                <MessageSquare className="size-5" />
                            </div>
                            <div>
                                <div className="text-xs text-stone-500">{t("userCenter.cardText")}</div>
                                <div className="text-2xl font-bold text-stone-950 dark:text-stone-100">
                                    {stats.text.total}
                                </div>
                            </div>
                        </div>
                        <div className="mt-3 flex items-center justify-between text-xs text-stone-500 border-t border-stone-100 pt-2 dark:border-stone-800/60">
                            <span>{t("userCenter.cardTextSub", { succeeded: stats.text.succeeded })}</span>
                        </div>
                    </Card>

                    <Card className="border-stone-200 dark:border-stone-800">
                        <div className="flex items-center gap-3">
                            <div className="flex size-10 items-center justify-center rounded-xl bg-amber-50 text-amber-600 dark:bg-amber-950/40 dark:text-amber-400">
                                <FolderHeart className="size-5" />
                            </div>
                            <div>
                                <div className="text-xs text-stone-500">{t("userCenter.cardAssets")}</div>
                                <div className="text-2xl font-bold text-stone-950 dark:text-stone-100">
                                    {stats.assetCount + stats.canvasCount}
                                </div>
                            </div>
                        </div>
                        <div className="mt-3 flex items-center justify-between text-xs text-stone-500 border-t border-stone-100 pt-2 dark:border-stone-800/60">
                            <span>{t("userCenter.cardAssetsSub", { assets: stats.assetCount, canvases: stats.canvasCount })}</span>
                        </div>
                    </Card>
                </div>
            )}

            {stats ? <><div className="grid grid-cols-1 gap-6 sm:grid-cols-2">{[{ label: "视频生成", data: stats.video }, { label: "音频生成", data: stats.audio }].map(({ label, data }) => <Card key={label}><p className="text-sm text-muted-foreground">{label}</p><p className="my-2 font-mono text-2xl">{data.total}</p><p className="text-xs text-muted-foreground">成功 {data.succeeded} · 失败 {data.failed} · 进行中 {data.active}</p></Card>)}</div>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">{[["本月实付", stats.spent], ["本月充值", stats.recharge], ["本月公益额度", stats.grants], ["本月签到", stats.checkin]].map(([label, value]) => <Card key={label}><p className="text-sm text-muted-foreground">{label}</p><p className="mt-2 font-mono text-2xl">¥{value || "0.000000"}</p></Card>)}</div></> : null}
            {stats && (
                <div className="grid grid-cols-1 gap-6 sm:grid-cols-2">
                    <Card title={t("userCenter.storageComposition")} className="border-stone-200 dark:border-stone-800">
                        <div className="space-y-4 py-2">
                            <div>
                                <div className="flex justify-between text-xs text-stone-500 mb-1">
                                    <span>{t("userCenter.storagePermanentRatio")}</span>
                                    <span>{permanentPercent}%</span>
                                </div>
                                <Progress
                                    percent={permanentPercent}
                                    strokeColor="#8b5cf6"
                                    showInfo={false}
                                />
                            </div>
                            <div className="rounded-lg bg-stone-50 p-3 text-xs leading-5 text-stone-600 dark:bg-stone-900/60 dark:text-stone-300">
                                <div className="flex items-center gap-1.5 font-medium text-stone-950 dark:text-stone-100 mb-1">
                                    <ShieldCheck className="size-4 text-purple-600 dark:text-purple-400" />
                                    <span>资产健康提示</span>
                                </div>
                                {t("userCenter.storageHealthyTip", { tempCount })}
                            </div>
                        </div>
                    </Card>

                    <Card title={t("userCenter.successRate")} className="border-stone-200 dark:border-stone-800">
                        <div className="flex flex-col items-center justify-center py-2">
                            <Progress
                                type="circle"
                                percent={imageSuccessRate}
                                strokeColor={{
                                    "0%": "#10b981",
                                    "100%": "#059669",
                                }}
                                width={110}
                            />
                            <div className="mt-3 text-center text-xs text-stone-500">
                                累计生图成功率
                            </div>
                        </div>
                    </Card>
                </div>
            )}
        </div>
    );
}

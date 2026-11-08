import { useDeferredValue, useEffect, useState, useSyncExternalStore } from "react";
import { useQuery } from "@tanstack/react-query";
import { Alert, Button, Empty, Input, Modal, Pagination, Spin, Tag, theme } from "antd";
import { Search } from "lucide-react";
import { useTranslation } from "react-i18next";

import { cn } from "@/lib/utils";
import { getImagePreviewRevision, subscribeImagePreviews } from "@/services/image-storage";
import { assetCoverUrl, normalizeAsset, type Asset } from "@/stores/use-asset-store";
import { listAssetPage, type AssetType } from "@/services/api/assets";
import { assertCurrentSession, useUserStore } from "@/stores/use-user-store";

export type InsertAssetPayload = { kind: "text"; content: string; title: string } | { kind: "image"; dataUrl: string; title: string; storageKey?: string } | { kind: "video"; url: string; title: string; storageKey?: string; width?: number; height?: number } | { kind: "audio"; url: string; title: string; storageKey?: string; bytes?: number; mimeType?: string };

type Props = {
    open: boolean;
    defaultTab?: string;
    onInsert: (payload: InsertAssetPayload) => void;
    onClose: () => void;
};

export function AssetPickerModal({ open, onInsert, onClose }: Props) {
    const { t } = useTranslation();
    return (
        <Modal title={t("canvas.assetPicker.title")} open={open} onCancel={onClose} footer={null} width={860} destroyOnHidden styles={{ body: { padding: "0 24px 24px", minHeight: 480 } }}>
            <MyAssetsTab open={open} onInsert={onInsert} />
        </Modal>
    );
}

const PAGE_SIZE = 8;

const kindOptions = ["all", "text", "image", "video", "audio"] as const;

function PickerCard({ title, kind, cover, onClick }: { title: string; kind: string; cover: string; onClick: () => void }) {
    const { t } = useTranslation();
    const { token } = theme.useToken();
    return (
        <button
            type="button"
            className="group relative cursor-pointer overflow-hidden rounded-lg border text-left transition hover:opacity-80"
            style={{ borderColor: token.colorBorderSecondary, color: token.colorText, background: token.colorBgContainer }}
            onClick={onClick}
        >
            {cover ? (
                <img src={cover} alt={title} className="aspect-[4/3] w-full object-cover" />
            ) : (
                <div className="flex aspect-[4/3] items-center justify-center p-3 text-center text-xs leading-5" style={{ color: token.colorTextSecondary }}>{title}</div>
            )}
            <div className="p-2.5">
                <div className="flex items-center justify-between gap-2">
                    <span className="line-clamp-1 text-xs font-medium">{title}</span>
                    <Tag className="m-0 shrink-0 text-[10px]">{t(`assets.kinds.${kind}`)}</Tag>
                </div>
            </div>
        </button>
    );
}

function MyAssetsTab({ open, onInsert }: { open: boolean; onInsert: (payload: InsertAssetPayload) => void }) {
    const { t } = useTranslation();
    useSyncExternalStore(subscribeImagePreviews, getImagePreviewRevision);
    const session = useUserStore((state) => state.sessionVersion);
    const [keyword, setKeyword] = useState("");
    const deferredKeyword = useDeferredValue(keyword.trim());
    const [kindFilter, setKindFilter] = useState<AssetType | "all">("all");
    const [page, setPage] = useState(1);

    const query = useQuery({
        queryKey: ["canvas", "asset-picker", session, deferredKeyword, kindFilter, page],
        enabled: open,
        queryFn: async () => {
            const result = await listAssetPage({ page, size: PAGE_SIZE, scope: "all", kind: kindFilter, keyword: deferredKeyword });
            assertCurrentSession(session);
            return { ...result, assets: result.assets.map(normalizeAsset) };
        },
    });
    const visible = query.data?.assets || [];

    useEffect(() => {
        if (!query.data) return;
        const maxPage = Math.max(1, Math.ceil(query.data.total / PAGE_SIZE));
        setPage((v) => Math.min(v, maxPage));
    }, [query.data]);

    const handleInsert = (asset: Asset) => {
        if (asset.kind === "text") {
            onInsert({ kind: "text", content: asset.data.content, title: asset.title });
        } else if (asset.kind === "audio") {
            onInsert({ kind: "audio", url: asset.data.url, storageKey: asset.data.storageKey, title: asset.title, bytes: asset.data.bytes, mimeType: asset.data.mimeType });
        } else {
            onInsert(asset.kind === "video" ? { kind: "video", url: asset.data.url, storageKey: asset.data.storageKey, title: asset.title, width: asset.data.width, height: asset.data.height } : { kind: "image", dataUrl: asset.data.dataUrl, storageKey: asset.data.storageKey, title: asset.title });
        }
    };

    return (
        <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-3">
                <Input
                    className="w-56"
                    size="small"
                    prefix={<Search className="size-3.5 text-stone-400" />}
                    placeholder={t("canvas.assetPicker.search")}
                    value={keyword}
                    allowClear
                    onChange={(e) => {
                        setPage(1);
                        setKeyword(e.target.value);
                    }}
                />
                <div className="flex gap-1.5">
                    {kindOptions.map((option) => (
                        <Tag.CheckableTag
                            key={option}
                            checked={kindFilter === option}
                            className={cn("prompt-filter-tag", kindFilter === option && "is-active")}
                            onChange={() => {
                                setPage(1);
                                setKindFilter(option);
                            }}
                        >
                            {option === "all" ? t("common.all") : t(`assets.kinds.${option}`)}
                        </Tag.CheckableTag>
                    ))}
                </div>
            </div>

            {query.isError ? <Alert type="error" title="素材加载失败" description={query.error.message} action={<Button onClick={() => void query.refetch()}>重试</Button>} /> : query.isPending ? <div className="flex justify-center py-12"><Spin /></div> : visible.length ? (
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                    {visible.map((asset) => (
                        <PickerCard key={asset.id} title={asset.title} kind={asset.kind} cover={assetCoverUrl(asset)} onClick={() => handleInsert(asset)} />
                    ))}
                </div>
            ) : (
                <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t("canvas.assetPicker.empty")} className="py-12" />
            )}

            {(query.data?.total || 0) > PAGE_SIZE && (
                <div className="flex justify-center">
                    <Pagination size="small" current={page} pageSize={PAGE_SIZE} total={query.data?.total} onChange={setPage} showSizeChanger={false} />
                </div>
            )}
        </div>
    );
}

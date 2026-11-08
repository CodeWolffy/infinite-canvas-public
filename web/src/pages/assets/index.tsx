import { ArrowUpRight, Copy, Download, Ellipsis, PencilLine, Search, Share2, Trash2, Upload, Users } from "lucide-react";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, App, Button, Card, Drawer, Dropdown, Empty, Form, Image, Input, Modal, Pagination, Select, Space, Tag, Typography } from "antd";
import { saveAs } from "file-saver";
import { useTranslation } from "react-i18next";

import { useCopyText } from "@/hooks/use-copy-text";
import { formatBytes, readFileAsDataUrl } from "@/lib/image-utils";
import { getMediaBlob } from "@/services/file-storage";
import { getImageBlob, getImagePreviewRevision, subscribeImagePreviews, uploadImage } from "@/services/image-storage";
import { ASSET_PAGE_SIZE, getAsset, listAssetPage } from "@/services/api/assets";
import { ApiError } from "@/services/api/request";
import { cn } from "@/lib/utils";
import { assetCoverUrl, normalizeAsset, useAssetStore, type Asset, type AssetKind, type AssetScope, type ImageAsset } from "@/stores/use-asset-store";
import { assertCurrentSession, useUserStore } from "@/stores/use-user-store";
import { exportAssets } from "./asset-transfer";
import { useAssetImport } from "./use-asset-import";
import { ShareDialog } from "@/components/share-dialog";
import { WorkspaceMoveButton } from "@/components/workspace-move-button";
import { useAssetCreation } from "./use-asset-creation";

type AssetFormValues = {
    kind: AssetKind;
    scope: AssetScope;
    title: string;
    coverUrl: string;
    tags: string[];
    source?: string;
    note?: string;
    content?: string;
};

type ImageDraft = ImageAsset["data"] | null;

const kindOptions = ["all", "text", "image", "video", "audio"] as const;

export default function AssetsPage() {
    const { message } = App.useApp();
    const { t } = useTranslation();
    const copyText = useCopyText();
    const [form] = Form.useForm<AssetFormValues>();
    const coverInputRef = useRef<HTMLInputElement>(null);
    const imageInputRef = useRef<HTMLInputElement>(null);
    const assetInputRef = useRef<HTMLInputElement>(null);
    const formVersion = useRef(0);
    const fileReads = useRef<{ cover?: AbortController; image?: AbortController }>({});
    const queryClient = useQueryClient();
    const addAsset = useAssetStore((state) => state.addAsset);
    const updateAsset = useAssetStore((state) => state.updateAsset);
    const removeAsset = useAssetStore((state) => state.removeAsset);
    const isAdmin = useUserStore((state) => state.user?.role === "admin");
    const [saving, setSaving] = useState(false);
    const [deleting, setDeleting] = useState(false);
    const [assetConflict, setAssetConflict] = useState(false);
    const [exportingSession, setExportingSession] = useState<number | null>(null);
    const [keyword, setKeyword] = useState("");
    const [kindFilter, setKindFilter] = useState<AssetKind | "all">("all");
    const [page, setPage] = useState(1);
    const [pageSize, setPageSize] = useState(10);
    const [editingAsset, setEditingAsset] = useState<Asset | null>(null);
    const [isAssetOpen, setIsAssetOpen] = useState(false);
    const [previewAsset, setPreviewAsset] = useState<Asset | null>(null);
    const [deletingAsset, setDeletingAsset] = useState<Asset | null>(null);
    const [formKind, setFormKind] = useState<AssetKind>("text");
    const [imageDraft, setImageDraft] = useState<ImageDraft>(null);
    const coverUrl = Form.useWatch("coverUrl", form) || "";
    const title = Form.useWatch("title", form) || "";
    const tags = Form.useWatch("tags", form) || [];
    const content = Form.useWatch("content", form) || "";
    // 素材列表改为服务端分页：关键词与类型筛选随分页一起下发，避免只过滤当前页。
    const sessionVersion = useUserStore((state) => state.sessionVersion);
    const exporting = exportingSession === sessionVersion;
    const assetsQuery = useQuery({
        queryKey: ["assets", sessionVersion, page, pageSize, kindFilter, keyword.trim()],
        queryFn: () => listAssetPage({ page, size: pageSize, kind: kindFilter, keyword }),
        placeholderData: (previous, query) => query?.queryKey[1] === sessionVersion ? keepPreviousData(previous) : undefined,
    });
    const visibleAssets = (assetsQuery.data?.assets || []).map(normalizeAsset);
    const total = assetsQuery.data?.total || 0;
    const refreshAssets = () => { void queryClient.invalidateQueries({ queryKey: ["assets"] }); };
    const assetImport = useAssetImport(refreshAssets);

    useEffect(() => {
        setIsAssetOpen(false);
        setEditingAsset(null);
        setPreviewAsset(null);
        setImageDraft(null);
        setSaving(false);
        setAssetConflict(false);
        return () => {
            formVersion.current++;
            fileReads.current.cover?.abort();
            fileReads.current.image?.abort();
        };
    }, [sessionVersion]);

    const invalidateForm = () => {
        formVersion.current++;
        fileReads.current.cover?.abort();
        fileReads.current.image?.abort();
        setSaving(false);
        setAssetConflict(false);
        setPreviewAsset(null);
    };

    const captureForm = () => {
        const version = formVersion.current;
        const session = useUserStore.getState().sessionVersion;
        return () => formVersion.current === version && useUserStore.getState().sessionVersion === session;
    };

    const closeAsset = () => {
        invalidateForm();
        setIsAssetOpen(false);
    };

    const openCreate = () => {
        invalidateForm();
        setEditingAsset(null);
        setImageDraft(null);
        setFormKind("text");
        form.setFieldsValue({ kind: "text", scope: "private", title: "", coverUrl: "", tags: [], source: t("assets.manual"), note: "", content: "" });
        setIsAssetOpen(true);
    };

    const openEdit = (asset: Asset) => {
        invalidateForm();
        setEditingAsset(asset);
        setFormKind(asset.kind);
        setImageDraft(asset.kind === "image" ? asset.data : null);
        form.setFieldsValue({
            kind: asset.kind,
            scope: asset.scope || "private",
            title: asset.title,
            coverUrl: asset.coverUrl,
            tags: asset.tags || [],
            source: asset.source,
            note: asset.note,
            content: asset.kind === "text" ? asset.data.content : "",
        });
        setIsAssetOpen(true);
    };

    const saveAsset = async (copy = false) => {
        if (saving) return;
        const isCurrent = captureForm();
        setSaving(true);
        try {
            const values = await form.validateFields();
            if (!isCurrent()) return;
            const base = {
                title: values.title.trim(),
                scope: copy ? "private" as const : values.scope,
                coverUrl: values.coverUrl?.trim() || (values.kind === "image" && imageDraft ? imageDraft.dataUrl : ""),
                tags: values.tags || [],
                source: values.source?.trim(),
                note: values.note?.trim(),
                metadata: editingAsset?.metadata || { source: "manual" },
            };
            if (values.kind === "text") {
                const asset = { ...base, kind: "text" as const, data: { content: (values.content || "").trim() } };
                await (editingAsset && !copy ? updateAsset(editingAsset, asset) : addAsset(asset));
            } else {
                if (!imageDraft) {
                    message.error(t("assets.selectImage"));
                    return;
                }
                const asset = { ...base, kind: "image" as const, data: imageDraft };
                await (editingAsset && !copy ? updateAsset(editingAsset, asset) : addAsset(asset));
            }
            if (!isCurrent()) return;
            message.success(copy ? "已另存为私人素材" : editingAsset ? t("assets.updated") : t("assets.saved"));
            refreshAssets();
            closeAsset();
        } catch (error) {
            if (!isCurrent() || (error && typeof error === "object" && "errorFields" in error)) return;
            if (error instanceof ApiError && error.code === "asset_conflict") { setAssetConflict(true); refreshAssets(); }
            else message.error(error instanceof Error ? error.message : "素材保存失败");
        } finally {
            if (isCurrent()) setSaving(false);
        }
    };

    const viewLatestAsset = async () => {
        if (!editingAsset) return;
        const isCurrent = captureForm();
        try { const asset = await getAsset(editingAsset.id); if (isCurrent()) setPreviewAsset(normalizeAsset(asset)); }
        catch (error) { if (isCurrent()) message.error(error instanceof Error ? error.message : "素材读取失败"); }
    };

    const readCoverFile = async (file?: File) => {
        if (!file) return;
        const isCurrentForm = captureForm();
        fileReads.current.cover?.abort();
        const controller = fileReads.current.cover = new AbortController();
        const isCurrent = () => isCurrentForm() && !controller.signal.aborted;
        try {
            const dataUrl = await readFileAsDataUrl(file);
            if (!isCurrent()) return;
            form.setFieldValue("coverUrl", dataUrl);
        } catch (error) {
            if (isCurrent()) message.error(error instanceof Error ? error.message : "封面读取失败");
        }
    };

    const readImageFile = async (file?: File) => {
        if (!file || !file.type.startsWith("image/")) return;
        const isCurrentForm = captureForm();
        fileReads.current.image?.abort();
        const controller = fileReads.current.image = new AbortController();
        const isCurrent = () => isCurrentForm() && !controller.signal.aborted;
        try {
            const image = await uploadImage(file, { signal: controller.signal });
            if (!isCurrent()) return;
            const draft = { dataUrl: image.url, storageKey: image.storageKey, width: image.width, height: image.height, bytes: image.bytes, mimeType: image.mimeType };
            setImageDraft(draft);
            if (!form.getFieldValue("coverUrl")) form.setFieldValue("coverUrl", draft.dataUrl);
            if (!form.getFieldValue("title")) form.setFieldValue("title", file.name);
        } catch (error) {
            if (isCurrent()) message.error(error instanceof Error ? error.message : "图片上传失败");
        }
    };

    const copyAssetText = async (asset: Asset) => {
        if (asset.kind !== "text") return;
        copyText(asset.data.content, t("assets.textCopied"));
    };

    const downloadImage = async (asset: Asset) => {
        if (asset.kind === "text") return;
        try {
            const blob = await readAssetMediaBlob(asset);
            if (!blob) {
                message.error(t("assets.downloadFailed"));
                return;
            }
            const ext = asset.data.mimeType?.split("/")[1]?.split("+")[0] || (asset.kind === "video" ? "mp4" : "png");
            saveAs(blob, `${asset.title || "asset"}.${ext}`);
        } catch {
            message.error(t("assets.downloadFailed"));
        }
    };

    const exportAllAssets = async () => {
        if (exporting) return;
        const session = useUserStore.getState().sessionVersion;
        const kind = kindFilter;
        const search = keyword.trim();
        setExportingSession(session);
        try {
            const assets: Asset[] = [];
            let total = 0;
            let nextPage = 1;
            do {
                const result = await listAssetPage({ page: nextPage++, size: ASSET_PAGE_SIZE, kind, keyword: search });
                assertCurrentSession(session);
                total = result.total;
                assets.push(...result.assets.map(normalizeAsset));
                if (!result.assets.length) break;
            } while (assets.length < total);
            if (!assets.length) message.warning(t("assets.noneToExport"));
            else await exportAssets(assets, t("assets.packageName"));
        } catch (error) {
            if (useUserStore.getState().sessionVersion === session) message.error(error instanceof Error ? error.message : "素材导出失败");
        } finally {
            if (useUserStore.getState().sessionVersion === session) setExportingSession(null);
        }
    };

    const confirmDelete = async () => {
        if (!deletingAsset || deleting) return;
        const session = useUserStore.getState().sessionVersion;
        setDeleting(true);
        try {
            await removeAsset(deletingAsset.id);
            assertCurrentSession(session);
            message.success(t("assets.deleted"));
            refreshAssets();
            setDeletingAsset(null);
        } catch (error) {
            if (useUserStore.getState().sessionVersion === session) message.error(error instanceof Error ? error.message : "素材删除失败");
        } finally {
            if (useUserStore.getState().sessionVersion === session) setDeleting(false);
        }
    };

    return (
        <div className="flex h-full flex-col overflow-hidden bg-background text-stone-900 dark:text-stone-100">
            <main className="min-h-0 flex-1 overflow-y-auto bg-[radial-gradient(#e5e7eb_1px,transparent_1px)] px-4 py-6 [background-size:16px_16px] sm:px-6 sm:py-8 dark:bg-[radial-gradient(rgba(245,245,244,.14)_1px,transparent_1px)]">
                <div className="pb-8">
                    <div className="mx-auto max-w-5xl text-center">
                        <h1 className="text-3xl font-semibold tracking-tight text-stone-950 sm:text-4xl dark:text-stone-100">{t("assets.title")}</h1>
                        <p className="mt-3 text-sm text-stone-500 dark:text-stone-400">{t("assets.description")}</p>
                    </div>

                    <div className="mx-auto mt-8 w-full max-w-2xl">
                        <Input.Search
                            className="w-full"
                            size="large"
                            allowClear
                            prefix={<Search className="size-4 text-stone-400" />}
                            value={keyword}
                            placeholder={t("assets.search")}
                            onChange={(event) => {
                                setPage(1);
                                setKeyword(event.target.value);
                            }}
                            onSearch={(value) => {
                                setPage(1);
                                setKeyword(value);
                            }}
                        />
                    </div>

                    <div className="mx-auto mt-6 grid max-w-6xl gap-3 text-left">
                        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                            <div className="grid gap-2 sm:grid-cols-[56px_minmax(0,1fr)] sm:items-center">
                                <div className="text-xs font-medium text-stone-500 dark:text-stone-400">{t("assets.type")}</div>
                                <div className="flex flex-wrap gap-2">
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
                            <div className="flex flex-wrap gap-4">
                                <button
                                    type="button"
                                    className="cursor-pointer text-sm font-medium text-stone-700 underline-offset-4 hover:underline focus-visible:outline-none focus-visible:underline dark:text-stone-300"
                                    onClick={() => void exportAllAssets()}
                                    disabled={exporting}
                                    aria-busy={exporting}
                                >
                                    {exporting ? "导出中…" : t("assets.export")}
                                </button>
                                <button
                                    type="button"
                                    className="cursor-pointer text-sm font-medium text-stone-700 underline-offset-4 hover:underline focus-visible:outline-none focus-visible:underline dark:text-stone-300"
                                    onClick={() => assetInputRef.current?.click()}
                                    disabled={assetImport.busy}
                                    aria-busy={assetImport.busy}
                                >
                                    {assetImport.busy ? "导入中…" : t("assets.import")}
                                </button>
                                <button
                                    type="button"
                                    className="cursor-pointer text-sm font-medium text-stone-700 underline-offset-4 hover:underline focus-visible:outline-none focus-visible:underline dark:text-stone-300"
                                    onClick={openCreate}
                                >
                                    {t("assets.add")}
                                </button>
                            </div>
                        </div>
                    </div>
                </div>

                <div className="mx-auto flex max-w-7xl flex-col gap-5">
                    {assetImport.filename ? <Alert type={assetImport.error || assetImport.items.some((item) => item.status === "failed") ? "warning" : assetImport.busy ? "info" : "success"} title={`${assetImport.filename} · 已导入 ${assetImport.items.filter((item) => item.status === "succeeded").length} / ${assetImport.items.length} 项${assetImport.busy ? " · 处理中" : ""}`} closable={!assetImport.busy} onClose={assetImport.clear} description={<div className="space-y-2">
                        {assetImport.error ? <div>{assetImport.error}</div> : null}
                        {assetImport.items.filter((item) => item.status === "failed").map((item) => <div key={item.requestId} className="text-sm">{item.title}：{item.error}</div>)}
                        {assetImport.items.some((item) => item.status === "failed") ? <Button type="link" className="!p-0" loading={assetImport.busy} onClick={() => void assetImport.retry()}>仅重试失败项</Button> : null}
                    </div>} /> : null}
                    <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                        {visibleAssets.map((asset) => (
                            <AssetCard key={asset.id} asset={asset} onOpen={() => setPreviewAsset(asset)} onEdit={() => openEdit(asset)} onCopy={copyAssetText} onDownload={downloadImage} onDelete={() => setDeletingAsset(asset)} onMoved={refreshAssets} />
                        ))}
                    </div>

                    {!visibleAssets.length ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={keyword || kindFilter !== "all" ? "没有符合条件的素材" : "把常用图片、文案和生成结果保存在这里，随时带入创作。"} className="py-20"><Button type="text" onClick={keyword || kindFilter !== "all" ? () => { setKeyword(""); setKindFilter("all"); setPage(1); } : openCreate}>{keyword || kindFilter !== "all" ? "清空筛选" : "添加第一份素材"}</Button></Empty> : null}

                    <div className="flex justify-center">
                        <Pagination
                            responsive
                            current={page}
                            pageSize={pageSize}
                            total={total}
                            showSizeChanger
                            pageSizeOptions={[10, 20, 50, 100]}
                            onChange={(nextPage, nextPageSize) => {
                                setPage(nextPageSize === pageSize ? nextPage : 1);
                                setPageSize(nextPageSize);
                            }}
                        />
                    </div>
                </div>
            </main>

            <Modal title={editingAsset ? t("assets.edit") : t("assets.add")} open={isAssetOpen} width={980} onCancel={() => { if (!saving) closeAsset(); }} onOk={() => void saveAsset()} confirmLoading={saving} okButtonProps={{ disabled: assetConflict }} cancelButtonProps={{ disabled: saving }} okText={t("common.save")} cancelText={t("common.cancel")} destroyOnHidden>
                {assetConflict ? <Alert type="warning" title="素材已有更新，当前输入已保留" description={<Space wrap><Button type="link" onClick={() => void viewLatestAsset()}>查看最新</Button><Button type="link" disabled={saving} onClick={() => void saveAsset(true)}>另存私人副本</Button></Space>} /> : null}
                <div className="grid gap-6 pt-1 lg:grid-cols-[minmax(0,1fr)_320px]">
                    <Form form={form} layout="vertical" disabled={saving} requiredMark={false} initialValues={{ kind: "text", scope: "private", tags: [] }}>
                        <Form.Item name="kind" label={t("assets.type")}>
                            <Select
                                options={[
                                    { label: t("assets.kinds.text"), value: "text" },
                                    { label: t("assets.kinds.image"), value: "image" },
                                ]}
                                onChange={(value) => { invalidateForm(); setFormKind(value); }}
                            />
                        </Form.Item>
                        <Form.Item name="scope" label="可见范围">
                            <Select options={[{ label: "私人素材", value: "private" }, ...(isAdmin ? [{ label: "公共素材", value: "public" }] : [])]} />
                        </Form.Item>
                        <Form.Item name="title" label={t("assets.fields.title")} rules={[{ required: true, message: t("assets.fields.titleRequired") }]}>
                            <Input size="large" placeholder={t("assets.fields.titlePlaceholder")} />
                        </Form.Item>
                        <Form.Item label={t("assets.fields.coverUrl")}>
                            <Space.Compact className="w-full">
                                <Form.Item name="coverUrl" noStyle>
                                    <Input placeholder={t("assets.fields.coverPlaceholder")} onChange={() => fileReads.current.cover?.abort()} />
                                </Form.Item>
                                <Button icon={<Upload className="size-3.5" />} onClick={() => coverInputRef.current?.click()}>
                                    {t("common.upload")}
                                </Button>
                            </Space.Compact>
                        </Form.Item>
                        <Form.Item name="tags" label={t("assets.fields.tags")}>
                            <Select mode="tags" tokenSeparators={[",", "，"]} placeholder={t("assets.fields.tagsPlaceholder")} />
                        </Form.Item>
                        <div className="grid gap-4 sm:grid-cols-2">
                            <Form.Item name="source" label={t("assets.fields.source")}>
                                <Input placeholder={t("assets.fields.sourcePlaceholder")} />
                            </Form.Item>
                            <Form.Item name="note" label={t("assets.fields.note")}>
                                <Input placeholder={t("assets.fields.optional")} />
                            </Form.Item>
                        </div>
                        {formKind === "text" ? (
                            <Form.Item name="content" label={t("assets.fields.textContent")} rules={[{ required: true, message: t("assets.fields.textRequired") }]}>
                                <Input.TextArea rows={8} placeholder={t("assets.fields.textPlaceholder")} />
                            </Form.Item>
                        ) : (
                            <Form.Item label={t("assets.fields.imageContent")} required>
                                <div className="rounded-lg border border-dashed border-stone-300 p-4 dark:border-stone-700">
                                    <Button icon={<Upload className="size-4" />} onClick={() => imageInputRef.current?.click()}>
                                        {t("assets.selectImageFile")}
                                    </Button>
                                    {imageDraft ? (
                                        <Typography.Text type="secondary" className="ml-3 text-xs">
                                            {imageDraft.width}x{imageDraft.height} · {formatBytes(imageDraft.bytes)}
                                        </Typography.Text>
                                    ) : (
                                        <Typography.Text type="secondary" className="ml-3 text-xs">
                                            {t("assets.noImageSelected")}
                                        </Typography.Text>
                                    )}
                                </div>
                            </Form.Item>
                        )}
                    </Form>
                    <div className="rounded-xl border border-stone-200 bg-stone-50 p-4 dark:border-stone-800 dark:bg-stone-950">
                        <Typography.Text strong>{t("assets.preview")}</Typography.Text>
                        <div className="mt-3 overflow-hidden rounded-lg border border-stone-200 bg-background dark:border-stone-800">
                            {coverUrl || imageDraft?.dataUrl ? (
                                <img src={coverUrl || imageDraft?.dataUrl} alt="" className="aspect-[4/3] w-full object-cover" />
                            ) : (
                                <div className="flex aspect-[4/3] items-center justify-center bg-stone-100 p-5 text-center text-sm text-stone-500 dark:bg-stone-900">{content || t("assets.noCover")}</div>
                            )}
                            <div className="p-4">
                                <Typography.Text strong ellipsis className="block">
                                    {title || t("assets.untitled")}
                                </Typography.Text>
                                <div className="mt-2 flex flex-wrap gap-1.5">
                                    {tags.length ? (
                                        tags.map((tag) => (
                                            <Tag key={tag} className="m-0">
                                                {tag}
                                            </Tag>
                                        ))
                                    ) : (
                                        <Tag className="m-0">{t("assets.untagged")}</Tag>
                                    )}
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
                <input
                    ref={coverInputRef}
                    type="file"
                    accept="image/*"
                    className="hidden"
                    onChange={(event) => {
                        void readCoverFile(event.target.files?.[0]);
                        event.target.value = "";
                    }}
                />
                <input
                    ref={imageInputRef}
                    type="file"
                    accept="image/*"
                    className="hidden"
                    onChange={(event) => {
                        void readImageFile(event.target.files?.[0]);
                        event.target.value = "";
                    }}
                />
            </Modal>

            <AssetDrawer asset={previewAsset} onClose={() => setPreviewAsset(null)} onCopy={copyAssetText} onDownload={downloadImage} />

            <input ref={assetInputRef} type="file" accept="application/zip,.zip" className="hidden" onChange={(event) => { void assetImport.start(event.target.files?.[0]); event.target.value = ""; }} />

            <Modal title={t("assets.deleteTitle")} open={Boolean(deletingAsset)} onCancel={() => { if (!deleting) setDeletingAsset(null); }} onOk={confirmDelete} confirmLoading={deleting} okText={t("common.delete")} okButtonProps={{ danger: true }} cancelButtonProps={{ disabled: deleting }} cancelText={t("common.cancel")}>
                {t("assets.deleteConfirm", { name: deletingAsset?.title })}
            </Modal>
        </div>
    );
}

function AssetCard({ asset, onOpen, onEdit, onCopy, onDownload, onDelete, onMoved }: { asset: Asset; onOpen: () => void; onEdit: () => void; onCopy: (asset: Asset) => void; onDownload: (asset: Asset) => void; onDelete: () => void; onMoved: () => void }) {
    const { t } = useTranslation();
    const [shareOpen, setShareOpen] = useState(false);
    useSyncExternalStore(subscribeImagePreviews, getImagePreviewRevision);
    const currentUserId = useUserStore((state) => state.user?.id);
    const mine = Boolean(asset.ownerId && asset.ownerId === currentUserId);
    const creationItems = useAssetCreation(asset);
    const cover = assetCoverUrl(asset);
    const summary = assetSummary(asset);
    return (
        <Card
            hoverable
            className="overflow-hidden"
            styles={{ body: { padding: 0 } }}
            cover={
                <button type="button" className="block w-full text-left" onClick={onOpen}>
                    {cover ? (
                        <img src={cover} alt={asset.title} className="aspect-[4/3] w-full object-cover" />
                    ) : (
                        <div className="flex aspect-[4/3] items-center justify-center bg-stone-100 p-5 text-center text-sm leading-6 text-stone-600 dark:bg-stone-900 dark:text-stone-300">{asset.kind === "text" ? asset.data.content : t("assets.noCover")}</div>
                    )}
                </button>
            }
        >
            <button type="button" className="block w-full text-left" onClick={onOpen}>
                <div className="p-4">
                    <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                            <h2 className="line-clamp-1 text-sm font-semibold text-stone-950 dark:text-stone-100">{asset.title}</h2>
                            <Typography.Text type="secondary" className="mt-1 block text-xs">
                                {asset.source || t("assets.unknownSource")}
                            </Typography.Text>
                        </div>
                        <div className="flex max-w-[50%] shrink-0 flex-col items-end gap-1">
                            <Tag className="m-0 text-[11px]">{t(`assets.kinds.${asset.kind}`)}</Tag>
                            {asset.workspaceName ? (
                                <Tag className="m-0 max-w-full truncate text-[11px]" title={asset.workspaceName} icon={<Users className="size-3" />}>
                                    {asset.workspaceName}
                                </Tag>
                            ) : null}
                        </div>
                    </div>
                    <Typography.Paragraph type="secondary" ellipsis={{ rows: 3 }} className="!mb-0 !mt-2 !text-xs !leading-5">
                        {summary}
                    </Typography.Paragraph>
                    <div className="mt-3 flex flex-wrap gap-1.5">
                        {(asset.tags || []).slice(0, 3).map((tag) => (
                            <Tag key={tag} className="m-0 text-[11px]">
                                {tag}
                            </Tag>
                        ))}
                        {!asset.tags?.length ? <Tag className="m-0 text-[11px]">{t("assets.noTags")}</Tag> : null}
                    </div>
                </div>
            </button>
            <div className="flex flex-wrap items-center gap-1 px-3 pb-3">
                <Button type="text" size="small" onClick={onOpen}>{t("common.view")}</Button>
                <Dropdown trigger={["click"]} menu={{ items: creationItems }}>
                    <Button type="text" size="small" icon={<ArrowUpRight className="size-3.5" />}>使用素材</Button>
                </Dropdown>
                <div className="ml-auto flex items-center gap-1">
                    {mine ? <WorkspaceMoveButton target={{ kind: "asset", id: asset.id, workspaceId: asset.workspaceId }} onMoved={() => onMoved()} /> : null}
                    <Dropdown trigger={["click"]} menu={{ items: [
                        ...(asset.kind !== "video" && asset.kind !== "audio" && asset.editable !== false ? [{ key: "edit", label: t("common.edit"), icon: <PencilLine className="size-4" />, onClick: onEdit }] : []),
                        asset.kind === "text" ? { key: "copy", label: t("common.copy"), icon: <Copy className="size-4" />, onClick: () => onCopy(asset) } : { key: "download", label: t("common.download"), icon: <Download className="size-4" />, onClick: () => onDownload(asset) },
                        ...(mine ? [{ key: "share", label: t("share.action"), icon: <Share2 className="size-4" />, onClick: () => setShareOpen(true) }] : []),
                        ...(asset.deletable !== false ? [{ key: "delete", label: t("common.delete"), danger: true, icon: <Trash2 className="size-4" />, onClick: onDelete }] : []),
                    ] }}>
                        <Button type="text" size="small" aria-label={`${asset.title}的更多操作`} icon={<Ellipsis className="size-4" />} />
                    </Dropdown>
                </div>
            </div>
            {shareOpen ? <ShareDialog kind="asset" targetId={asset.id} open={shareOpen} onClose={() => setShareOpen(false)} /> : null}
        </Card>
    );
}

function AssetDrawer({ asset, onClose, onCopy, onDownload }: { asset: Asset | null; onClose: () => void; onCopy: (asset: Asset) => void; onDownload: (asset: Asset) => void }) {
    const { t } = useTranslation();
    useSyncExternalStore(subscribeImagePreviews, getImagePreviewRevision);
    const creationItems = useAssetCreation(asset);
    const cover = asset ? asset.coverUrl || (asset.kind === "image" ? asset.data.dataUrl : "") : "";
    return (
        <Drawer title={t("assets.details")} open={Boolean(asset)} size="large" onClose={onClose}>
            {asset ? (
                <div className="space-y-5">
                    {cover ? (
                        <Image src={assetCoverUrl(asset)} preview={{ src: cover }} alt={asset.title} className="rounded-lg" />
                    ) : (
                        <div className="rounded-lg border border-stone-200 bg-stone-50 p-5 text-sm leading-6 text-stone-600 dark:border-stone-800 dark:bg-stone-900 dark:text-stone-300">{asset.kind === "text" ? asset.data.content : t("assets.noCover")}</div>
                    )}
                    <div>
                        <Typography.Title level={4} className="!mb-2">
                            {asset.title}
                        </Typography.Title>
                        <Space size={[4, 4]} wrap>
                            <Tag>{t(`assets.kinds.${asset.kind}`)}</Tag>
                            {(asset.tags || []).map((tag) => (
                                <Tag key={tag}>{tag}</Tag>
                            ))}
                        </Space>
                    </div>
                    <div className="rounded-lg border border-stone-200 p-4 dark:border-stone-800">
                        <Typography.Text type="secondary" className="block text-xs">
                            {t("assets.fields.textContent")}
                        </Typography.Text>
                        {asset.kind === "text" ? (
                            <Typography.Paragraph className="mt-2 whitespace-pre-wrap">{asset.data.content}</Typography.Paragraph>
                        ) : asset.kind === "audio" ? <audio src={asset.data.url} controls className="mt-3 w-full" /> : asset.kind === "video" ? (
                            <video src={asset.data.url} controls playsInline className="mt-2 aspect-video w-full rounded-lg bg-black" />
                        ) : (
                            <Typography.Text className="mt-2 block">
                                {asset.data.width}x{asset.data.height} · {formatBytes(asset.data.bytes)} · {asset.data.mimeType}
                            </Typography.Text>
                        )}
                    </div>
                    {asset.note ? (
                        <div>
                            <Typography.Text type="secondary">{t("assets.fields.note")}</Typography.Text>
                            <Typography.Paragraph className="mt-1">{asset.note}</Typography.Paragraph>
                        </div>
                    ) : null}
                    <Space wrap>
                        <Dropdown trigger={["click"]} menu={{ items: creationItems }}>
                            <Button type="primary" icon={<ArrowUpRight className="size-4" />}>使用素材</Button>
                        </Dropdown>
                        {asset.kind === "text" ? (
                            <Button icon={<Copy className="size-4" />} onClick={() => onCopy(asset)}>
                                {t("assets.copyText")}
                            </Button>
                        ) : null}
                        {asset.kind !== "text" ? (
                            <Button icon={<Download className="size-4" />} onClick={() => onDownload(asset)}>
                                {asset.kind === "audio" ? "下载音频" : asset.kind === "video" ? t("assets.downloadVideo") : t("assets.downloadImage")}
                            </Button>
                        ) : null}
                    </Space>
                </div>
            ) : null}
        </Drawer>
    );
}

async function readAssetMediaBlob(asset: Exclude<Asset, { kind: "text" }>) {
    const storageKey = asset.data.storageKey;
    if (storageKey) {
        const stored = asset.kind === "image" ? await getImageBlob(storageKey) : await getMediaBlob(storageKey);
        if (stored) return stored;
    }
    const url = asset.kind !== "image" ? asset.data.url : asset.data.dataUrl || asset.coverUrl;
    if (!url) return null;
    const response = await fetch(url);
    return response.ok ? response.blob() : null;
}

function assetSummary(asset: Asset) {
    if (asset.kind === "text") return asset.data.content;
    if (asset.kind === "audio") return `${formatBytes(asset.data.bytes)} · ${asset.data.mimeType}`;
    return `${asset.data.width}x${asset.data.height} · ${formatBytes(asset.data.bytes)} · ${asset.data.mimeType}`;
}


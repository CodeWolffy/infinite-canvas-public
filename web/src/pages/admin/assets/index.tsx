import { useEffect, useRef, useState } from "react";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, App, Button, Empty, Form, Grid, Image, Input, Modal, Select, Space, Table, Tag, Typography } from "antd";
import type { TableColumnsType } from "antd";
import dayjs from "dayjs";
import { FileText, ImageIcon, Pencil, Search, Trash2 } from "lucide-react";

import { createAsset, deleteAsset, getAsset, listAssetPage, updateAsset, type AssetRecord } from "@/services/api/assets";
import { ApiError } from "@/services/api/request";
import { AdminUserSelect } from "@/pages/admin/components/admin-user-select";
import { useAssetStore } from "@/stores/use-asset-store";
import { useUserStore } from "@/stores/use-user-store";

type AssetValues = { title: string; content?: string; tags: string[]; source?: string; note?: string };

export default function AdminAssetsPage() {
    const screens = Grid.useBreakpoint();
    const { message, modal } = App.useApp();
    const queryClient = useQueryClient();
    const [keyword, setKeyword] = useState("");
    const [typeFilter, setTypeFilter] = useState<"all" | AssetRecord["type"]>("all");
    const [ownerId, setOwnerId] = useState<string>();
    const [page, setPage] = useState(1);
    const [pageSize, setPageSize] = useState(20);
    const [editing, setEditing] = useState<AssetRecord | null>(null);
    const [conflict, setConflict] = useState(false);
    const [latest, setLatest] = useState<AssetRecord | null>(null);
    const [saving, setSaving] = useState(false);
    const formVersion = useRef(0);
    const [form] = Form.useForm<AssetValues>();
    const hydrateAssets = useAssetStore((state) => state.hydrateAssets);
    const userId = useUserStore((state) => state.user?.id || "");
    const sessionVersion = useUserStore((state) => state.sessionVersion);
    const assetsQuery = useQuery({ queryKey: ["admin", "public-assets", sessionVersion, page, pageSize, typeFilter, keyword, ownerId], queryFn: () => listAssetPage({ page, size: pageSize, scope: "public", kind: typeFilter, keyword, ownerId }), placeholderData: (previous, query) => query?.queryKey[2] === sessionVersion ? keepPreviousData(previous) : undefined });
    useEffect(() => {
        setEditing(null); setLatest(null); setConflict(false); setSaving(false);
        return () => { formVersion.current++; };
    }, [sessionVersion]);
    const refresh = () => {
        void queryClient.invalidateQueries({ queryKey: ["admin", "public-assets"] });
        if (userId) void hydrateAssets(userId, true);
    };
    const closeEdit = () => { formVersion.current++; setEditing(null); setLatest(null); setConflict(false); setSaving(false); };
    const save = async (copy = false) => {
        if (!editing || saving) return;
        const version = formVersion.current;
        const isCurrent = () => version === formVersion.current && useUserStore.getState().sessionVersion === sessionVersion;
        setSaving(true);
        try {
            const values = await form.validateFields();
            if (!isCurrent()) return;
            const input = { title: values.title.trim(), ...(editing.type === "text" ? { content: values.content?.trim() || "" } : {}), metadata: { ...editing.metadata, tags: values.tags || [], source: values.source?.trim() || "", note: values.note?.trim() || "" } };
            if (copy) await createAsset({ ...input, type: editing.type, mediaId: editing.mediaId, scope: "private" });
            else await updateAsset(editing.id, { ...input, expectedRevision: editing.revision });
            if (!isCurrent()) return;
            refresh(); closeEdit(); form.resetFields(); message.success(copy ? "已另存为私人素材" : "公共素材已更新");
        } catch (error) {
            if (!isCurrent() || (error && typeof error === "object" && "errorFields" in error)) return;
            if (error instanceof ApiError && error.code === "asset_conflict") { setConflict(true); refresh(); }
            else message.error(error instanceof Error ? error.message : "素材更新失败");
        } finally { if (isCurrent()) setSaving(false); }
    };
    const viewLatest = async () => {
        if (!editing) return;
        const version = formVersion.current;
        const isCurrent = () => version === formVersion.current && useUserStore.getState().sessionVersion === sessionVersion;
        try { const asset = await getAsset(editing.id); if (isCurrent()) setLatest(asset); }
        catch (error) { if (isCurrent()) message.error(error instanceof Error ? error.message : "素材读取失败"); }
    };
    const deleteMutation = useMutation({
        mutationFn: deleteAsset,
        onSuccess: () => { refresh(); message.success("公共素材已删除"); },
        onError: (error: Error) => message.error(error.message || "素材删除失败"),
    });
    const openEdit = (asset: AssetRecord) => {
        formVersion.current++; setConflict(false); setLatest(null); setSaving(false);
        setEditing(asset);
        form.setFieldsValue({
            title: asset.title,
            content: asset.content || "",
            tags: Array.isArray(asset.metadata.tags) ? asset.metadata.tags.filter((tag): tag is string => typeof tag === "string") : [],
            source: typeof asset.metadata.source === "string" ? asset.metadata.source : "",
            note: typeof asset.metadata.note === "string" ? asset.metadata.note : "",
        });
    };
    const columns: TableColumnsType<AssetRecord> = [
        {
            title: "素材",
            key: "asset",
            fixed: screens.lg ? "left" : undefined,
            width: 280,
            render: (_, asset) => (
                <div className="flex min-w-0 items-center gap-3">
                    <div className="flex size-12 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-stone-100 dark:bg-stone-900">
                        {asset.type === "image" && asset.mediaId ? <Image src={`/api/media/${asset.mediaId}`} alt="" width={48} height={48} preview={false} className="size-12 object-cover" /> : <FileText className="size-5 text-stone-400" />}
                    </div>
                    <div className="min-w-0"><div className="truncate font-medium text-stone-950 dark:text-stone-100" title={asset.title}>{asset.title}</div><div className="mt-1 line-clamp-1 text-xs text-stone-500">{asset.type === "text" ? asset.content : asset.mediaId}</div></div>
                </div>
            ),
        },
        { title: "类型", dataIndex: "type", width: 90, render: (type: AssetRecord["type"]) => <Tag>{({ image: "图片", text: "文本", video: "视频", audio: "音频" })[type]}</Tag> },
        { title: "创建者", dataIndex: "ownerId", width: 180, render: (ownerId: string, asset) => <div><div className="truncate text-sm" title={asset.ownerName}>{asset.ownerName || "未知用户"}</div><div className="font-mono text-[10px] text-stone-400">{ownerId.slice(0, 8)}</div></div> },
        { title: "标签", dataIndex: "metadata", width: 210, render: (metadata: Record<string, unknown>) => <div className="flex flex-wrap gap-1">{Array.isArray(metadata.tags) && metadata.tags.length ? metadata.tags.slice(0, 4).map((tag) => <Tag key={String(tag)} className="m-0 max-w-full truncate" title={String(tag)}>{String(tag)}</Tag>) : <span className="text-stone-400">—</span>}</div> },
        { title: "更新时间", dataIndex: "updatedAt", width: 170, render: (value: string) => <span className="text-stone-500">{dayjs(value).format("YYYY-MM-DD HH:mm")}</span> },
        {
            title: "操作",
            key: "actions",
            fixed: screens.lg ? "right" : undefined,
            width: 130,
            render: (_, asset) => <Space><Button type="text" size="small" icon={<Pencil className="size-3.5" />} onClick={() => openEdit(asset)}>编辑</Button><Button type="text" danger size="small" aria-label={`删除 ${asset.title}`} icon={<Trash2 className="size-3.5" />} onClick={() => modal.confirm({ title: `删除“${asset.title}”？`, content: "删除公共素材条目不会移除仍被画布或生成记录引用的图片。", okText: "删除", cancelText: "取消", okButtonProps: { danger: true }, onOk: () => deleteMutation.mutateAsync(asset.id) })} /></Space>,
        },
    ];

    return (
        <div className="w-full px-4 py-6 sm:px-6 lg:px-8 lg:py-8 space-y-6">
            <div>
                <div className="flex items-center gap-2 text-stone-500 mb-1">
                    <ImageIcon className="size-4 text-emerald-500" />
                    <span className="text-xs font-semibold uppercase tracking-wider">Shared Library</span>
                </div>
                <h1 className="text-2xl font-bold tracking-tight text-stone-950 dark:text-stone-100">公共素材</h1>
                <p className="mt-1 text-sm text-stone-500">管理全员可见的图片和文本素材，修订信息或移除不再共享的条目。</p>
            </div>
            <div className="overflow-hidden rounded-xl border border-stone-200 bg-background dark:border-stone-800">
                <div className="flex flex-wrap items-center justify-between gap-3 border-b border-stone-200 p-4 dark:border-stone-800">
                    <div className="flex min-w-0 flex-1 flex-wrap gap-2"><Input allowClear prefix={<Search className="size-4 text-stone-400" />} placeholder="搜索素材标题、正文或标签" value={keyword} onChange={(event) => { setPage(1); setKeyword(event.target.value); }} className="max-w-sm" /><Select value={typeFilter} onChange={(value) => { setPage(1); setTypeFilter(value); }} className="w-28" options={[{ value: "all", label: "全部类型" }, { value: "image", label: "图片" }, { value: "text", label: "文本" }]} /><AdminUserSelect allowClear value={ownerId} onChange={(value) => { setPage(1); setOwnerId(value); }} placeholder="全部创建者" className="min-w-48" /></div>
                    <span className="text-xs text-stone-500">共 {assetsQuery.data?.total || 0} 条公共素材</span>
                </div>
                <Table<AssetRecord> rowKey="id" columns={columns} tableLayout="fixed" dataSource={assetsQuery.data?.assets || []} loading={assetsQuery.isLoading} pagination={{ current: page, pageSize, total: assetsQuery.data?.total || 0, showSizeChanger: true, onChange: (next, size) => { setPage(size === pageSize ? next : 1); setPageSize(size); } }} scroll={{ x: 1060 }} locale={{ emptyText: assetsQuery.isError ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={assetsQuery.error instanceof Error ? assetsQuery.error.message : "公共素材加载失败"} /> : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无公共素材" /> }} />
            </div>

            <Modal title={`编辑${editing?.type === "image" ? "图片" : "文本"}素材`} open={Boolean(editing)} onCancel={closeEdit} footer={null} destroyOnHidden>
                {conflict ? <Alert type="warning" title="素材已有更新，当前输入已保留" description={<Space wrap><Button type="link" onClick={() => void viewLatest()}>查看最新</Button><Button type="link" disabled={saving} onClick={() => void save(true)}>另存私人副本</Button></Space>} /> : null}
                <Form<AssetValues> form={form} layout="vertical" requiredMark={false} className="pt-3" disabled={saving} onFinish={() => void save()}>
                    <Form.Item name="title" label="标题" rules={[{ required: true, message: "请输入素材标题" }]}><Input /></Form.Item>
                    {editing?.type === "text" ? <Form.Item name="content" label="正文" rules={[{ required: true, message: "请输入文本内容" }]}><Input.TextArea rows={7} /></Form.Item> : null}
                    <Form.Item name="tags" label="标签"><Select mode="tags" tokenSeparators={[",", "，"]} placeholder="输入标签后回车" /></Form.Item>
                    <div className="grid gap-4 sm:grid-cols-2"><Form.Item name="source" label="来源"><Input /></Form.Item><Form.Item name="note" label="备注"><Input /></Form.Item></div>
                    <Space className="flex justify-end"><Button onClick={closeEdit}>取消</Button><Button type="primary" htmlType="submit" loading={saving} disabled={conflict}>保存修改</Button></Space>
                </Form>
            </Modal>
            <Modal title="最新素材（当前输入保持不变）" open={Boolean(latest)} onCancel={() => setLatest(null)} footer={<Button onClick={() => setLatest(null)}>返回编辑</Button>}>
                <Typography.Title level={5}>{latest?.title}</Typography.Title>
                {latest?.type === "text" ? <Typography.Paragraph className="whitespace-pre-wrap">{latest.content}</Typography.Paragraph> : latest?.mediaId ? <Image src={`/api/media/${latest.mediaId}`} alt={latest.title} /> : null}
                <Typography.Paragraph type="secondary">{String(latest?.metadata.note || "")}</Typography.Paragraph>
            </Modal>
        </div>
    );
}

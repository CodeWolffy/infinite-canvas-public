import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { App, Button, Empty, Form, Image, Input, Modal, Select, Space, Table, Tag } from "antd";
import type { TableColumnsType } from "antd";
import dayjs from "dayjs";
import { FileText, ImageIcon, Pencil, Search, Trash2 } from "lucide-react";

import { deleteAsset, listAssets, updateAsset, type AssetRecord } from "@/services/api/assets";
import { getAdminUsers } from "@/services/api/admin-users";
import { useAssetStore } from "@/stores/use-asset-store";
import { useUserStore } from "@/stores/use-user-store";

type AssetValues = { title: string; content?: string; tags: string[]; source?: string; note?: string };

export default function AdminAssetsPage() {
    const { message, modal } = App.useApp();
    const queryClient = useQueryClient();
    const [keyword, setKeyword] = useState("");
    const [typeFilter, setTypeFilter] = useState<"all" | AssetRecord["type"]>("all");
    const [editing, setEditing] = useState<AssetRecord | null>(null);
    const [form] = Form.useForm<AssetValues>();
    const hydrateAssets = useAssetStore((state) => state.hydrateAssets);
    const userId = useUserStore((state) => state.user?.id || "");
    const assetsQuery = useQuery({ queryKey: ["admin", "public-assets"], queryFn: () => listAssets("public") });
    const usersQuery = useQuery({ queryKey: ["admin", "users"], queryFn: getAdminUsers });
    const refresh = () => {
        void queryClient.invalidateQueries({ queryKey: ["admin", "public-assets"] });
        if (userId) void hydrateAssets(userId, true);
    };
    const saveMutation = useMutation({
        mutationFn: (values: AssetValues) => updateAsset(editing!.id, {
            title: values.title.trim(),
            ...(editing?.type === "text" ? { content: values.content?.trim() || "" } : {}),
            metadata: { ...(editing?.metadata || {}), tags: values.tags || [], source: values.source?.trim() || "", note: values.note?.trim() || "" },
        }),
        onSuccess: () => { refresh(); setEditing(null); form.resetFields(); message.success("公共素材已更新"); },
        onError: (error: Error) => message.error(error.message || "素材更新失败"),
    });
    const deleteMutation = useMutation({
        mutationFn: deleteAsset,
        onSuccess: () => { refresh(); message.success("公共素材已删除"); },
        onError: (error: Error) => message.error(error.message || "素材删除失败"),
    });
    const ownerNames = useMemo(() => new Map((usersQuery.data || []).map((user) => [user.id, user.displayName])), [usersQuery.data]);
    const assets = useMemo(() => {
        const query = keyword.trim().toLowerCase();
        return (assetsQuery.data || []).filter((asset) => {
            if (typeFilter !== "all" && asset.type !== typeFilter) return false;
            if (!query) return true;
            const tags = Array.isArray(asset.metadata.tags) ? asset.metadata.tags.join(" ") : "";
            return `${asset.title} ${asset.content || ""} ${ownerNames.get(asset.ownerId) || ""} ${asset.ownerId} ${tags}`.toLowerCase().includes(query);
        });
    }, [assetsQuery.data, keyword, ownerNames, typeFilter]);

    const openEdit = (asset: AssetRecord) => {
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
            fixed: "left",
            width: 280,
            render: (_, asset) => (
                <div className="flex min-w-0 items-center gap-3">
                    <div className="flex size-12 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-stone-100 dark:bg-stone-900">
                        {asset.type === "image" && asset.mediaId ? <Image src={`/api/media/${asset.mediaId}`} alt="" width={48} height={48} preview={false} className="size-12 object-cover" /> : <FileText className="size-5 text-stone-400" />}
                    </div>
                    <div className="min-w-0"><div className="truncate font-medium text-stone-950 dark:text-stone-100">{asset.title}</div><div className="mt-1 line-clamp-1 text-xs text-stone-500">{asset.type === "text" ? asset.content : asset.mediaId}</div></div>
                </div>
            ),
        },
        { title: "类型", dataIndex: "type", width: 90, render: (type: AssetRecord["type"]) => <Tag>{({ image: "图片", text: "文本", video: "视频", audio: "音频" })[type]}</Tag> },
        { title: "创建者", dataIndex: "ownerId", width: 180, render: (ownerId: string) => <div><div className="text-sm">{ownerNames.get(ownerId) || "未知用户"}</div><div className="font-mono text-[10px] text-stone-400">{ownerId.slice(0, 8)}</div></div> },
        { title: "标签", dataIndex: "metadata", width: 210, render: (metadata: Record<string, unknown>) => <Space size={[4, 4]} wrap>{Array.isArray(metadata.tags) && metadata.tags.length ? metadata.tags.slice(0, 4).map((tag) => <Tag key={String(tag)} className="m-0">{String(tag)}</Tag>) : <span className="text-stone-400">—</span>}</Space> },
        { title: "更新时间", dataIndex: "updatedAt", width: 170, render: (value: string) => <span className="text-stone-500">{dayjs(value).format("YYYY-MM-DD HH:mm")}</span> },
        {
            title: "操作",
            key: "actions",
            fixed: "right",
            width: 150,
            render: (_, asset) => <Space><Button type="text" size="small" icon={<Pencil className="size-3.5" />} onClick={() => openEdit(asset)}>编辑</Button><Button type="text" danger size="small" icon={<Trash2 className="size-3.5" />} onClick={() => modal.confirm({ title: `删除“${asset.title}”？`, content: "删除公共素材条目不会移除仍被画布或生成记录引用的图片。", okText: "删除", cancelText: "取消", okButtonProps: { danger: true }, onOk: () => deleteMutation.mutateAsync(asset.id) })} /></Space>,
        },
    ];

    return (
        <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:py-8">
            <div><p className="text-xs font-semibold uppercase tracking-[0.18em] text-stone-400">Shared library</p><h1 className="mt-2 text-2xl font-semibold tracking-[-0.03em] text-stone-950 dark:text-stone-100">公共素材</h1><p className="mt-1 text-sm text-stone-500">管理全员可见的图片和文本素材，修订信息或移除不再共享的条目。</p></div>
            <div className="mt-7 overflow-hidden rounded-xl border border-stone-200 bg-background dark:border-stone-800">
                <div className="flex flex-wrap items-center justify-between gap-3 border-b border-stone-200 p-4 dark:border-stone-800">
                    <div className="flex min-w-0 flex-1 flex-wrap gap-2"><Input allowClear prefix={<Search className="size-4 text-stone-400" />} placeholder="搜索素材、创建者或标签" value={keyword} onChange={(event) => setKeyword(event.target.value)} className="max-w-sm" /><Select value={typeFilter} onChange={setTypeFilter} className="w-28" options={[{ value: "all", label: "全部类型" }, { value: "image", label: "图片" }, { value: "text", label: "文本" }]} /></div>
                    <span className="text-xs text-stone-500">共 {assetsQuery.data?.length || 0} 条公共素材</span>
                </div>
                <Table<AssetRecord> rowKey="id" columns={columns} dataSource={assets} loading={assetsQuery.isLoading} pagination={{ pageSize: 20, showSizeChanger: true }} scroll={{ x: 1080 }} locale={{ emptyText: assetsQuery.isError ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={assetsQuery.error instanceof Error ? assetsQuery.error.message : "公共素材加载失败"} /> : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无公共素材" /> }} />
            </div>

            <Modal title={`编辑${editing?.type === "image" ? "图片" : "文本"}素材`} open={Boolean(editing)} onCancel={() => setEditing(null)} footer={null} destroyOnHidden>
                <Form<AssetValues> form={form} layout="vertical" requiredMark={false} className="pt-3" onFinish={(values) => saveMutation.mutate(values)}>
                    <Form.Item name="title" label="标题" rules={[{ required: true, message: "请输入素材标题" }]}><Input /></Form.Item>
                    {editing?.type === "text" ? <Form.Item name="content" label="正文" rules={[{ required: true, message: "请输入文本内容" }]}><Input.TextArea rows={7} /></Form.Item> : null}
                    <Form.Item name="tags" label="标签"><Select mode="tags" tokenSeparators={[",", "，"]} placeholder="输入标签后回车" /></Form.Item>
                    <div className="grid gap-4 sm:grid-cols-2"><Form.Item name="source" label="来源"><Input /></Form.Item><Form.Item name="note" label="备注"><Input /></Form.Item></div>
                    <Space className="flex justify-end"><Button onClick={() => setEditing(null)}>取消</Button><Button type="primary" htmlType="submit" loading={saveMutation.isPending}>保存修改</Button></Space>
                </Form>
            </Modal>
        </div>
    );
}

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useSearchParams } from "react-router-dom";
import { Alert, App, Button, Drawer, Empty, Form, Input, InputNumber, Modal, Select, Space, Switch, Table, Tabs, Tag } from "antd";
import type { TableColumnsType } from "antd";
import { Cable, Pencil, Plus, Search, Trash2 } from "lucide-react";

import { createAdminModel, deleteAdminModel, deleteModelBinding, getAdminChannels, getAdminModels, getModelChannelBindings, saveModelChannelBinding, updateAdminModel, updateAdminModelStatus, type AdminModel, type BindingInput, type ModelInput } from "@/services/api/admin-platform";
import ChannelCosts from "./components/channel-costs";
import { capabilityLabel, modelCapabilities } from "@/lib/model-capabilities";
import type { ModelReasoningEffort } from "@/lib/model-reasoning";
import { clearPublicModelsCache } from "@/services/api/generation";
import ModelSettingsFields, { modelSettingsPayload, type ModelSettingsValues } from "../components/model-settings-fields";

type ModelValues = ModelInput & ModelSettingsValues;
type BindingValues = BindingInput & { channelId: string };
const modelExamples = { image: ["GPT Image 2", "gpt-image-2"], text: ["GPT 文本模型", "gpt-4.1"], video: ["Veo 视频模型", "veo-3.0-generate-preview"], audio: ["语音合成模型", "gpt-4o-mini-tts"] };

export default function AdminModelsPage() {
    const { message, modal } = App.useApp();
    const queryClient = useQueryClient();
    const [searchParams, setSearchParams] = useSearchParams();
    const category = modelCapabilities.find((item) => item.value === searchParams.get("type")) || modelCapabilities[0];
    const [keyword, setKeyword] = useState("");
    const [editing, setEditing] = useState<AdminModel | null | undefined>(undefined);
    const [bindingModel, setBindingModel] = useState<AdminModel | null>(null);
    const [bindingOpen, setBindingOpen] = useState(false);
    const [editingBindingId, setEditingBindingId] = useState<string | null>(null);
    const [modelForm] = Form.useForm<ModelValues>();
    const [bindingForm] = Form.useForm<BindingValues>();
    const modelsQuery = useQuery({ queryKey: ["admin", "models"], queryFn: getAdminModels });
    const channelsQuery = useQuery({ queryKey: ["admin", "channels"], queryFn: getAdminChannels });
    const bindingsQuery = useQuery({ queryKey: ["admin", "model-bindings", bindingModel?.id], queryFn: () => getModelChannelBindings(bindingModel!.id), enabled: Boolean(bindingModel) });
    const refreshModels = () => {
        clearPublicModelsCache();
        return Promise.all([queryClient.invalidateQueries({ queryKey: ["admin", "models"] }), queryClient.invalidateQueries({ queryKey: ["public-models"] })]);
    };
    const refreshBindings = () => queryClient.invalidateQueries({ queryKey: ["admin", "model-bindings", bindingModel?.id] });
    const saveModel = useMutation({ mutationFn: (values: ModelValues) => {
        const input: ModelInput = { name: values.name, displayName: values.displayName, capability: values.capability, status: values.status, sortOrder: values.sortOrder, description: values.description || null, ...modelSettingsPayload(values, editing?.config) };
        return editing ? updateAdminModel(editing.id, input) : createAdminModel(input);
    }, onSuccess: () => { void refreshModels(); setEditing(undefined); modelForm.resetFields(); message.success(editing ? "模型已更新" : "模型已创建"); }, onError: notifyError(message.error) });
    const statusMutation = useMutation({ mutationFn: ({ id, status }: { id: string; status: AdminModel["status"] }) => updateAdminModelStatus(id, status), onSuccess: () => void refreshModels(), onError: notifyError(message.error) });
    const deleteMutation = useMutation({ mutationFn: deleteAdminModel, onSuccess: () => { void refreshModels(); message.success("模型已删除"); }, onError: notifyError(message.error) });
    const bindingMutation = useMutation({ mutationFn: ({ channelId, ...values }: BindingValues) => saveModelChannelBinding(bindingModel!.id, channelId, values), onSuccess: () => { void refreshBindings(); setBindingOpen(false); bindingForm.resetFields(); message.success("渠道绑定已保存"); }, onError: notifyError(message.error) });
    const unbindMutation = useMutation({ mutationFn: (bindingId: string) => deleteModelBinding(bindingModel!.id, bindingId), onSuccess: () => { void refreshBindings(); message.success("渠道绑定已移除"); }, onError: notifyError(message.error) });

    useEffect(() => {
        if (editing === undefined) return;
        modelForm.resetFields();
        modelForm.setFieldsValue(editing ? { name: editing.name, displayName: editing.displayName, capability: editing.capability, sortOrder: editing.sortOrder, status: editing.status, pricePerImage: editing.pricePerImage || undefined, tokenPricing: editing.inputPricePerMillion != null, inputPrice: editing.inputPricePerMillion || undefined, cachedPrice: editing.cachedPricePerMillion || undefined, outputPrice: editing.outputPricePerMillion || undefined, perSecondPricing: editing.pricePerSecond != null, pricePerSecond: editing.pricePerSecond || undefined, maxOutputTokens: editing.config.maxOutputTokens == null ? undefined : Number(editing.config.maxOutputTokens), reasoningEfforts: (editing.config.reasoningEfforts || []) as ModelReasoningEffort[], description: editing.description } : { capability: category.value, sortOrder: 0, status: "draft", reasoningEfforts: [] });
    }, [editing, modelForm, category.value]);

    const openBinding = (model: AdminModel) => { setBindingModel(model); setEditingBindingId(null); bindingForm.resetFields(); };
    const formCapability = editing?.capability || category.value;
    const categoryModels = (modelsQuery.data || []).filter((model) => model.capability === category.value);
    const visibleModels = categoryModels.filter((model) => `${model.displayName} ${model.name} ${model.description || ""}`.toLowerCase().includes(keyword.trim().toLowerCase()));
    const matchingChannels = (channelsQuery.data || []).filter((channel) => channel.capability === bindingModel?.capability);
    const columns: TableColumnsType<AdminModel> = [
        { title: "公开名称", key: "name", width: 220, render: (_, model) => <div><div className="font-medium text-stone-950 dark:text-stone-100">{model.displayName}</div><div className="text-xs text-stone-500">{model.name}</div></div> },
        { title: "排序", dataIndex: "sortOrder", width: 80 },
        { title: "计费价格", dataIndex: "pricePerImage", width: 240, render: (value: string | null, model) => model.capability === "text" && model.inputPricePerMillion != null ? <div className="text-xs leading-5"><div>输入 ¥{model.inputPricePerMillion} / 输出 ¥{model.outputPricePerMillion}</div><div className="text-muted-foreground">{model.cachedPricePerMillion != null ? `缓存 ¥${model.cachedPricePerMillion} · ` : ""}每百万 token</div></div> : (model.capability === "video" || model.capability === "audio") && model.pricePerSecond != null ? `¥${model.pricePerSecond} / 秒` : `¥${model.price || value || "0"} / ${model.capability === "image" ? "张" : "次"}` },
        ...(category.value === "text" ? [{ title: "输出上限", key: "maxOutputTokens", width: 130, render: (_: unknown, model: AdminModel) => model.config.maxOutputTokens == null ? "未配置" : `${Number(model.config.maxOutputTokens).toLocaleString()} token` }] : []),
        { title: "状态", dataIndex: "status", width: 130, render: (status: AdminModel["status"], model) => <Select size="small" value={status} onChange={(value) => statusMutation.mutate({ id: model.id, status: value })} options={[{ value: "draft", label: "草稿" }, { value: "published", label: "已发布" }, { value: "disabled", label: "已停用" }]} /> },
        { title: "说明", dataIndex: "description", ellipsis: true, render: (value: string | null) => <span className="text-stone-500">{value || "—"}</span> },
        { title: "操作", key: "actions", fixed: "right", width: 240, render: (_, model) => <Space><Button type="text" size="small" icon={<Cable className="size-3.5" />} onClick={() => openBinding(model)}>渠道配置</Button><Button type="text" size="small" icon={<Pencil className="size-3.5" />} onClick={() => setEditing(model)}>编辑</Button><Button type="text" danger size="small" icon={<Trash2 className="size-3.5" />} onClick={() => modal.confirm({ title: `删除 ${model.displayName}？`, content: "有关联记录时服务端会拒绝删除。", okText: "删除", cancelText: "取消", okButtonProps: { danger: true }, onOk: () => deleteMutation.mutateAsync(model.id) })} /></Space> },
    ];

    return (
        <div className="w-full px-6 py-6 lg:px-8 lg:py-8">
            <div className="flex flex-wrap items-end justify-between gap-4"><div><h1 className="text-2xl font-semibold tracking-tight">模型管理</h1><p className="mt-2 text-sm text-muted-foreground">按类型管理模型发布、计费与上游渠道绑定。</p></div><Space><Link to={`/admin/channels?type=${category.value}`}><Button icon={<Cable className="size-4" />}>{category.label}渠道</Button></Link><Button type="primary" icon={<Plus className="size-4" />} onClick={() => setEditing(null)}>创建{category.label}模型</Button></Space></div>
            <Tabs className="mt-6" activeKey={category.value} onChange={(value) => { setSearchParams({ type: value }); setKeyword(""); }} items={modelCapabilities.map(({ value, label, icon: Icon }) => ({ key: value, label: <span className="inline-flex items-center gap-2"><Icon className="size-4" />{label}<span className="text-xs tabular-nums text-muted-foreground">{(modelsQuery.data || []).filter((model) => model.capability === value).length}</span></span> }))} />
            <div className="mb-5 flex flex-wrap items-center justify-between gap-3"><div><h2 className="font-medium">{category.label}模型</h2><p className="mt-1 text-sm text-muted-foreground">{category.description}</p></div><Input className="!w-full sm:!w-72" prefix={<Search className="size-4 text-muted-foreground" />} allowClear placeholder={`搜索${category.label}模型名称、标识或说明`} value={keyword} onChange={(event) => setKeyword(event.target.value)} /></div>
            {modelsQuery.error ? <Alert className="mb-4" type="error" showIcon title={modelsQuery.error.message} /> : null}
            <div className="overflow-hidden rounded-xl border border-border"><Table<AdminModel> rowKey="id" columns={columns} dataSource={visibleModels} loading={modelsQuery.isLoading} pagination={false} scroll={{ x: category.value === "text" ? 1120 : 980 }} locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={keyword.trim() ? "没有匹配的模型" : `暂无${category.label}模型`} /> }} /></div>
            <Modal title={`${editing ? "编辑" : "创建"}${capabilityLabel(formCapability)}模型`} open={editing !== undefined} footer={null} onCancel={() => setEditing(undefined)} destroyOnHidden width={560}>
                <Form<ModelValues> form={modelForm} layout="vertical" requiredMark={false} className="pt-3" onFinish={(values) => saveModel.mutate(values)}>
                    <Form.Item name="capability" hidden><Input /></Form.Item>
                    <Form.Item name="displayName" label="显示名称" rules={[{ required: true, message: "请输入显示名称" }]}><Input placeholder={`例如 ${modelExamples[formCapability][0]}`} /></Form.Item>
                    <Form.Item name="name" label="模型标识" extra="可与其他公开模型相同；实际渠道由渠道绑定决定。" rules={[{ required: true, message: "请输入模型标识" }]}><Input placeholder={`例如 ${modelExamples[formCapability][1]}`} /></Form.Item>
                    <div className="grid grid-cols-2 gap-4"><Form.Item name="sortOrder" label="排序" extra="数值越小越靠前"><InputNumber min={0} precision={0} className="!w-full" /></Form.Item><Form.Item name="status" label="状态" rules={[{ required: true }]}><Select options={[{ value: "draft", label: "草稿" }, { value: "published", label: "已发布" }, { value: "disabled", label: "已停用" }]} /></Form.Item></div>
                    <ModelSettingsFields capability={formCapability} />
                    <Form.Item name="description" label="说明"><Input.TextArea rows={3} /></Form.Item>
                    <Space className="flex justify-end"><Button onClick={() => setEditing(undefined)}>取消</Button><Button type="primary" htmlType="submit" loading={saveModel.isPending}>保存</Button></Space>
                </Form>
            </Modal>
            <Drawer title={`${bindingModel?.displayName || "模型"} · ${bindingModel ? capabilityLabel(bindingModel.capability) : ""}渠道配置`} size={680} open={Boolean(bindingModel)} onClose={() => { setBindingModel(null); setBindingOpen(false); }}>
                <Button className="mb-4" type="primary" icon={<Plus className="size-4" />} onClick={() => { setEditingBindingId(null); bindingForm.resetFields(); bindingForm.setFieldsValue({ priority: 0, weight: 100, enabled: true }); setBindingOpen(true); }}>添加渠道</Button>
                <Table rowKey="id" size="small" loading={bindingsQuery.isLoading} dataSource={bindingsQuery.data || []} pagination={false} columns={[{ title: "渠道", dataIndex: "channelName" }, { title: "上游模型", dataIndex: "upstreamModel" }, { title: "优先级", dataIndex: "priority", width: 80 }, { title: "权重", dataIndex: "weight", width: 70 }, { title: "状态", dataIndex: "enabled", width: 70, render: (value) => value ? <Tag color="green">启用</Tag> : <Tag>停用</Tag> }, { title: "操作", width: 110, render: (_, binding) => <Space><Button type="text" size="small" onClick={() => { setEditingBindingId(binding.id); bindingForm.setFieldsValue({ id: binding.id, channelId: binding.channelId, upstreamModel: binding.upstreamModel, priority: binding.priority, weight: binding.weight, enabled: binding.enabled }); setBindingOpen(true); }}>编辑</Button><Button type="text" danger size="small" onClick={() => unbindMutation.mutate(binding.id)}>移除</Button></Space> }]} />
                {bindingModel ? <ChannelCosts key={bindingModel.id} model={bindingModel} /> : null}
            </Drawer>
            <Modal title="配置模型渠道" open={bindingOpen} footer={null} onCancel={() => setBindingOpen(false)} destroyOnHidden>
                <Form<BindingValues> form={bindingForm} layout="vertical" requiredMark={false} className="pt-3" onFinish={(values) => bindingMutation.mutate(values)}>
                    <Form.Item name="id" hidden><Input /></Form.Item>
                    {channelsQuery.error ? <Alert className="mb-4" type="error" showIcon title={channelsQuery.error.message} /> : null}
                    <Form.Item name="channelId" label={`${bindingModel ? capabilityLabel(bindingModel.capability) : ""}渠道`} extra="只显示与模型类型一致的渠道。" rules={[{ required: true, message: "请选择渠道" }]}><Select showSearch={{ optionFilterProp: "label" }} loading={channelsQuery.isLoading} disabled={Boolean(editingBindingId)} placeholder="请选择同类型渠道" notFoundContent="暂无同类型渠道，请先在渠道管理中创建" options={matchingChannels.map((channel) => ({ value: channel.id, label: `${channel.name} · ${channel.protocol}${channel.status !== "active" ? " · 未启用" : ""}` }))} /></Form.Item>
                    <Form.Item name="upstreamModel" label="上游模型名称" rules={[{ required: true, message: "请输入上游模型名称" }]}><Input /></Form.Item>
                    <div className="grid grid-cols-2 gap-4"><Form.Item name="priority" label="优先级" rules={[{ required: true }]}><InputNumber className="w-full" precision={0} /></Form.Item><Form.Item name="weight" label="同级权重" rules={[{ required: true }]}><InputNumber className="w-full" min={1} precision={0} /></Form.Item></div>
                    <Form.Item name="enabled" label="启用" valuePropName="checked"><Switch /></Form.Item>
                    <Space className="flex justify-end"><Button onClick={() => setBindingOpen(false)}>取消</Button><Button type="primary" htmlType="submit" loading={bindingMutation.isPending}>保存配置</Button></Space>
                </Form>
            </Modal>
        </div>
    );
}

function notifyError(notify: (content: string) => void) { return (error: Error) => notify(error.message || "操作失败"); }

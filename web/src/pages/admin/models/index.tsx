import { useEffect, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { App, Button, Drawer, Form, Input, InputNumber, Modal, Select, Space, Switch, Table, Tag } from "antd";
import type { TableColumnsType } from "antd";
import { Cable, Pencil, Plus, Trash2 } from "lucide-react";

import { createAdminModel, deleteAdminModel, deleteModelBinding, getAdminChannels, getAdminModels, getModelChannelBindings, saveModelChannelBinding, updateAdminModel, updateAdminModelStatus, type AdminModel, type BindingInput, type ModelInput } from "@/services/api/admin-platform";
import ChannelCosts from "./components/channel-costs";
import { modelReasoningEfforts, reasoningEffortLabel, type ModelReasoningEffort } from "@/lib/model-reasoning";
import { clearPublicModelsCache } from "@/services/api/generation";

type ModelValues = ModelInput & { pricePerImage?: string; tokenPricing?: boolean; inputPrice?: string; cachedPrice?: string; outputPrice?: string; perSecondPricing?: boolean; pricePerSecond?: string; maxOutputTokens?: number; reasoningEfforts?: ModelReasoningEffort[] };
type BindingValues = BindingInput & { channelId: string };

export default function AdminModelsPage() {
    const { message, modal } = App.useApp();
    const queryClient = useQueryClient();
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
    const saveModel = useMutation({ mutationFn: (values: ModelValues) => editing ? updateAdminModel(editing.id, normalizeModel(values, editing.config)) : createAdminModel(normalizeModel(values, {}) as ModelInput), onSuccess: () => { void refreshModels(); setEditing(undefined); modelForm.resetFields(); message.success(editing ? "模型已更新" : "模型已创建"); }, onError: notifyError(message.error) });
    const statusMutation = useMutation({ mutationFn: ({ id, status }: { id: string; status: AdminModel["status"] }) => updateAdminModelStatus(id, status), onSuccess: () => void refreshModels(), onError: notifyError(message.error) });
    const deleteMutation = useMutation({ mutationFn: deleteAdminModel, onSuccess: () => { void refreshModels(); message.success("模型已删除"); }, onError: notifyError(message.error) });
    const bindingMutation = useMutation({ mutationFn: ({ channelId, ...values }: BindingValues) => saveModelChannelBinding(bindingModel!.id, channelId, values), onSuccess: () => { void refreshBindings(); setBindingOpen(false); bindingForm.resetFields(); message.success("渠道绑定已保存"); }, onError: notifyError(message.error) });
    const unbindMutation = useMutation({ mutationFn: (bindingId: string) => deleteModelBinding(bindingModel!.id, bindingId), onSuccess: () => { void refreshBindings(); message.success("渠道绑定已移除"); }, onError: notifyError(message.error) });

    useEffect(() => {
        if (editing === undefined) return;
        modelForm.resetFields();
        modelForm.setFieldsValue(editing ? { name: editing.name, displayName: editing.displayName, capability: editing.capability, sortOrder: editing.sortOrder, status: editing.status, pricePerImage: editing.pricePerImage || undefined, tokenPricing: Boolean(editing.inputPricePerMillion), inputPrice: editing.inputPricePerMillion || undefined, cachedPrice: editing.cachedPricePerMillion || undefined, outputPrice: editing.outputPricePerMillion || undefined, perSecondPricing: Boolean(editing.pricePerSecond), pricePerSecond: editing.pricePerSecond || undefined, maxOutputTokens: editing.config.maxOutputTokens == null ? undefined : Number(editing.config.maxOutputTokens), reasoningEfforts: (editing.config.reasoningEfforts || []) as ModelReasoningEffort[], description: editing.description } : { capability: "image", sortOrder: 0, status: "draft", reasoningEfforts: [] });
    }, [editing, modelForm]);

    const openBinding = (model: AdminModel) => { setBindingModel(model); setEditingBindingId(null); bindingForm.resetFields(); };
    const columns: TableColumnsType<AdminModel> = [
        { title: "公开名称", key: "name", width: 220, render: (_, model) => <div><div className="font-medium text-stone-950 dark:text-stone-100">{model.displayName}</div><div className="text-xs text-stone-500">{model.name}</div></div> },
        { title: "能力", dataIndex: "capability", width: 90, render: (value: AdminModel["capability"]) => ({ image: "图片", text: "文本", video: "视频", audio: "音频" })[value] },
        { title: "排序", dataIndex: "sortOrder", width: 80 },
        { title: "价格", dataIndex: "pricePerImage", width: 200, render: (value: string | null, model) => model.inputPricePerMillion ? <span>输入 ¥{model.inputPricePerMillion}{model.cachedPricePerMillion ? ` / 缓存 ¥${model.cachedPricePerMillion}` : ""} / 输出 ¥{model.outputPricePerMillion} <span className="text-stone-500">/ 百万token</span></span> : model.pricePerSecond ? `¥${model.pricePerSecond} / 秒` : `¥${model.price || value || "0"} / ${model.capability === "image" ? "张" : "次"}` },
        { title: "状态", dataIndex: "status", width: 130, render: (status: AdminModel["status"], model) => <Select size="small" value={status} onChange={(value) => statusMutation.mutate({ id: model.id, status: value })} options={[{ value: "draft", label: "草稿" }, { value: "published", label: "已发布" }, { value: "disabled", label: "已停用" }]} /> },
        { title: "说明", dataIndex: "description", ellipsis: true, render: (value: string | null) => <span className="text-stone-500">{value || "—"}</span> },
        { title: "操作", key: "actions", fixed: "right", width: 240, render: (_, model) => <Space><Button type="text" size="small" icon={<Cable className="size-3.5" />} onClick={() => openBinding(model)}>渠道配置</Button><Button type="text" size="small" icon={<Pencil className="size-3.5" />} onClick={() => setEditing(model)}>编辑</Button><Button type="text" danger size="small" icon={<Trash2 className="size-3.5" />} onClick={() => modal.confirm({ title: `删除 ${model.displayName}？`, content: "有关联记录时服务端会拒绝删除。", okText: "删除", cancelText: "取消", okButtonProps: { danger: true }, onOk: () => deleteMutation.mutateAsync(model.id) })} /></Space> },
    ];

    return (
        <AdminPage title="模型管理" eyebrow="Model catalog" description="发布普通用户可见的真实模型，并配置价格与上游渠道。" action={<Button type="primary" icon={<Plus className="size-4" />} onClick={() => setEditing(null)}>创建模型</Button>}>
            <Table<AdminModel> rowKey="id" columns={columns} dataSource={modelsQuery.data || []} loading={modelsQuery.isLoading} pagination={false} scroll={{ x: 980 }} />
            <Modal title={editing ? "编辑模型" : "创建模型"} open={editing !== undefined} footer={null} onCancel={() => setEditing(undefined)} destroyOnHidden>
                <Form<ModelValues> form={modelForm} layout="vertical" requiredMark={false} className="pt-3" onFinish={(values) => saveModel.mutate(values)}>
                    <Form.Item name="displayName" label="显示名称" rules={[{ required: true, message: "请输入显示名称" }]}><Input placeholder="例如 GPT Image 2" /></Form.Item>
                    <Form.Item name="name" label="模型标识" extra="可与其他公开模型相同；实际渠道由下方的渠道绑定决定。" rules={[{ required: true, message: "请输入模型标识" }]}><Input placeholder="例如 gpt-image-2" /></Form.Item>
                    <div className="grid grid-cols-3 gap-4"><Form.Item name="capability" label="能力" rules={[{ required: true }]}><Select disabled={Boolean(editing)} options={[{ value: "image", label: "图片" }, { value: "text", label: "文本" }, { value: "video", label: "视频" }, { value: "audio", label: "音频" }]} /></Form.Item><Form.Item name="sortOrder" label="排序" extra="数值越小越靠前"><InputNumber min={0} precision={0} className="w-full" /></Form.Item><Form.Item name="status" label="状态" rules={[{ required: true }]}><Select options={[{ value: "draft", label: "草稿" }, { value: "published", label: "已发布" }, { value: "disabled", label: "已停用" }]} /></Form.Item></div>
                    <Form.Item noStyle shouldUpdate={(prev, cur) => prev.capability !== cur.capability || prev.tokenPricing !== cur.tokenPricing || prev.perSecondPricing !== cur.perSecondPricing}>{({ getFieldValue }) => {
                        const capability = getFieldValue("capability");
                        const tokenPricing = capability === "text" && getFieldValue("tokenPricing");
                        const secondPricing = (capability === "video" || capability === "audio") && getFieldValue("perSecondPricing");
                        return <>
                            {capability === "text" ? <Form.Item name="maxOutputTokens" label="最大输出 token" extra="由管理员按模型配置，统一用于报价、文本对话和画布生成；用户端不展示或修改，不设置默认值。" rules={[{ required: true, message: "请配置该模型的最大输出 token 数" }]}><InputNumber min={1} precision={0} className="!w-full" /></Form.Item> : null}
                            {capability === "text" ? <Form.Item name="reasoningEfforts" label="开放的思考强度" extra="按该模型及绑定渠道实际支持的档位勾选；留空时用户仅使用模型默认。"><Select mode="multiple" allowClear placeholder="仅使用模型默认" options={modelReasoningEfforts.map((value) => ({ value, label: `${reasoningEffortLabel(value)}（${value}）` }))} /></Form.Item> : null}
                            {capability === "text" ? <Form.Item name="tokenPricing" label="计费模式" valuePropName="checked" extra="按 token 计费后，单次价格仅作为最低冻结额度兜底；实际费用按回复用量结算，多退少补。"><Switch checkedChildren="按 token" unCheckedChildren="按次" /></Form.Item> : null}
                            {(capability === "video" || capability === "audio") ? <Form.Item name="perSecondPricing" label="计费模式" valuePropName="checked" extra={capability === "audio" ? "按音频实际时长结算，先按 5 秒预估冻结。" : "按请求的视频秒数结算。"}><Switch checkedChildren="按秒" unCheckedChildren="按次" /></Form.Item> : null}
                            {(capability === "video" || capability === "audio") && getFieldValue("perSecondPricing") ? <Form.Item name="pricePerSecond" label="每秒价格（元）" rules={[{ required: true, message: "请输入每秒价格" }]}><InputNumber<string> stringMode min="0" precision={6} className="w-full" /></Form.Item> : null}
                            {capability === "text" && tokenPricing ? <div className="grid grid-cols-3 gap-4"><Form.Item name="inputPrice" label="输入单价（元 / 百万token）" rules={[{ required: true, message: "请输入输入单价" }]}><InputNumber<string> stringMode min="0" precision={6} className="w-full" /></Form.Item><Form.Item name="cachedPrice" label="缓存命中单价" extra="留空按输入单价，0 表示免费"><InputNumber<string> stringMode min="0" precision={6} className="w-full" /></Form.Item><Form.Item name="outputPrice" label="输出单价（元 / 百万token）" rules={[{ required: true, message: "请输入输出单价" }]}><InputNumber<string> stringMode min="0" precision={6} className="w-full" /></Form.Item></div> : null}
                            <Form.Item name="pricePerImage" label={tokenPricing || secondPricing ? "最低预冻结金额（元）" : "单次价格（元）"} extra={tokenPricing || secondPricing ? "与用量预估取较大值冻结，最终仍按实际用量结算；可填 0。" : "图片按张，其他类型按次；失败退回冻结余额。"}><InputNumber<string> stringMode min="0" precision={6} className="w-full" /></Form.Item>
                        </>;
                    }}</Form.Item>
                    <Form.Item name="description" label="说明"><Input.TextArea rows={3} /></Form.Item>
                    <Space className="flex justify-end"><Button onClick={() => setEditing(undefined)}>取消</Button><Button type="primary" htmlType="submit" loading={saveModel.isPending}>保存</Button></Space>
                </Form>
            </Modal>
            <Drawer title={`${bindingModel?.displayName || "模型"} · 渠道配置`} size={680} open={Boolean(bindingModel)} onClose={() => setBindingModel(null)}>
                <Button className="mb-4" type="primary" icon={<Plus className="size-4" />} onClick={() => { setEditingBindingId(null); bindingForm.resetFields(); bindingForm.setFieldsValue({ priority: 0, weight: 100, enabled: true }); setBindingOpen(true); }}>添加渠道</Button>
                <Table rowKey="id" size="small" loading={bindingsQuery.isLoading} dataSource={bindingsQuery.data || []} pagination={false} columns={[{ title: "渠道", dataIndex: "channelName" }, { title: "上游模型", dataIndex: "upstreamModel" }, { title: "优先级", dataIndex: "priority", width: 80 }, { title: "权重", dataIndex: "weight", width: 70 }, { title: "状态", dataIndex: "enabled", width: 70, render: (value) => value ? <Tag color="green">启用</Tag> : <Tag>停用</Tag> }, { title: "操作", width: 110, render: (_, binding) => <Space><Button type="text" size="small" onClick={() => { setEditingBindingId(binding.id); bindingForm.setFieldsValue({ id: binding.id, channelId: binding.channelId, upstreamModel: binding.upstreamModel, priority: binding.priority, weight: binding.weight, enabled: binding.enabled }); setBindingOpen(true); }}>编辑</Button><Button type="text" danger size="small" onClick={() => unbindMutation.mutate(binding.id)}>移除</Button></Space> }]} />
                {bindingModel ? <ChannelCosts key={bindingModel.id} model={bindingModel} /> : null}
            </Drawer>
            <Modal title="配置模型渠道" open={bindingOpen} footer={null} onCancel={() => setBindingOpen(false)} destroyOnHidden>
                <Form<BindingValues> form={bindingForm} layout="vertical" requiredMark={false} className="pt-3" onFinish={(values) => bindingMutation.mutate(values)}>
                    <Form.Item name="id" hidden><Input /></Form.Item>
                    <Form.Item name="channelId" label="渠道" rules={[{ required: true, message: "请选择渠道" }]}><Select disabled={Boolean(editingBindingId)} options={(channelsQuery.data || []).map((channel) => ({ value: channel.id, label: `${channel.name} · ${channel.protocol}` }))} /></Form.Item>
                    <Form.Item name="upstreamModel" label="上游模型名称" rules={[{ required: true, message: "请输入上游模型名称" }]}><Input /></Form.Item>
                    <div className="grid grid-cols-2 gap-4"><Form.Item name="priority" label="优先级" rules={[{ required: true }]}><InputNumber className="w-full" precision={0} /></Form.Item><Form.Item name="weight" label="同级权重" rules={[{ required: true }]}><InputNumber className="w-full" min={1} precision={0} /></Form.Item></div>
                    <Form.Item name="enabled" label="启用" valuePropName="checked"><Switch /></Form.Item>
                    <Space className="flex justify-end"><Button onClick={() => setBindingOpen(false)}>取消</Button><Button type="primary" htmlType="submit" loading={bindingMutation.isPending}>保存配置</Button></Space>
                </Form>
            </Modal>
        </AdminPage>
    );
}

function normalizeModel(values: ModelValues, config: Record<string, unknown>): ModelInput {
    const { tokenPricing, inputPrice, cachedPrice, outputPrice, perSecondPricing, pricePerSecond, maxOutputTokens, reasoningEfforts, ...rest } = values;
    const input: ModelInput = { ...rest, pricePerImage: values.pricePerImage !== undefined ? String(values.pricePerImage) : "0", description: values.description || null, config: { ...config, ...(values.capability === "text" ? { maxOutputTokens, reasoningEfforts: reasoningEfforts || [] } : {}) } };
    if (values.capability === "text" && tokenPricing) {
        input.inputPricePerMillion = inputPrice !== undefined ? String(inputPrice) : "";
        input.cachedPricePerMillion = cachedPrice !== undefined && cachedPrice !== null ? String(cachedPrice) : null;
        input.outputPricePerMillion = outputPrice !== undefined ? String(outputPrice) : "";
    } else {
        input.inputPricePerMillion = null;
        input.cachedPricePerMillion = null;
        input.outputPricePerMillion = null;
    }
    if ((values.capability === "video" || values.capability === "audio") && perSecondPricing) {
        input.pricePerSecond = pricePerSecond !== undefined && pricePerSecond !== null ? String(pricePerSecond) : "";
    } else {
        input.pricePerSecond = null;
    }
    return input;
}

function AdminPage({ title, eyebrow, description, action, children }: { title: string; eyebrow: string; description: string; action: ReactNode; children: ReactNode }) {
    return <div className="w-full px-6 py-6 lg:px-8 lg:py-8"><div className="flex flex-wrap items-end justify-between gap-4"><div><p className="text-xs font-semibold uppercase tracking-[0.18em] text-stone-400">{eyebrow}</p><h1 className="mt-2 text-2xl font-semibold tracking-[-0.03em] text-stone-950 dark:text-stone-100">{title}</h1><p className="mt-1 text-sm text-stone-500">{description}</p></div>{action}</div><div className="mt-6 overflow-hidden rounded-xl border border-stone-200 bg-background dark:border-stone-800">{children}</div></div>;
}

function notifyError(notify: (content: string) => void) { return (error: Error) => notify(error.message || "操作失败"); }

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { App, Button, Checkbox, Drawer, Form, Input, InputNumber, Modal, Select, Space, Switch, Table, Tag, Tooltip } from "antd";
import type { TableColumnsType } from "antd";
import dayjs from "dayjs";
import { Coins, KeyRound, Pencil, Plus, RefreshCw, Search, Settings2, Trash2, Zap } from "lucide-react";

import { useCopyText } from "@/hooks/use-copy-text";
import { queryChannelBalance } from "@/services/api/billing";
import { checkAllChannels } from "@/services/api/platform-operations";
import { batchSaveModelChannelBindings, createAdminChannel, createAdminModel, deleteAdminChannel, fetchAdminChannelModels, getAdminChannels, getAdminModels, saveModelChannelBinding, updateAdminChannel, type AdminChannel, type ChannelInput } from "@/services/api/admin-platform";
import ChannelMonitoring from "./components/channel-monitoring";

type ChannelValues = Omit<ChannelInput, "timeoutMs"> & { timeoutSeconds: number; cooldownSeconds: number };
type QuickModelValues = {
    targetModelId: string;
    name?: string;
    displayName?: string;
    capability?: "image" | "text" | "video" | "audio";
    status?: "draft" | "published" | "disabled";
    pricePerImage?: number;
    priority: number;
    weight: number;
    enabled: boolean;
};

const createModelValue = "__create_model__";

export default function AdminChannelsPage() {
    const { message, modal } = App.useApp();
    const queryClient = useQueryClient();
    const [editing, setEditing] = useState<AdminChannel | null | undefined>(undefined);
    const [monitoring, setMonitoring] = useState<AdminChannel | null>(null);
    const [modelResult, setModelResult] = useState<{ channel: AdminChannel; models: string[]; checkedAt: string } | null>(null);
    const [modelSearch, setModelSearch] = useState("");
    const [selectedModels, setSelectedModels] = useState<string[]>([]);
    const [batchOpen, setBatchOpen] = useState(false);
    const [configuringUpstream, setConfiguringUpstream] = useState<string | null>(null);
    const [form] = Form.useForm<ChannelValues>();
    const [quickModelForm] = Form.useForm<QuickModelValues>();
    const [batchForm] = Form.useForm<{ targetModelId: string; priority: number; weight: number; enabled: boolean }>();
    const copyText = useCopyText();
    const channelsQuery = useQuery({ queryKey: ["admin", "channels"], queryFn: getAdminChannels });
    const modelsQuery = useQuery({ queryKey: ["admin", "models"], queryFn: getAdminModels, enabled: Boolean(modelResult) });
    const refresh = () => queryClient.invalidateQueries({ queryKey: ["admin", "channels"] });
    const saveMutation = useMutation({ mutationFn: (values: ChannelValues) => editing ? updateAdminChannel(editing.id, channelPayload(values)) : createAdminChannel(channelPayload(values) as ChannelInput), onSuccess: () => { void refresh(); setEditing(undefined); form.resetFields(); message.success(editing ? "渠道已更新" : "渠道已创建"); }, onError: notifyError(message.error) });
    const deleteMutation = useMutation({ mutationFn: deleteAdminChannel, onSuccess: () => { void refresh(); message.success("渠道已删除"); }, onError: notifyError(message.error) });
    const modelsMutation = useMutation({ mutationFn: (channel: AdminChannel) => fetchAdminChannelModels(channel.id).then((result) => ({ channel, ...result })), onSuccess: ({ channel, models, health }) => { void refresh(); setModelSearch(""); setSelectedModels([]); setModelResult({ channel, models, checkedAt: health.checkedAt }); message.success("渠道连接正常"); }, onError: (error) => { void refresh(); message.error(error.message || "渠道连接失败"); } });
    const balanceMutation = useMutation({ mutationFn: (id: string) => queryChannelBalance(id), onSuccess: (data, id) => { const channel = (channelsQuery.data || []).find((item) => item.id === id); message.info(`余额查询${data.balance !== undefined ? `：$${data.balance.toFixed(2)}（额度 $${data.quota?.toFixed(2)}，已用 $${data.used?.toFixed(2)}）` : data.quota !== undefined ? `：额度 $${data.quota.toFixed(2)}` : "成功"}${channel ? ` · ${channel.name}` : ""}`); }, onError: (error: Error) => message.error(error.message) });
    const testMutation = useMutation({ mutationFn: (channel: AdminChannel) => fetchAdminChannelModels(channel.id), onSuccess: (result) => { void refresh(); message.success(`渠道连接正常，上游返回 ${result.models.length} 个模型`); }, onError: (error) => { void refresh(); message.error(error.message || "渠道连接失败"); } });
    const checkAll = useMutation({ mutationFn: checkAllChannels, onSuccess: (result) => { void refresh(); message.success(result.queued ? `已提交 ${result.queued} 个渠道检测` : "没有可检测的启用渠道"); }, onError: (error: Error) => message.error(error.message) });
    const batchMutation = useMutation({
        mutationFn: async (values: { targetModelId: string; priority: number; weight: number; enabled: boolean }) => {
            if (!modelResult || !selectedModels.length) throw new Error("请选择上游模型");
            await batchSaveModelChannelBindings(values.targetModelId, modelResult.channel.id, {
                upstreamModels: selectedModels,
                priority: values.priority,
                weight: values.weight,
                enabled: values.enabled,
            });
        },
        onSuccess: () => {
            void queryClient.invalidateQueries({ queryKey: ["admin", "models"] });
            void queryClient.invalidateQueries({ queryKey: ["admin", "model-bindings"] });
            setBatchOpen(false);
            const count = selectedModels.length;
            setSelectedModels([]);
            batchForm.resetFields();
            message.success(`已成功批量绑定 ${count} 个上游模型`);
        },
        onError: notifyError(message.error),
    });
    const quickModelMutation = useMutation({
        mutationFn: async (values: QuickModelValues) => {
            if (!modelResult || !configuringUpstream) throw new Error("请选择上游模型");
            let modelId = values.targetModelId;
            if (modelId === createModelValue) {
                if (!values.name || !values.displayName || !values.capability || !values.status) throw new Error("请完善平台模型信息");
                const model = await createAdminModel({ name: values.name, displayName: values.displayName, capability: values.capability, status: values.status, pricePerImage: values.pricePerImage ?? "0", description: null, config: {} });
                modelId = model.id;
            }
            await saveModelChannelBinding(modelId, modelResult.channel.id, { upstreamModel: configuringUpstream, priority: values.priority, weight: values.weight, enabled: values.enabled });
        },
        onSuccess: () => {
            void queryClient.invalidateQueries({ queryKey: ["admin", "models"] });
            void queryClient.invalidateQueries({ queryKey: ["admin", "model-bindings"] });
            setConfiguringUpstream(null);
            quickModelForm.resetFields();
            message.success("平台模型与渠道已配置");
        },
        onError: notifyError(message.error),
    });

    useEffect(() => {
        if (editing === undefined) return;
        form.resetFields();
        form.setFieldsValue(editing ? { name: editing.name, protocol: editing.protocol, baseUrl: editing.baseUrl, status: editing.status, timeoutSeconds: editing.timeoutMs / 1000, maxConcurrency: editing.maxConcurrency, cooldownSeconds: editing.cooldownSeconds ?? 120, apiKey: undefined } : { protocol: "openai", status: "disabled", timeoutSeconds: 480, maxConcurrency: 1, cooldownSeconds: 120 });
    }, [editing, form]);

    const columns: TableColumnsType<AdminChannel> = [
        { title: "主动检测", key: "monitoring", width: 125, render: (_, channel) => <div><Button type="link" size="small" onClick={() => setMonitoring(channel)}>{channel.monitorStatus === "healthy" ? "检测正常" : channel.monitorStatus === "failed" ? "检测异常" : "配置检测"}</Button>{channel.monitorToken ? <div className="text-xs text-muted-foreground">检测中</div> : channel.modelChanges ? <div className="text-xs text-muted-foreground">模型列表有变更</div> : null}</div> },
        { title: "渠道", key: "channel", width: 152, render: (_, channel) => <div><div className="font-medium text-stone-950 dark:text-stone-100">{channel.name}</div><div className="text-xs uppercase text-stone-500">{channel.protocol}</div></div> },
        { title: "接口地址", dataIndex: "baseUrl", width: 221, ellipsis: true, render: (value: string) => <span className="text-stone-500" title={value}>{value}</span> },
        { title: "密钥", key: "secret", width: 130, render: (_, channel) => channel.apiKeyConfigured ? <span className="inline-flex items-center gap-1.5 text-xs text-stone-500"><KeyRound className="size-3.5" />{channel.apiKeyHint || "已配置"}</span> : <Tag color="orange">未配置</Tag> },
        { title: "并发", dataIndex: "maxConcurrency", width: 65 },
        { title: "超时", dataIndex: "timeoutMs", width: 75, render: (value: number) => `${Math.round(value / 1000)}s` },
        { title: "故障冷却", dataIndex: "cooldownSeconds", width: 85, render: (value: number) => `${value ?? 120}s` },
        { title: "状态", dataIndex: "status", width: 140, render: (status: AdminChannel["status"], channel) => <Space size={4} wrap><Tag color={status === "active" ? "green" : status === "needs_attention" ? "red" : "default"}>{status === "active" ? "启用" : status === "needs_attention" ? "需检查" : "停用"}</Tag>{channel.cooldownUntil && new Date(channel.cooldownUntil) > new Date() ? <Tag color="orange">冷却中</Tag> : null}{channel.lastErrorCode && status !== "active" ? <Tooltip title={channel.lastErrorCode}><Tag color="red">异常</Tag></Tooltip> : null}</Space> },
        { title: "最近尝试", key: "health", width: 307, render: (_, channel) => {
            const attempt = channel.lastAttempt;
            if (!attempt) return <div className="text-xs text-stone-500">{channel.lastErrorCode ? <span className="text-red-500">{channel.lastErrorCode}</span> : channel.lastSuccessAt ? dayjs(channel.lastSuccessAt).format("YYYY-MM-DD HH:mm") : "尚无尝试"}</div>;
            const detail = [`${attempt.status === "succeeded" ? "成功" : attempt.status === "failed" ? "失败" : "运行中"} · ${attempt.durationMs == null ? "--" : `${(attempt.durationMs / 1000).toFixed(1)}s`} · ${attempt.upstreamModel}`, attempt.errorMessage || attempt.errorCategory || "", dayjs(attempt.startedAt).format("YYYY-MM-DD HH:mm:ss")].filter(Boolean).join("\n");
            return <div className="cursor-pointer text-xs text-stone-500 hover:text-stone-800 dark:hover:text-stone-200" title="点击复制详情" onClick={() => copyText(detail, "最近尝试详情已复制")}><div className={attempt.status === "succeeded" ? "text-emerald-600" : attempt.status === "failed" ? "text-red-500" : ""}>{attempt.status === "succeeded" ? "成功" : attempt.status === "failed" ? "失败" : "运行中"} · {attempt.durationMs == null ? "--" : `${(attempt.durationMs / 1000).toFixed(1)}s`} · {attempt.upstreamModel}</div>{attempt.errorMessage || attempt.errorCategory ? <div className="mt-1 break-all text-stone-500">{attempt.errorMessage || attempt.errorCategory}</div> : null}<div className="mt-1 text-stone-400">{dayjs(attempt.startedAt).format("YYYY-MM-DD HH:mm:ss")}</div></div>;
        } },
        { title: "操作", key: "actions", fixed: "right", width: 310, render: (_, channel) => <Space><Button type="text" size="small" loading={balanceMutation.isPending && balanceMutation.variables === channel.id} icon={<Coins className="size-3.5" />} onClick={() => balanceMutation.mutate(channel.id)}>余额</Button><Button type="text" size="small" loading={testMutation.isPending && testMutation.variables?.id === channel.id} icon={<Zap className="size-3.5" />} onClick={() => testMutation.mutate(channel)}>测试</Button><Button type="text" size="small" loading={modelsMutation.isPending && modelsMutation.variables?.id === channel.id} icon={<Settings2 className="size-3.5" />} onClick={() => modelsMutation.mutate(channel)}>配置模型</Button><Button type="text" size="small" icon={<Pencil className="size-3.5" />} onClick={() => setEditing(channel)}>编辑</Button><Button type="text" danger size="small" icon={<Trash2 className="size-3.5" />} onClick={() => modal.confirm({ title: `删除 ${channel.name}？`, content: "已被模型使用的渠道可能无法删除。", okText: "删除", cancelText: "取消", okButtonProps: { danger: true }, onOk: () => deleteMutation.mutateAsync(channel.id) })} /></Space> },
    ];
    const filteredModels = [...new Set(modelResult?.models || [])].filter((name) => name.toLowerCase().includes(modelSearch.trim().toLowerCase()));
    const openQuickModel = (upstreamModel: string) => {
        const suggestedName = upstreamModel.slice(0, 120);
        const matchingModels = modelsQuery.data?.filter((model) => model.name === suggestedName) || [];
        const matchedModel = matchingModels.length === 1 ? matchingModels[0] : undefined;
        quickModelForm.resetFields();
        quickModelForm.setFieldsValue({ targetModelId: matchedModel?.id || createModelValue, name: suggestedName, displayName: suggestedName, capability: "image", status: "draft", priority: 0, weight: 100, enabled: true });
        setConfiguringUpstream(upstreamModel);
    };

    return (
        <div className="w-full px-6 py-6 lg:px-8 lg:py-8">
            <div className="flex flex-wrap items-end justify-between gap-4"><div><p className="text-xs font-semibold uppercase tracking-[0.18em] text-stone-400">Provider routing</p><h1 className="mt-2 text-2xl font-semibold tracking-[-0.03em] text-stone-950 dark:text-stone-100">渠道管理</h1><p className="mt-1 text-sm text-stone-500">维护上游接口、密钥、超时、单渠道并发和故障冷却期，密钥原值不会回显。</p></div><Space wrap><Button loading={checkAll.isPending} onClick={() => modal.confirm({ title: "检测全部已配置渠道？", content: "仅提交已启用且配置了检测项目的渠道。生成检测会产生真实上游费用。", okText: "开始检测", onOk: () => checkAll.mutateAsync() })}>检测全部渠道</Button><Button className="shrink-0" type="primary" icon={<Plus className="size-4" />} onClick={() => setEditing(null)}>创建渠道</Button></Space></div>
            <div className="mt-6 overflow-hidden rounded-xl border border-stone-200 bg-background dark:border-stone-800"><Table<AdminChannel> rowKey="id" columns={columns} dataSource={channelsQuery.data || []} loading={channelsQuery.isLoading} pagination={false} scroll={{ x: 1365 }} /></div>
            <Modal title={editing ? "编辑渠道" : "创建渠道"} open={editing !== undefined} footer={null} onCancel={() => setEditing(undefined)} destroyOnHidden>
                <Form<ChannelValues> form={form} layout="vertical" requiredMark={false} className="pt-3" onFinish={(values) => saveMutation.mutate(values)}>
                    <Form.Item name="name" label="渠道名称" rules={[{ required: true, message: "请输入渠道名称" }]}><Input /></Form.Item>
                    <div className="grid grid-cols-2 gap-4"><Form.Item name="protocol" label="协议" rules={[{ required: true }]}><Select options={[{ value: "openai", label: "OpenAI 兼容" }, { value: "gemini", label: "Gemini" }]} /></Form.Item><Form.Item name="status" label="状态" rules={[{ required: true }]}><Select options={[{ value: "disabled", label: "停用" }, { value: "active", label: "启用" }, { value: "needs_attention", label: "需检查" }]} /></Form.Item></div>
                    <Form.Item name="baseUrl" label="Base URL" rules={[{ required: true, message: "请输入 Base URL" }, { type: "url", message: "请输入有效 URL" }]}><Input placeholder="https://api.example.com/v1" /></Form.Item>
                    <Form.Item name="apiKey" label={editing?.apiKeyConfigured ? "替换 API Key" : "API Key"} extra={editing?.apiKeyConfigured ? `当前密钥：${editing.apiKeyHint || "已配置"}。留空表示保持不变。` : "密钥只会提交到服务端加密保存，不会在页面回显。"}><Input.Password autoComplete="new-password" placeholder={editing?.apiKeyConfigured ? "留空则不替换" : "请输入 API Key（如上游需要）"} /></Form.Item>
                    <div className="grid grid-cols-3 gap-4">
                        <Form.Item name="timeoutSeconds" label="超时（秒）" extra="视频渠道可按上游生成耗时单独配置。" rules={[{ required: true }]}><InputNumber className="w-full" min={1} precision={0} /></Form.Item>
                        <Form.Item name="maxConcurrency" label="最大并发" rules={[{ required: true }]}><InputNumber className="w-full" min={1} max={20} precision={0} /></Form.Item>
                        <Form.Item name="cooldownSeconds" label="故障冷却（秒）" tooltip="遇到网络超时、5xx 或频控时渠道暂停调度的时长，0 表示不冷却" rules={[{ required: true }]}><InputNumber className="w-full" min={0} max={86400} precision={0} /></Form.Item>
                    </div>
                    <Space className="flex justify-end"><Button onClick={() => setEditing(undefined)}>取消</Button><Button type="primary" htmlType="submit" loading={saveMutation.isPending}>保存</Button></Space>
                </Form>
            </Modal>
            <Drawer title={`${modelResult?.channel.name || "渠道"} · 上游模型`} extra={<Space><Button type="text" size="small" loading={modelsMutation.isPending} icon={<RefreshCw className="size-3.5" />} onClick={() => modelResult && modelsMutation.mutate(modelResult.channel)}>重新获取</Button></Space>} open={Boolean(modelResult)} onClose={() => { setModelResult(null); setSelectedModels([]); }} size="min(680px, 100vw)">
                <div className="mb-4 flex flex-wrap items-center justify-between gap-2 text-sm text-stone-500">
                    <span>共 {modelResult?.models.length || 0} 个模型，可直接创建或绑定平台模型</span>
                    <Space>
                        {selectedModels.length > 0 ? (
                            <Button type="primary" size="small" onClick={() => { batchForm.resetFields(); batchForm.setFieldsValue({ priority: 0, weight: 100, enabled: true }); setBatchOpen(true); }}>
                                批量绑定 ({selectedModels.length})
                            </Button>
                        ) : null}
                        <span className="text-xs">{modelResult ? dayjs(modelResult.checkedAt).format("YYYY-MM-DD HH:mm:ss") : ""}</span>
                    </Space>
                </div>
                <Input allowClear value={modelSearch} onChange={(event) => setModelSearch(event.target.value)} prefix={<Search className="size-4 text-stone-400" />} placeholder="搜索上游模型" />
                <div className="mt-2.5 flex items-center justify-between px-1 text-xs text-stone-500">
                    <Checkbox
                        checked={filteredModels.length > 0 && filteredModels.every((m) => selectedModels.includes(m))}
                        indeterminate={filteredModels.some((m) => selectedModels.includes(m)) && !filteredModels.every((m) => selectedModels.includes(m))}
                        onChange={(e) => {
                            if (e.target.checked) {
                                setSelectedModels(Array.from(new Set([...selectedModels, ...filteredModels])));
                            } else {
                                setSelectedModels(selectedModels.filter((m) => !filteredModels.includes(m)));
                            }
                        }}
                    >
                        全选当前筛选 ({filteredModels.length})
                    </Checkbox>
                    {selectedModels.length > 0 ? (
                        <Button type="link" size="small" className="h-auto p-0 text-xs" onClick={() => setSelectedModels([])}>
                            清空选择
                        </Button>
                    ) : null}
                </div>
                <div className="mt-3 max-h-[calc(100vh-230px)] overflow-y-auto rounded-lg border border-stone-200 dark:border-stone-800">
                    {filteredModels.length ? filteredModels.map((name) => (
                        <div key={name} className="flex items-center gap-3 border-b border-stone-100 px-4 py-2.5 last:border-b-0 dark:border-stone-800">
                            <Checkbox
                                checked={selectedModels.includes(name)}
                                onChange={(e) => {
                                    if (e.target.checked) {
                                        setSelectedModels([...selectedModels, name]);
                                    } else {
                                        setSelectedModels(selectedModels.filter((m) => m !== name));
                                    }
                                }}
                            />
                            <code className="min-w-0 flex-1 truncate text-xs text-stone-600 dark:text-stone-300" title={name}>{name}</code>
                            <Button type="text" size="small" icon={<Settings2 className="size-3.5" />} onClick={() => openQuickModel(name)}>配置</Button>
                        </div>
                    )) : <div className="py-12 text-center text-sm text-stone-500">{modelResult?.models.length ? "没有匹配的上游模型" : "上游没有返回可识别的模型"}</div>}
                </div>
            </Drawer>
            <Modal title={`批量绑定平台模型 (${selectedModels.length} 个模型)`} open={batchOpen} footer={null} onCancel={() => setBatchOpen(false)} destroyOnHidden width={560}>
                <div className="mb-4 max-h-32 overflow-y-auto rounded-lg bg-stone-50 p-2.5 text-xs text-stone-600 dark:bg-stone-900 dark:text-stone-300">
                    <div className="mb-1.5 font-medium text-stone-500">已选上游模型：</div>
                    <div className="flex flex-wrap gap-1">
                        {selectedModels.map((m) => (
                            <Tag key={m} className="font-mono text-xs">{m}</Tag>
                        ))}
                    </div>
                </div>
                <Form form={batchForm} layout="vertical" requiredMark={false} onFinish={(values) => batchMutation.mutate(values)}>
                    <Form.Item name="targetModelId" label="目标平台模型" rules={[{ required: true, message: "请选择平台模型" }]}>
                        <Select showSearch optionFilterProp="label" loading={modelsQuery.isLoading} placeholder="请选择要关联的平台模型" options={(modelsQuery.data || []).map((model) => ({ value: model.id, label: `${model.displayName} · ${model.name}` }))} />
                    </Form.Item>
                    <div className="grid grid-cols-2 gap-4">
                        <Form.Item name="priority" label="优先级" tooltip="数值越大越优先，适合配置主备" rules={[{ required: true }]}>
                            <InputNumber className="w-full" precision={0} />
                        </Form.Item>
                        <Form.Item name="weight" label="同级权重" tooltip="相同优先级的渠道按权重分流" rules={[{ required: true }]}>
                            <InputNumber className="w-full" min={1} precision={0} />
                        </Form.Item>
                    </div>
                    <Form.Item name="enabled" label="启用此渠道" valuePropName="checked">
                        <Switch />
                    </Form.Item>
                    <Space className="flex justify-end">
                        <Button onClick={() => setBatchOpen(false)}>取消</Button>
                        <Button type="primary" htmlType="submit" loading={batchMutation.isPending}>确认批量绑定</Button>
                    </Space>
                </Form>
            </Modal>
            <Modal title="配置平台模型" open={Boolean(configuringUpstream)} footer={null} onCancel={() => setConfiguringUpstream(null)} destroyOnHidden width={560}>
                <div className="mb-4 rounded-lg bg-stone-50 px-3 py-2.5 dark:bg-stone-900"><div className="text-xs text-stone-500">上游模型</div><code className="mt-1 block break-all text-xs text-stone-800 dark:text-stone-200">{configuringUpstream}</code></div>
                <Form<QuickModelValues> form={quickModelForm} layout="vertical" requiredMark={false} onFinish={(values) => quickModelMutation.mutate(values)}>
                    <Form.Item name="targetModelId" label="平台模型" extra="只有唯一同名平台模型会自动选中；存在多个同名变体时请手动选择，也可以创建新模型。" rules={[{ required: true, message: "请选择平台模型" }]}><Select showSearch optionFilterProp="label" loading={modelsQuery.isLoading} options={[{ value: createModelValue, label: "＋ 创建新平台模型" }, ...(modelsQuery.data || []).map((model) => ({ value: model.id, label: `${model.displayName} · ${model.name}` }))]} /></Form.Item>
                    <Form.Item noStyle shouldUpdate={(previous, current) => previous.targetModelId !== current.targetModelId}>{({ getFieldValue }) => getFieldValue("targetModelId") === createModelValue ? <>
                        <div className="grid grid-cols-2 gap-4"><Form.Item name="displayName" label="显示名称" rules={[{ required: true, message: "请输入显示名称" }, { max: 120 }]}><Input /></Form.Item><Form.Item name="name" label="模型标识" extra="可与其他公开模型相同。" rules={[{ required: true, message: "请输入模型标识" }, { max: 120 }]}><Input /></Form.Item></div>
                        <div className="grid grid-cols-2 gap-4"><Form.Item name="capability" label="能力" rules={[{ required: true }]}><Select options={[{ value: "image", label: "图片" }, { value: "text", label: "文本" }, { value: "video", label: "视频" }, { value: "audio", label: "音频" }]} /></Form.Item><Form.Item name="status" label="发布状态" rules={[{ required: true }]}><Select options={[{ value: "draft", label: "草稿" }, { value: "published", label: "已发布" }, { value: "disabled", label: "已停用" }]} /></Form.Item></div>
                        <Form.Item name="pricePerImage" label="单次价格（元）" extra="图片按每张，其他能力按每个结果收费。"><InputNumber<string> stringMode className="w-full" min="0" precision={6} /></Form.Item>
                    </> : null}</Form.Item>
                    <div className="grid grid-cols-2 gap-4"><Form.Item name="priority" label="优先级" tooltip="数值越大越优先，适合配置主备渠道" rules={[{ required: true }]}><InputNumber className="w-full" precision={0} /></Form.Item><Form.Item name="weight" label="同级权重" tooltip="相同优先级的渠道按权重分流" rules={[{ required: true }]}><InputNumber className="w-full" min={1} precision={0} /></Form.Item></div>
                    <Form.Item name="enabled" label="启用此渠道" valuePropName="checked"><Switch /></Form.Item>
                    <Space className="flex justify-end"><Button onClick={() => setConfiguringUpstream(null)}>取消</Button><Button type="primary" htmlType="submit" loading={quickModelMutation.isPending}>保存配置</Button></Space>
                </Form>
            </Modal>
            {monitoring ? <ChannelMonitoring key={monitoring.id} channel={monitoring} onClose={() => setMonitoring(null)} /> : null}
        </div>
    );
}

function channelPayload(values: ChannelValues) {
    const { timeoutSeconds, apiKey, ...rest } = values;
    return { ...rest, timeoutMs: timeoutSeconds * 1000, ...(apiKey?.trim() ? { apiKey: apiKey.trim() } : {}) };
}

function notifyError(notify: (content: string) => void) { return (error: Error) => notify(error.message || "操作失败"); }

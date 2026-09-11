import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { App, Button, Form, InputNumber, Modal, Select, Table } from "antd";

import { getModelChannelBindings, type AdminModel, type ModelChannelBinding } from "@/services/api/admin-platform";
import { saveBindingCost, type CostConfig } from "@/services/api/platform-operations";

type Values = CostConfig & { mode: "unknown" | "fixed" | "token" | "second" };
export default function ChannelCosts({ model }: { model: AdminModel }) {
    const { message } = App.useApp();
    const client = useQueryClient();
    const [editing, setEditing] = useState<ModelChannelBinding | null>(null);
    const [form] = Form.useForm<Values>();
    const mode = Form.useWatch("mode", form);
    const bindings = useQuery({ queryKey: ["admin", "model-bindings", model.id], queryFn: () => getModelChannelBindings(model.id) });
    const save = useMutation({ mutationFn: (values: Values) => {
        const cost: CostConfig = {};
        const keys = values.mode === "token" ? ["input", "cached", "output"] as const : values.mode === "fixed" ? ["fixed"] as const : values.mode === "second" ? ["second"] as const : [];
        for (const key of keys) if (values[key] !== undefined && values[key] !== null && values[key] !== "") cost[key] = String(values[key]);
        return saveBindingCost(model.id, editing!.id, cost);
    }, onSuccess: () => { setEditing(null); void client.invalidateQueries({ queryKey: ["admin", "model-bindings", model.id] }); message.success("渠道成本已保存，仅影响后续调用"); }, onError: (error: Error) => message.error(error.message) });
    return <section className="mt-8 border-t border-border pt-6"><h3 className="font-medium">上游成本配置</h3><p className="mb-4 mt-2 text-sm leading-6 text-muted-foreground">与用户售价独立。使用人民币配置；调用时保存快照，之后可按渠道账单核对。未配置的成本显示为未知。</p>
        <Table rowKey="id" size="small" pagination={false} dataSource={bindings.data || []} columns={[{ title: "渠道", dataIndex: "channelName" }, { title: "上游模型", dataIndex: "upstreamModel" }, { title: "配置", render: (_, binding) => Object.keys(binding.costConfig || {}).length ? "已配置" : "未知" }, { title: "操作", render: (_, binding) => <Button type="text" size="small" onClick={() => { const config = binding.costConfig || {}; setEditing(binding); form.resetFields(); form.setFieldsValue({ ...config, mode: config.input != null ? "token" : config.second != null ? "second" : config.fixed != null ? "fixed" : "unknown" }); }}>设置成本</Button> }]} />
        <Modal title={`${editing?.channelName || "渠道"}${editing?.upstreamModel ? ` (${editing.upstreamModel})` : ""} · 人民币成本`} open={Boolean(editing)} onCancel={() => setEditing(null)} footer={null} forceRender>
            <Form form={form} layout="vertical" className="pt-3" onFinish={(values) => save.mutate(values)}><Form.Item name="mode" label="成本方式"><Select options={[{ value: "unknown", label: "尚未配置" }, { value: "fixed", label: "每次成功结果" }, ...(model.capability === "text" ? [{ value: "token", label: "按 token" }] : []), ...(["video", "audio"].includes(model.capability) ? [{ value: "second", label: "按秒" }] : [])]} /></Form.Item>
                {mode === "token" ? <>{(["input", "cached", "output"] as const).map((field) => <Form.Item key={field} name={field} label={`${({ input: "输入", cached: "缓存命中", output: "输出" })[field]}成本（元 / 百万 token）`} extra={field === "cached" ? "留空采用输入成本；0 表示免费" : undefined} rules={field === "cached" ? [] : [{ required: true }]}><InputNumber<string> stringMode min="0" precision={6} className="!w-full" /></Form.Item>)}</> : mode === "fixed" || mode === "second" ? <Form.Item name={mode} label={mode === "fixed" ? "每次成本（元）" : "每秒成本（元）"} rules={[{ required: true }]}><InputNumber<string> stringMode min="0" precision={6} className="!w-full" /></Form.Item> : null}
                <Button type="primary" htmlType="submit" block loading={save.isPending}>保存成本配置</Button>
            </Form>
        </Modal>
    </section>;
}

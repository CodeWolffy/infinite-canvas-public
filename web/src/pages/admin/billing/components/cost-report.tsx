import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, App, Button, DatePicker, Form, Input, InputNumber, Modal, Select, Space, Table, Tag } from "antd";
import dayjs, { type Dayjs } from "dayjs";
import { saveAs } from "file-saver";

import { getAdminChannels, getAdminModels } from "@/services/api/admin-platform";
import { getCosts, reconcileCost, type CostEntry } from "@/services/api/platform-operations";
import { useUserStore } from "@/stores/use-user-store";

const sources = { unknown: "未知", configured: "配置估算", actual: "已核对" };
type Filters = { range: [Dayjs, Dayjs]; source?: CostEntry["source"]; modelId?: string; channelId?: string };
export default function CostReport() {
    const { message } = App.useApp();
    const client = useQueryClient();
    const session = useUserStore((state) => state.sessionVersion);
    const [page, setPage] = useState(1);
    const [filters, setFilters] = useState<Filters>(() => ({ range: [dayjs().startOf("month"), dayjs()] }));
    const [editing, setEditing] = useState<CostEntry | null>(null);
    const [form] = Form.useForm<{ amount: string; note: string }>();
    const from = filters.range[0].startOf("day").toISOString();
    const to = filters.range[1].add(1, "day").startOf("day").toISOString();
    const params = { from, to, source: filters.source, modelId: filters.modelId, channelId: filters.channelId };
    const query = useQuery({ queryKey: ["admin", "costs", session, page, params], queryFn: () => getCosts((page - 1) * 50, params) });
    const models = useQuery({ queryKey: ["admin", "models"], queryFn: getAdminModels });
    const channels = useQuery({ queryKey: ["admin", "channels"], queryFn: getAdminChannels });
    const save = useMutation({ mutationFn: (values: { amount: string; note: string }) => reconcileCost(editing!.id, { ...values, amount: String(values.amount) }), onSuccess: () => { setEditing(null); void client.invalidateQueries({ queryKey: ["admin", "costs"] }); message.success("成本已核对，已记录操作依据"); }, onError: (error: Error) => message.error(error.message) });
    const totals = query.data?.totals;
    const entries = query.data?.entries || [];
    const exportRows = () => {
        const lines = [["时间", "模型", "渠道", "用户", "上游成本", "来源", "核对依据"].join(","), ...entries.map((item) => [item.createdAt, item.modelName || "渠道检测", item.channelName, item.username || "平台检测", item.amount ?? "未知", sources[item.source], item.note].map((value) => `"${String(value).replace(/"/g, '""')}"`).join(","))];
        saveAs(new Blob([`\ufeff${lines.join("\n")}`], { type: "text/csv;charset=utf-8" }), `成本核对-${dayjs().format("YYYYMMDD")}.csv`);
    };
    return <div className="space-y-5">
        <Space wrap>
            <DatePicker.RangePicker value={filters.range} allowClear={false} onChange={(range) => range && (setFilters((current) => ({ ...current, range: range as [Dayjs, Dayjs] })), setPage(1))} />
            <Select allowClear placeholder="全部来源" className="w-36" value={filters.source} onChange={(source) => { setFilters((current) => ({ ...current, source })); setPage(1); }} options={Object.entries(sources).map(([value, label]) => ({ value, label }))} />
            <Select allowClear placeholder="全部模型" className="min-w-40" value={filters.modelId} onChange={(modelId) => { setFilters((current) => ({ ...current, modelId })); setPage(1); }} options={(models.data || []).map((model) => ({ value: model.id, label: model.displayName }))} />
            <Select allowClear placeholder="全部渠道" className="min-w-40" value={filters.channelId} onChange={(channelId) => { setFilters((current) => ({ ...current, channelId })); setPage(1); }} options={(channels.data || []).map((channel) => ({ value: channel.id, label: channel.name }))} />
            <Button onClick={() => { setFilters((current) => ({ ...current, source: "unknown" })); setPage(1); }}>只看未知成本</Button>
            <Button disabled={!entries.length} onClick={exportRows}>导出当前页 CSV</Button>
        </Space>
        <div className="grid grid-cols-2 gap-6 border-y border-border py-6 lg:grid-cols-4">{[["用户实付", totals?.userPaid], ["已知上游成本", totals?.knownCost], ["成本超过实付的部分", totals?.subsidy], ["已发签到、邀请与公益赠送", totals?.grants]].map(([label, value]) => <div key={label}><p className="text-xs text-muted-foreground">{label}</p><p className="mt-2 break-all font-mono text-xl">¥{value || "0.000000"}</p></div>)}</div>
        <Alert type="info" showIcon title={`另有 ${totals?.unknownCount || 0} 次调用的成本未知`} description="用户实付来自余额账本。上游成本优先使用人工核对值，其余按模型渠道配置估算；未知不按零费用处理。成本差额只基于已知成本，不代表最终账单。渠道检测产生的费用也会记录。" />
        {query.error ? <Alert type="error" title={query.error.message} /> : null}
        <Table<CostEntry> rowKey="id" dataSource={entries} loading={query.isPending} pagination={false} scroll={{ x: 1000 }} columns={[
            { title: "模型 / 渠道", render: (_, item) => <div>{item.modelName || "渠道检测"}<div className="text-xs text-muted-foreground">{item.channelName}</div></div> },
            { title: "用户", dataIndex: "username", render: (value) => value || "平台检测" },
            { title: "上游成本（元）", dataIndex: "amount", render: (value) => value ?? "未知" },
            { title: "来源", dataIndex: "source", render: (value: CostEntry["source"]) => <Tag color={value === "actual" ? "green" : "default"}>{sources[value]}</Tag> },
            { title: "核对依据", dataIndex: "note", ellipsis: true },
            { title: "时间", dataIndex: "createdAt", render: (value: string) => new Date(value).toLocaleString() },
            { title: "操作", width: 100, render: (_, item) => <Button type="text" onClick={() => { setEditing(item); form.setFieldsValue({ amount: item.amount || "0", note: "" }); }}>核对成本</Button> },
        ]} />
        <div className="flex justify-end gap-2"><Button disabled={page === 1} onClick={() => setPage((value) => value - 1)}>上一页</Button><Button disabled={entries.length < 50} onClick={() => setPage((value) => value + 1)}>下一页</Button></div>
        <Modal title="核对上游实际成本" open={Boolean(editing)} onCancel={() => setEditing(null)} footer={null} destroyOnHidden><Form form={form} layout="vertical" className="pt-3" onFinish={(values) => save.mutate(values)}><Form.Item name="amount" label="人民币实际成本（元）" rules={[{ required: true }]}><InputNumber<string> stringMode min="0" precision={6} className="!w-full" /></Form.Item><Form.Item name="note" label="核对依据" rules={[{ required: true, whitespace: true }]}><Input.TextArea rows={3} placeholder="例如：渠道账单编号、结算说明" /></Form.Item><Button type="primary" htmlType="submit" block loading={save.isPending}>保存核对结果</Button></Form></Modal>
    </div>;
}

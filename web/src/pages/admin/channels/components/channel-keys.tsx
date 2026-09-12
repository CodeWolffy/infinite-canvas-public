import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, App, Button, Popconfirm, Space, Switch, Table, Tag } from "antd";
import { Trash2 } from "lucide-react";

import { deleteChannelKey, getChannelKeys, setChannelKeyStatus, type ChannelKey } from "@/services/api/admin-platform";

export default function ChannelKeys({ channelId }: { channelId: string }) {
    const { message } = App.useApp();
    const client = useQueryClient();
    const keys = useQuery({ queryKey: ["admin", "channel-keys", channelId], queryFn: () => getChannelKeys(channelId) });
    const refresh = () => { void client.invalidateQueries({ queryKey: ["admin", "channel-keys", channelId] }); void client.invalidateQueries({ queryKey: ["admin", "channels"] }); };
    const change = useMutation({ mutationFn: ({ id, status }: { id: string; status: ChannelKey["status"] }) => setChannelKeyStatus(channelId, id, status), onSuccess: refresh, onError: (error: Error) => message.error(error.message) });
    const remove = useMutation({ mutationFn: (id: string) => deleteChannelKey(channelId, id), onSuccess: refresh, onError: (error: Error) => message.error(error.message) });
    if (keys.error) return <Alert className="mb-5" type="error" title={keys.error.message} />;
    return <div className="mb-6"><Table<ChannelKey> size="small" rowKey="id" dataSource={keys.data?.keys || []} loading={keys.isPending} pagination={false} columns={[
        { title: "已保存密钥", dataIndex: "keyHint", render: (value: string) => <span className="font-mono">{value}</span> },
        { title: "状态", render: (_, key) => <Tag color={key.status === "active" ? "success" : "default"}>{key.status === "active" ? "可用" : key.disabledReason === "authentication" ? "鉴权失败" : "手动停用"}</Tag> },
        { title: "操作", render: (_, key) => <Space><Switch size="small" aria-label={`启用密钥 ${key.keyHint}`} checked={key.status === "active"} loading={change.isPending && change.variables?.id === key.id} onChange={(enabled) => change.mutate({ id: key.id, status: enabled ? "active" : "disabled" })} /><Popconfirm title="删除此密钥？" description="已提交的异步任务仍会使用原凭据续查。" onConfirm={() => remove.mutateAsync(key.id)}><Button type="text" danger size="small" aria-label="删除密钥" icon={<Trash2 className="size-3.5" />} /></Popconfirm></Space> },
    ]} /></div>;
}

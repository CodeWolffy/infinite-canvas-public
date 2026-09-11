import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Alert, App, Button, Collapse, Form, Input, InputNumber, Radio, Select, Tag, Tooltip } from "antd";
import { CheckCircle2, Clock, Copy, Play, RotateCcw, Sparkles, TerminalSquare, Trash2, XCircle, Zap } from "lucide-react";

import { getAdminChannels, testChannelPlayground, type PlaygroundTestResult } from "@/services/api/admin-platform";

export default function AdminPlaygroundPage() {
    const { message } = App.useApp();
    const [form] = Form.useForm();
    const [result, setResult] = useState<PlaygroundTestResult | null>(null);

    const channelsQuery = useQuery({
        queryKey: ["admin", "channels"],
        queryFn: getAdminChannels,
    });

    const activeChannels = (channelsQuery.data || []).filter((ch) => ch.status !== "disabled");

    const testMutation = useMutation({
        mutationFn: testChannelPlayground,
        onSuccess: (data) => {
            setResult(data);
            if (data.ok) {
                message.success(`测试成功，耗时 ${data.durationMs} ms`);
            } else {
                message.error(`测试失败：${data.error || "未知异常"}`);
            }
        },
        onError: (err: Error) => {
            message.error(err.message);
        },
    });

    const handleChannelChange = (channelId: string) => {
        const ch = activeChannels.find((c) => c.id === channelId);
        if (ch) {
            const defaultModel = ch.lastAttempt?.upstreamModel || ch.upstreamModels?.[0] || (ch.protocol === "openai" ? "gpt-4o-mini" : "gemini-1.5-flash");
            form.setFieldsValue({ model: defaultModel });
        }
    };

    const handleRun = (values: { channelId: string; model: string; capability: "text" | "image"; prompt: string; temperature?: number; maxTokens?: number }) => {
        const parameters: Record<string, unknown> = {};
        if (values.temperature !== undefined) parameters.temperature = values.temperature;
        if (values.maxTokens !== undefined) parameters.max_tokens = values.maxTokens;

        testMutation.mutate({
            channelId: values.channelId,
            model: values.model,
            capability: values.capability,
            prompt: values.prompt,
            parameters,
        });
    };

    const selectedChannelId = Form.useWatch("channelId", form);
    const selectedChannel = activeChannels.find((c) => c.id === selectedChannelId);

    return (
        <div className="flex h-full min-h-full w-full flex-col p-4 sm:p-5 lg:p-6 lg:overflow-hidden">
            {/* 顶部标题栏 */}
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-stone-200 pb-3.5 dark:border-stone-800 shrink-0">
                <div>
                    <div className="flex items-center gap-2 text-stone-500 mb-1">
                        <TerminalSquare className="size-4 text-blue-500" />
                        <span className="text-xs font-semibold uppercase tracking-wider">Channel Playground</span>
                    </div>
                    <h1 className="text-xl font-bold tracking-tight text-stone-950 sm:text-2xl dark:text-stone-100">渠道在线调试台</h1>
                    <p className="mt-0.5 text-xs text-stone-500">
                        无需创建正式任务与扣费，直接向指定渠道发送调试请求，实时测试连通性、响应延迟与原始输出。
                    </p>
                </div>
                {result ? (
                    <Button
                        type="text"
                        size="small"
                        icon={<Trash2 className="size-3.5 text-stone-400" />}
                        onClick={() => setResult(null)}
                        className="text-stone-500 hover:text-stone-900 dark:hover:text-stone-100"
                    >
                        清空结果
                    </Button>
                ) : null}
            </div>

            {/* 主体两栏自适应撑满容器 */}
            <div className="mt-4 grid flex-1 min-h-0 gap-5 lg:grid-cols-12 lg:overflow-hidden">
                {/* 左侧表单配置面板 */}
                <div className="flex flex-col h-full overflow-hidden rounded-xl border border-stone-200 bg-background lg:col-span-5 xl:col-span-4 dark:border-stone-800 shadow-sm">
                    <div className="border-b border-stone-200 px-4 py-3 dark:border-stone-800 flex items-center justify-between">
                        <span className="text-sm font-semibold text-stone-900 dark:text-stone-100">请求参数</span>
                        {selectedChannel ? (
                            <Tag color={selectedChannel.status === "active" ? "green" : "orange"} className="!mr-0 font-mono text-[11px]">
                                {selectedChannel.protocol.toUpperCase()}
                            </Tag>
                        ) : null}
                    </div>

                    <Form
                        form={form}
                        layout="vertical"
                        requiredMark={false}
                        className="flex flex-1 flex-col justify-between overflow-hidden"
                        initialValues={{
                            capability: "text",
                            prompt: "你好，请用简短一句话介绍你自己并说明当前模型名称。",
                            temperature: 0.7,
                        }}
                        onFinish={handleRun}
                    >
                        <div className="flex-1 overflow-y-auto p-4 space-y-4">
                            <Form.Item
                                name="channelId"
                                label={<span className="text-xs font-medium">目标渠道</span>}
                                rules={[{ required: true, message: "请选择要调试的渠道" }]}
                                className="!mb-3"
                            >
                                <Select
                                    placeholder="选择渠道"
                                    onChange={handleChannelChange}
                                    loading={channelsQuery.isLoading}
                                    className="w-full"
                                    options={activeChannels.map((c) => ({
                                        value: c.id,
                                        label: (
                                            <div className="flex items-center justify-between">
                                                <span className="font-medium truncate">{c.name}</span>
                                                <span className="text-xs text-stone-400 font-mono uppercase ml-2">{c.protocol}</span>
                                            </div>
                                        ),
                                    }))}
                                />
                            </Form.Item>

                            {selectedChannel ? (
                                <div className="rounded-lg bg-stone-50 p-2.5 text-xs text-stone-600 dark:bg-stone-900/40 dark:text-stone-400 border border-stone-200/60 dark:border-stone-800 space-y-1">
                                    <div className="flex items-start justify-between gap-2">
                                        <span className="text-stone-400 shrink-0">地址:</span>
                                        <span className="font-mono text-stone-800 dark:text-stone-200 truncate text-right" title={selectedChannel.baseUrl}>
                                            {selectedChannel.baseUrl}
                                        </span>
                                    </div>
                                    <div className="flex justify-between text-[11px] text-stone-400">
                                        <span>超时: {selectedChannel.timeoutMs} ms</span>
                                        <span>并发: {selectedChannel.maxConcurrency}</span>
                                    </div>
                                </div>
                            ) : null}

                            <Form.Item
                                name="model"
                                label={<span className="text-xs font-medium">上游模型 (Model ID)</span>}
                                rules={[{ required: true, message: "请输入模型标识" }]}
                                className="!mb-3"
                            >
                                <Input placeholder="例如：gpt-4o-mini 或 gemini-1.5-flash" />
                            </Form.Item>

                            {selectedChannel ? (() => {
                                const list = [
                                    selectedChannel.lastAttempt?.upstreamModel,
                                    ...(selectedChannel.upstreamModels || []),
                                    selectedChannel.protocol === "openai" ? "gpt-4o-mini" : "gemini-1.5-flash",
                                    selectedChannel.protocol === "openai" ? "gpt-4o" : "gemini-1.5-pro",
                                ].filter((m): m is string => Boolean(m));
                                const unique = Array.from(new Set(list));
                                return (
                                    <div className="-mt-1 flex flex-wrap gap-1.5 items-center">
                                        <span className="text-stone-400 text-[11px] shrink-0">快捷选择:</span>
                                        {unique.slice(0, 5).map((m) => (
                                            <Tag
                                                key={m}
                                                className="cursor-pointer font-mono text-[10px] hover:border-blue-500 transition-colors"
                                                onClick={() => form.setFieldsValue({ model: m })}
                                            >
                                                {m}
                                            </Tag>
                                        ))}
                                    </div>
                                );
                            })() : null}

                            <Form.Item name="capability" label={<span className="text-xs font-medium">能力类型</span>} className="!mb-3">
                                <Radio.Group buttonStyle="solid" size="small" className="w-full grid grid-cols-2 text-center">
                                    <Radio.Button value="text">文本对话 (text)</Radio.Button>
                                    <Radio.Button value="image">图像生成 (image)</Radio.Button>
                                </Radio.Group>
                            </Form.Item>

                            <Form.Item
                                name="prompt"
                                label={<span className="text-xs font-medium">测试提示词 (Prompt)</span>}
                                rules={[{ required: true, message: "请输入提示词" }]}
                                className="!mb-3"
                            >
                                <Input.TextArea
                                    rows={4}
                                    placeholder="输入测试提示词... (支持 Ctrl+Enter 快捷发送)"
                                    onKeyDown={(e) => {
                                        if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
                                            e.preventDefault();
                                            form.submit();
                                        }
                                    }}
                                />
                            </Form.Item>

                            <div className="grid grid-cols-2 gap-3 pt-1">
                                <Form.Item name="temperature" label={<span className="text-[11px] text-stone-500">Temperature</span>} className="!mb-0">
                                    <InputNumber min={0} max={2} step={0.1} className="!w-full" size="small" />
                                </Form.Item>
                                <Form.Item name="maxTokens" label={<span className="text-[11px] text-stone-500">Max Tokens</span>} className="!mb-0">
                                    <InputNumber min={1} max={8192} step={128} className="!w-full" size="small" placeholder="默认" />
                                </Form.Item>
                            </div>
                        </div>

                        <div className="border-t border-stone-200 p-4 dark:border-stone-800 bg-stone-50/50 dark:bg-stone-900/20">
                            <Button
                                type="primary"
                                htmlType="submit"
                                icon={<Play className="size-4" />}
                                loading={testMutation.isPending}
                                className="w-full !h-9 font-medium"
                            >
                                发送测试请求
                            </Button>
                        </div>
                    </Form>
                </div>

                {/* 右侧结果交互主面板 */}
                <div className="flex flex-col h-full overflow-hidden rounded-xl border border-stone-200 bg-background lg:col-span-7 xl:col-span-8 dark:border-stone-800 shadow-sm">
                    <div className="border-b border-stone-200 px-5 py-3 dark:border-stone-800 flex items-center justify-between shrink-0">
                        <div className="flex items-center gap-2">
                            <Sparkles className="size-4 text-emerald-500" />
                            <span className="text-sm font-semibold text-stone-900 dark:text-stone-100">响应结果</span>
                        </div>
                        {result ? (
                            <span className="font-mono text-xs text-stone-400">
                                耗时: <strong className="text-stone-700 dark:text-stone-200">{result.durationMs}ms</strong>
                            </span>
                        ) : null}
                    </div>

                    <div className="flex-1 overflow-y-auto p-5 space-y-4">
                        {testMutation.isPending ? (
                            <div className="flex h-full min-h-[360px] flex-col items-center justify-center text-stone-400 space-y-3">
                                <Zap className="size-10 animate-bounce text-blue-500" />
                                <div className="text-sm font-medium text-stone-700 dark:text-stone-300">正在与上游建立连接并发送测试...</div>
                                <div className="text-xs text-stone-400">正在测量真实网络往返与上游处理延迟</div>
                            </div>
                        ) : result ? (
                            <div className="space-y-4">
                                {/* 状态指标头 */}
                                <div className={`flex flex-wrap items-center justify-between gap-3 rounded-xl border p-4 ${
                                    result.ok
                                        ? "border-emerald-200 bg-emerald-50/50 dark:border-emerald-900/50 dark:bg-emerald-950/20"
                                        : "border-rose-200 bg-rose-50/50 dark:border-rose-900/50 dark:bg-rose-950/20"
                                }`}>
                                    <div className="flex items-center gap-2.5">
                                        {result.ok ? (
                                            <>
                                                <CheckCircle2 className="size-5 text-emerald-600 dark:text-emerald-400" />
                                                <div>
                                                    <div className="text-sm font-semibold text-emerald-900 dark:text-emerald-200">HTTP 200 OK · 连通正常</div>
                                                    <div className="text-xs text-emerald-700 dark:text-emerald-400">上游渠道认证成功并返回有效结果</div>
                                                </div>
                                            </>
                                        ) : (
                                            <>
                                                <XCircle className="size-5 text-rose-600 dark:text-rose-400" />
                                                <div>
                                                    <div className="text-sm font-semibold text-rose-900 dark:text-rose-200">请求异常 · {result.category || "调用失败"}</div>
                                                    <div className="text-xs text-rose-700 dark:text-rose-400">请检查渠道 Base URL、API Key 或模型名称</div>
                                                </div>
                                            </>
                                        )}
                                    </div>
                                    <div className="flex flex-wrap items-center gap-4 text-xs font-mono">
                                        <div className="flex items-center gap-1.5 text-stone-600 dark:text-stone-300">
                                            <Clock className="size-3.5 text-stone-400" />
                                            <span>总耗时: <strong>{result.durationMs}ms</strong></span>
                                        </div>
                                        {result.firstTokenMs ? (
                                            <div className="text-stone-500">首字: {result.firstTokenMs}ms</div>
                                        ) : null}
                                        {result.outputTokens ? (
                                            <div className="text-stone-500">Tokens: {result.outputTokens}</div>
                                        ) : null}
                                    </div>
                                </div>

                                {/* 错误详情警告 */}
                                {!result.ok && result.error ? (
                                    <Alert
                                        type="error"
                                        showIcon
                                        message="上游报错信息"
                                        description={<pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap font-mono text-xs">{result.error}</pre>}
                                        className="rounded-lg"
                                    />
                                ) : null}

                                {/* 格式化正文展示 */}
                                {result.ok && result.text ? (
                                    <div className="rounded-xl border border-stone-200 bg-stone-50/40 p-4 dark:border-stone-800 dark:bg-stone-900/30">
                                        <div className="mb-2 flex items-center justify-between">
                                            <span className="text-xs font-semibold uppercase tracking-wider text-stone-500">文本输出 (Formatted Output)</span>
                                            <Button
                                                type="text"
                                                size="small"
                                                icon={<Copy className="size-3.5" />}
                                                onClick={() => {
                                                    void navigator.clipboard.writeText(result.text || "");
                                                    message.success("已复制响应文本");
                                                }}
                                                className="text-xs text-stone-500 hover:text-stone-900 dark:hover:text-stone-100"
                                            >
                                                复制内容
                                            </Button>
                                        </div>
                                        <div className="rounded-lg border border-stone-200 bg-white p-4 font-sans text-sm leading-relaxed text-stone-900 dark:border-stone-800 dark:bg-stone-950 dark:text-stone-100 whitespace-pre-wrap select-text">
                                            {result.text}
                                        </div>
                                    </div>
                                ) : null}

                                {/* 原始响应 JSON 折叠卡片 */}
                                <Collapse
                                    ghost
                                    className="border border-stone-200 rounded-xl dark:border-stone-800 bg-stone-50/30 dark:bg-stone-900/10"
                                    items={[
                                        {
                                            key: "raw",
                                            label: <span className="text-xs text-stone-500 font-medium">原始调试数据 (Raw JSON)</span>,
                                            extra: (
                                                <Button
                                                    type="text"
                                                    size="small"
                                                    icon={<Copy className="size-3" />}
                                                    onClick={(e) => {
                                                        e.stopPropagation();
                                                        void navigator.clipboard.writeText(JSON.stringify(result, null, 2));
                                                        message.success("已复制 JSON 数据");
                                                    }}
                                                >
                                                    复制 JSON
                                                </Button>
                                            ),
                                            children: (
                                                <pre className="max-h-72 overflow-auto rounded-lg border border-stone-200 bg-stone-900 p-3 font-mono text-[11px] text-stone-100 dark:border-stone-800">
                                                    {JSON.stringify(result, null, 2)}
                                                </pre>
                                            ),
                                        },
                                    ]}
                                />
                            </div>
                        ) : (
                            <div className="flex h-full min-h-[360px] flex-col items-center justify-center text-stone-400 space-y-3">
                                <TerminalSquare className="size-10 text-stone-300 dark:text-stone-700" />
                                <div className="text-sm font-medium text-stone-600 dark:text-stone-400">准备就绪</div>
                                <div className="text-xs text-stone-400 max-w-sm text-center">
                                    请在左侧选择需要调试的渠道与模型，输入提示词并点击「发送测试请求」
                                </div>
                            </div>
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
}

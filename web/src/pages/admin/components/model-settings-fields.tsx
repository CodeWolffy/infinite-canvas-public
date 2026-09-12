import { Form, InputNumber, Select, Switch } from "antd";

import type { ModelCapability } from "@/lib/model-capabilities";
import { modelReasoningEfforts, reasoningEffortLabel, type ModelReasoningEffort } from "@/lib/model-reasoning";
import type { ModelInput } from "@/services/api/admin-platform";

export type ModelSettingsValues = {
    capability: ModelCapability;
    pricePerImage?: string | number | null;
    tokenPricing?: boolean;
    inputPrice?: string;
    cachedPrice?: string | null;
    outputPrice?: string;
    perSecondPricing?: boolean;
    pricePerSecond?: string | null;
    maxOutputTokens?: number;
    reasoningEfforts?: ModelReasoningEffort[];
};

export function modelSettingsPayload(values: ModelSettingsValues, config: Record<string, unknown> = {}): Pick<ModelInput, "pricePerImage" | "inputPricePerMillion" | "cachedPricePerMillion" | "outputPricePerMillion" | "pricePerSecond" | "config"> {
    const tokenPricing = values.capability === "text" && values.tokenPricing;
    const secondPricing = (values.capability === "video" || values.capability === "audio") && values.perSecondPricing;
    return {
        pricePerImage: String(values.pricePerImage ?? "0"),
        inputPricePerMillion: tokenPricing ? values.inputPrice ?? "" : null,
        cachedPricePerMillion: tokenPricing ? values.cachedPrice ?? null : null,
        outputPricePerMillion: tokenPricing ? values.outputPrice ?? "" : null,
        pricePerSecond: secondPricing ? values.pricePerSecond ?? "" : null,
        config: { ...config, ...(values.capability === "text" ? { maxOutputTokens: values.maxOutputTokens, reasoningEfforts: values.reasoningEfforts || [] } : {}) },
    };
}

export default function ModelSettingsFields({ capability }: { capability: ModelCapability }) {
    return <>
        {capability === "text" ? <>
            <Form.Item name="maxOutputTokens" label="最大输出 token" extra="统一用于报价与生成，用户端不展示或修改；按模型实际能力填写。" rules={[{ required: true, message: "请配置该模型的最大输出 token 数" }]}><InputNumber min={1} precision={0} className="!w-full" /></Form.Item>
            <Form.Item name="reasoningEfforts" label="开放的思考强度" extra="只勾选模型与渠道实际支持的档位，留空时使用模型默认。"><Select mode="multiple" allowClear placeholder="仅使用模型默认" options={modelReasoningEfforts.map((value) => ({ value, label: `${reasoningEffortLabel(value)}（${value}）` }))} /></Form.Item>
            <Form.Item name="tokenPricing" label="计费模式" valuePropName="checked" extra="按 token 计费时，完成后按实际用量结算，多退少补。"><Switch checkedChildren="按 token" unCheckedChildren="按次" /></Form.Item>
        </> : null}
        {capability === "video" || capability === "audio" ? <Form.Item name="perSecondPricing" label="计费模式" valuePropName="checked" extra={capability === "audio" ? "按音频实际时长结算，先按 5 秒预估冻结。" : "按请求的视频秒数结算。"}><Switch checkedChildren="按秒" unCheckedChildren="按次" /></Form.Item> : null}
        <Form.Item noStyle shouldUpdate={(previous, current) => previous.tokenPricing !== current.tokenPricing || previous.perSecondPricing !== current.perSecondPricing}>{({ getFieldValue }) => {
            const tokenPricing = capability === "text" && getFieldValue("tokenPricing");
            const secondPricing = (capability === "video" || capability === "audio") && getFieldValue("perSecondPricing");
            return <>
                {tokenPricing ? <div className="grid gap-x-4 sm:grid-cols-2">
                    <Form.Item name="inputPrice" label="输入单价（元 / 百万 token）" rules={[{ required: true, message: "请输入输入单价" }]}><InputNumber<string> stringMode min="0" precision={6} className="!w-full" /></Form.Item>
                    <Form.Item name="outputPrice" label="输出单价（元 / 百万 token）" rules={[{ required: true, message: "请输入输出单价" }]}><InputNumber<string> stringMode min="0" precision={6} className="!w-full" /></Form.Item>
                    <Form.Item name="cachedPrice" label="缓存命中单价（元 / 百万 token）" extra="留空按输入单价，0 表示免费" className="sm:col-span-2"><InputNumber<string> stringMode min="0" precision={6} className="!w-full" /></Form.Item>
                </div> : null}
                {secondPricing ? <Form.Item name="pricePerSecond" label="每秒价格（元）" rules={[{ required: true, message: "请输入每秒价格" }]}><InputNumber<string> stringMode min="0" precision={6} className="!w-full" /></Form.Item> : null}
                <Form.Item name="pricePerImage" label={tokenPricing || secondPricing ? "最低预冻结金额（元）" : capability === "image" ? "每张价格（元）" : "每次价格（元）"} extra={tokenPricing || secondPricing ? "与用量预估取较大值冻结，最终按实际用量结算；可填 0。" : "每个成功结果计费，失败退回冻结余额。"}><InputNumber<string> stringMode min="0" precision={6} className="!w-full" /></Form.Item>
            </>;
        }}</Form.Item>
    </>;
}

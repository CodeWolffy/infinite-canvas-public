import { AudioLines, Image, MessageSquare, Video } from "lucide-react";

export const modelCapabilities = [
    { value: "image", label: "图片", icon: Image, description: "按张配置价格，独立管理图片生成渠道。" },
    { value: "text", label: "文本", icon: MessageSquare, description: "配置 token 计费、输出上限与可用思考强度。" },
    { value: "video", label: "视频", icon: Video, description: "按次或按秒配置价格，管理视频生成渠道。" },
    { value: "audio", label: "音频", icon: AudioLines, description: "按次或按秒配置价格，管理语音生成渠道。" },
] as const;

export type ModelCapability = typeof modelCapabilities[number]["value"];
export const capabilityLabel = (value: ModelCapability) => modelCapabilities.find((item) => item.value === value)!.label;

export const channelProtocolOptions = [
    { value: "openai", label: "OpenAI 兼容" },
    { value: "gemini", label: "Gemini" },
    { value: "anthropic", label: "Claude Messages" },
];

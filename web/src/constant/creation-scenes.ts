import type { CreationDraftInput } from "@/stores/use-creation-draft-store";

export type CreationScene = {
    id: "product" | "poster" | "character" | "storyboard";
    title: string;
    suitableFor: string;
    materials: string;
    outcome: string;
    keyword: string;
    example: CreationDraftInput;
};

export const creationScenes: CreationScene[] = [
    {
        id: "product",
        title: "商品主图",
        suitableFor: "电商陈列、新品展示、产品视觉提案",
        materials: "产品外观、品牌风格、背景要求；可在工作台添加实拍参考图",
        outcome: "一张突出产品轮廓与材质的主图",
        keyword: "商品",
        example: {
            capability: "image",
            prompt: "为一款琥珀色玻璃精华瓶制作商品主图。主体居中，瓶身轮廓清晰，标签位置留白，背景为温暖的米色，柔和的侧光呈现玻璃通透感与自然阴影。画面简洁，突出产品，不添加额外标志与文字。",
            settings: { size: "1:1" },
        },
    },
    {
        id: "poster",
        title: "海报",
        suitableFor: "活动宣传、社交媒体封面、品牌视觉",
        materials: "主题、主标题、风格、投放比例",
        outcome: "一张有明确视觉重点和信息留白的海报",
        keyword: "海报",
        example: {
            capability: "image",
            prompt: "设计一张「周末咖啡市集」主题的竖版海报。以手绘咖啡杯、烘焙面包和街角摊位构成主要画面，暖色调，轻松的城市周末氛围。主标题为「周末咖啡市集」，标题醒目，画面下方留出活动时间与地点的排版空间，信息层级清晰。",
            settings: { size: "3:4" },
        },
    },
    {
        id: "character",
        title: "角色设定",
        suitableFor: "故事角色、游戏概念、插画系列",
        materials: "人物身份、外形特征、服装与画风；可添加已有角色参考图",
        outcome: "可用于继续创作的角色外形与服装设定图",
        keyword: "角色",
        example: {
            capability: "image",
            prompt: "绘制一位年轻的森林巡护员角色设定图：短发、雀斑、深绿色外套、皮质挎包与旧地图，气质安静坚定。用清晰的正面、侧面与背面视图呈现同一人物，保持脸部、发型、体型和服装细节一致。平整留白背景，细腻的绘本插画风格，不添加文字。",
            settings: { size: "3:2" },
        },
    },
    {
        id: "storyboard",
        title: "分镜",
        suitableFor: "短片构思、广告脚本、视频制作前的镜头规划",
        materials: "故事梗概、人物关系、场景与目标时长",
        outcome: "可继续整理进画布并生成镜头画面的分镜脚本",
        keyword: "分镜",
        example: {
            capability: "text",
            prompt: "为一支约30秒的城市短片编写6个镜头的分镜脚本。故事：下班后的年轻人走进雨后的街道，在一家亮着暖灯的咖啡店与老朋友重逢。整体克制、温暖，镜头之间有连贯的空间和动作。请用表格列出镜头编号、景别、画面与人物动作、运镜、时长、声音，以及可单独用于生成画面的中文提示词。",
        },
    },
];

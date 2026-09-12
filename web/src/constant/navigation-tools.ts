import { FileText, ImagePlus, Images, Maximize2, MessageSquare, Sparkles } from "lucide-react";

export const navigationTools = [
    { slug: "studio", icon: Sparkles },
    { slug: "text", icon: MessageSquare },
    {
        slug: "canvas",
        icon: Maximize2,
    },
    {
        slug: "image",
        icon: ImagePlus,
    },
    {
        slug: "prompts",
        icon: FileText,
    },
    {
        slug: "assets",
        icon: Images,
    },
] as const;

export type NavigationToolSlug = (typeof navigationTools)[number]["slug"];

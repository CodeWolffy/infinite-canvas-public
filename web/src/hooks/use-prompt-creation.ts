import { useNavigate } from "react-router-dom";

import type { Prompt } from "@/services/api/prompts";
import { useCreationDraftStore } from "@/stores/use-creation-draft-store";

export function usePromptCreation() {
    const navigate = useNavigate();
    const setDraft = useCreationDraftStore((state) => state.setDraft);

    return (prompt: Prompt) => {
        setDraft({
            capability: "image",
            prompt: prompt.prompt,
            modelName: prompt.imageModel,
            sourceTitle: prompt.title,
            settings: {
                ...(prompt.imageSize ? { size: prompt.imageSize } : {}),
                ...(Number.isInteger(prompt.imageCount) && Number(prompt.imageCount) > 0 ? { count: String(prompt.imageCount) } : {}),
            },
        });
        navigate("/image");
    };
}

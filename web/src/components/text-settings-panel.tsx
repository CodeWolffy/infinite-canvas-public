import { type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { ImageSettingsTheme } from "@/components/image-settings-panel";
import { type CanvasTheme } from "@/lib/canvas-theme";
import { modelReasoningOptions, resolveReasoningEffort } from "@/lib/model-reasoning";
import { findChannelModel, type AiConfig } from "@/stores/use-config-store";

type TextSettingsPanelProps = {
    config: AiConfig;
    onConfigChange: (changes: Partial<Pick<AiConfig, "reasoningEffort">>) => void;
    theme: CanvasTheme;
    className?: string;
};

export function TextSettingsPanel({ config, onConfigChange, theme, className = "space-y-4" }: TextSettingsPanelProps) {
    const { t } = useTranslation();
    const model = findChannelModel(config, config.model || config.textModel)?.model;
    const effort = resolveReasoningEffort(model, config.reasoningEffort);
    return (
        <ImageSettingsTheme theme={theme}>
            <div className={className} style={{ color: theme.node.text }} onMouseDown={(event) => event.stopPropagation()}>
                <div className="text-lg font-semibold">{t("settingsPanels.text.title")}</div>
                <div className="space-y-2.5">
                    <div className="text-sm font-medium" style={{ color: theme.node.muted }}>
                        {t("settingsPanels.text.reasoning")}
                    </div>
                    <div className="grid grid-cols-4 gap-2">
                        {modelReasoningOptions(model).map(({ value, label }) => (
                            <OptionPill key={value} selected={effort === value} theme={theme} onClick={() => onConfigChange({ reasoningEffort: value })}>
                                {label}
                            </OptionPill>
                        ))}
                    </div>
                </div>
            </div>
        </ImageSettingsTheme>
    );
}

function OptionPill({ selected, theme, onClick, children }: { selected: boolean; theme: CanvasTheme; onClick: () => void; children: ReactNode }) {
    return (
        <button
            type="button"
            className="h-9 cursor-pointer rounded-full border px-2 text-sm transition hover:opacity-80"
            style={{ background: "transparent", borderColor: selected ? theme.node.text : theme.node.stroke, color: theme.node.text }}
            onMouseDown={(event) => event.stopPropagation()}
            onClick={onClick}
        >
            {children}
        </button>
    );
}

import { useEffect, useId, useMemo, useState } from "react";
import { ChevronDown, Cpu } from "lucide-react";
import { Select } from "antd";
import { useTranslation } from "react-i18next";

import i18n from "@/i18n";
import { cn } from "@/lib/utils";
import { findChannelModel, modelOptionLabel, modelOptionName, modelOptionPrice, selectableModelsByCapability, type AiConfig, type ModelCapability } from "@/stores/use-config-store";

type ModelPickerProps = {
    config: AiConfig;
    value?: string;
    onChange: (model: string) => void;
    capability?: ModelCapability;
    className?: string;
    fullWidth?: boolean;
    placeholder?: string;
    unavailableLabel?: string;
    onMissingConfig?: () => void;
};

export function ModelPicker({ config, value, onChange, capability, className, fullWidth = false, placeholder, unavailableLabel, onMissingConfig }: ModelPickerProps) {
    const { t } = useTranslation();
    const pickerId = useId();
    const [open, setOpen] = useState(false);
    const options = useMemo(() => selectableModelsByCapability(config, capability).map((value) => {
        const model = findChannelModel(config, value)?.model;
        return { value, label: modelOptionLabel(config, value), name: model?.modelName || model?.name || value, description: model?.description, price: modelOptionPrice(config, value) };
    }), [capability, config]);
    const selected = options.find((option) => option.value === value || modelOptionName(option.value) === value);
    const current = selected?.value || value || "";
    const unavailable = Boolean(current && !selected);
    const currentPrice = current ? modelOptionPrice(config, current) : null;
    const pickerPlaceholder = placeholder || t("settingsPanels.model.select");
    const currentTitle = current ? `${modelOptionLabel(config, current)}${currentPrice ? ` · ${currentPrice}` : ""}` : pickerPlaceholder;

    useEffect(() => {
        const closeOtherPicker = (event: Event) => {
            if ((event as CustomEvent<string>).detail !== pickerId) setOpen(false);
        };
        window.addEventListener("model-picker-open", closeOtherPicker);
        return () => window.removeEventListener("model-picker-open", closeOtherPicker);
    }, [pickerId]);

    return (
        <Select
            aria-label={pickerPlaceholder}
            title={currentTitle}
            className={cn("canvas-composer-model-picker !h-8 max-w-full text-sm", fullWidth ? "w-full min-w-0" : "min-w-[9rem]", className)}
            open={open}
            value={current || undefined}
            onOpenChange={(nextOpen) => {
                if (nextOpen && !options.length) onMissingConfig?.();
                if (nextOpen) window.dispatchEvent(new CustomEvent("model-picker-open", { detail: pickerId }));
                setOpen(nextOpen);
            }}
            onChange={onChange}
            onMouseDown={(event) => event.stopPropagation()}
            onPointerDown={(event) => event.stopPropagation()}
            prefix={<ModelIcon config={config} model={current} />}
            suffixIcon={<ChevronDown className="canvas-select-chevron size-3" />}
            placeholder={pickerPlaceholder}
            status={unavailable ? unavailableLabel ? "warning" : "error" : undefined}
            showSearch={{ filterOption: (input, option) => `${option?.label || ""} ${option?.name || ""}`.toLowerCase().includes(input.toLowerCase()) }}
            popupMatchSelectWidth={false}
            styles={{ popup: { root: { zIndex: 1200, minWidth: "20rem", maxWidth: "calc(100vw - 24px)" } } }}
            options={options}
            notFoundContent={options.length ? "没有匹配的模型" : emptyModelLabel(config, capability)}
            labelRender={(option) => <span className="canvas-model-picker-text min-w-0 truncate">{unavailable ? unavailableLabel || "已选模型不可用" : option.label}</span>}
            optionRender={(option) => <div className="max-w-96 space-y-1 py-1"><div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1"><span className="flex min-w-0 items-center gap-2"><ModelIcon config={config} model={option.data.value} /><span className="truncate">{option.data.label}</span></span>{option.data.price ? <span className="text-xs tabular-nums text-muted-foreground">{option.data.price}</span> : null}</div>{option.data.description ? <p className="whitespace-normal text-xs leading-5 text-muted-foreground">{option.data.description}</p> : null}</div>}
        />
    );
}

function emptyModelLabel(config: AiConfig, capability?: ModelCapability) {
    const label = capability ? i18n.t(`settingsPanels.model.capabilities.${capability}`) : "";
    if (capability && config.models.length) return i18n.t("settingsPanels.model.assign", { capability: label });
    return config.models.length ? i18n.t("settingsPanels.model.noMatch", { capability: label }) : i18n.t("settingsPanels.model.addFirst");
}

function ModelIcon({ config, model }: { config: AiConfig; model: string }) {
    const icon = resolveModelIcon(`${findChannelModel(config, model)?.model.modelName || modelOptionName(model)} ${modelOptionLabel(config, model)}`);
    return icon ? <img src={icon} alt="" className="size-4 shrink-0 dark:invert" /> : <Cpu className="size-4 shrink-0 opacity-70" />;
}

function resolveModelIcon(model: string) {
    const name = model.toLowerCase();
    if (name.includes("claude") || name.includes("anthropic")) return "/icons/claude.svg";
    if (name.includes("gemini") || name.includes("google") || name.includes("banana") || name.includes("imagen")) return "/icons/gemini.svg";
    if (name.includes("gpt") || name.includes("openai")) return "/icons/openai.svg";
    if (name.includes("grok") || name.includes("grok")) return "/icons/grok.svg";
    if (name.includes("deepseek") || name.includes("deepseek")) return "/icons/deepseek.svg";
    if (name.includes("glm") || name.includes("glm")) return "/icons/glm.svg";
    return "";
}

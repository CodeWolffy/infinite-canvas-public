import { useEffect } from "react";
import { useLocation } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, App, Form, InputNumber, Modal, Radio, Select, Spin, Switch } from "antd";
import { useTranslation } from "react-i18next";

import { videoResolutionOptions } from "@/components/video-settings-panel";
import { computeMediaSize, computeVideoSize, inferMediaRatio, inferMediaScale, inferVideoRatio, mediaScaleOptions, parseVideoResolution } from "@/lib/media-size";
import { getGenerationPreferences, updateGenerationPreferences } from "@/services/api/generation";
import { useConfigStore, type AiConfig } from "@/stores/use-config-store";
import { assertCurrentSession, useUserStore } from "@/stores/use-user-store";

type PreferenceValues = Pick<AiConfig, "vquality" | "nodeRegenerateBehavior" | "autoFocusOnSelect"> & { imageResolution: string; canvasImageCount: number };

export default function GenerationPreferencesModal({ onClose }: { onClose: () => void }) {
    const { t } = useTranslation();
    const { message } = App.useApp();
    const { pathname } = useLocation();
    const sessionVersion = useUserStore((state) => state.sessionVersion);
    const config = useConfigStore((state) => state.config);
    const updateConfig = useConfigStore((state) => state.updateConfig);
    const [form] = Form.useForm<PreferenceValues>();
    const queryClient = useQueryClient();
    const preferences = useQuery({ queryKey: ["generation-preferences", sessionVersion], queryFn: getGenerationPreferences });

    useEffect(() => {
        if (!preferences.data) return;
        const current = useConfigStore.getState().config;
        const saved = preferences.data;
        form.setFieldsValue({
            imageResolution: inferMediaScale(typeof saved.size === "string" ? saved.size : current.size),
            vquality: parseVideoResolution(typeof saved.vquality === "string" ? saved.vquality : current.vquality),
            canvasImageCount: Number(saved.canvasImageCount || current.canvasImageCount),
            nodeRegenerateBehavior: saved.nodeRegenerateBehavior === "overwrite" ? "overwrite" : "new-node",
            autoFocusOnSelect: saved.autoFocusOnSelect === true,
        });
    }, [form, preferences.data]);

    const save = useMutation({
        mutationFn: async (values: PreferenceValues) => {
            assertCurrentSession(sessionVersion);
            const ratio = inferMediaRatio(typeof preferences.data?.size === "string" ? preferences.data.size : config.size);
            const videoRatio = inferVideoRatio(typeof preferences.data?.videoSize === "string" ? preferences.data.videoSize : "16:9");
            const saved = await updateGenerationPreferences({
                size: computeMediaSize(values.imageResolution, ratio === "auto" ? "1:1" : ratio),
                videoSize: computeVideoSize(values.vquality, videoRatio),
                vquality: values.vquality,
                canvasImageCount: String(values.canvasImageCount),
                nodeRegenerateBehavior: values.nodeRegenerateBehavior,
                autoFocusOnSelect: values.autoFocusOnSelect,
            });
            assertCurrentSession(sessionVersion);
            return saved;
        },
        onSuccess: (saved, values) => {
            if (useUserStore.getState().sessionVersion !== sessionVersion) return;
            queryClient.setQueryData(["generation-preferences", sessionVersion], saved);
            updateConfig("size", String(pathname === "/video" ? saved.videoSize : saved.size));
            updateConfig("vquality", values.vquality);
            updateConfig("canvasImageCount", String(values.canvasImageCount));
            updateConfig("nodeRegenerateBehavior", values.nodeRegenerateBehavior);
            updateConfig("autoFocusOnSelect", values.autoFocusOnSelect);
            message.success(t("config.preferences.saved"));
            onClose();
        },
        onError: (error: Error) => {
            if (useUserStore.getState().sessionVersion === sessionVersion) message.error(error.message);
        },
    });

    return (
        <Modal open title={t("config.preferences.generation")} width={520} centered onCancel={onClose} onOk={() => form.submit()} okText={t("common.save")} confirmLoading={save.isPending} okButtonProps={{ disabled: !preferences.data || save.isPending }}>
            {preferences.error ? <Alert type="error" showIcon title={preferences.error.message} className="mb-4" /> : null}
            <Spin spinning={preferences.isPending}>
                <Form form={form} layout="vertical" disabled={!preferences.data || save.isPending} onFinish={(values) => save.mutate(values)}>
                    <div className="grid grid-cols-2 gap-x-4">
                        <Form.Item name="imageResolution" label={t("config.preferences.imageResolution")}>
                            <Select options={mediaScaleOptions.map((value) => ({ value, label: value === "auto" ? t("settingsPanels.common.auto") : value.toUpperCase() }))} />
                        </Form.Item>
                        <Form.Item name="vquality" label={t("config.preferences.videoResolution")}>
                            <Select options={videoResolutionOptions} />
                        </Form.Item>
                    </div>
                    <Form.Item name="canvasImageCount" label={t("config.preferences.canvasImageCount")} extra={t("config.preferences.canvasImageCountDescription")} rules={[{ required: true }]}>
                        <InputNumber min={1} max={15} precision={0} className="!w-full" />
                    </Form.Item>
                    <Form.Item name="nodeRegenerateBehavior" label={t("config.preferences.regenerateBehavior")}>
                        <Radio.Group className="flex flex-col gap-3">
                            <Radio value="overwrite">
                                <span className="block text-sm font-medium">{t("config.preferences.regenerateBehaviorOverwrite")}</span>
                                <span className="mt-0.5 block text-xs opacity-60">{t("config.preferences.regenerateBehaviorOverwriteDescription")}</span>
                            </Radio>
                            <Radio value="new-node">
                                <span className="block text-sm font-medium">{t("config.preferences.regenerateBehaviorNewNode")}</span>
                                <span className="mt-0.5 block text-xs opacity-60">{t("config.preferences.regenerateBehaviorNewNodeDescription")}</span>
                            </Radio>
                        </Radio.Group>
                    </Form.Item>
                    <Form.Item label={t("config.preferences.autoFocusOnSelect")} name="autoFocusOnSelect" valuePropName="checked" className="mb-0">
                        <Switch />
                    </Form.Item>
                </Form>
            </Spin>
        </Modal>
    );
}

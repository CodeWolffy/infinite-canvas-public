import { useEffect, useState } from "react";
import { App, Empty, Modal, Spin } from "antd";
import { LayoutTemplate } from "lucide-react";
import { useTranslation } from "react-i18next";

import { applyCanvasTemplate, listCanvasTemplates, type CanvasTemplate } from "@/services/api/canvas-templates";
import type { CanvasProjectDetail } from "@/services/api/canvas-projects";

/** 画布库的「从模板创建」弹窗：浏览管理员维护的模板并一键生成新画布。 */
export function TemplatePickerModal({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (project: CanvasProjectDetail) => void }) {
    const { message } = App.useApp();
    const { t } = useTranslation();
    const [templates, setTemplates] = useState<CanvasTemplate[]>([]);
    const [loading, setLoading] = useState(false);
    const [usingId, setUsingId] = useState("");

    useEffect(() => {
        if (!open) return;
        setLoading(true);
        listCanvasTemplates()
            .then(setTemplates)
            .catch((error) => message.error(error instanceof Error ? error.message : t("templates.loadFailed")))
            .finally(() => setLoading(false));
    }, [open, message, t]);

    const use = async (tpl: CanvasTemplate) => {
        if (usingId) return;
        setUsingId(tpl.id);
        try {
            const project = await applyCanvasTemplate(tpl.id);
            onCreated(project);
        } catch (error) {
            message.error(error instanceof Error ? error.message : t("templates.useFailed"));
        } finally {
            setUsingId("");
        }
    };

    return (
        <Modal title={t("templates.pickTitle")} open={open} onCancel={onClose} footer={null} width={720} destroyOnHidden>
            {loading ? (
                <div className="flex min-h-40 items-center justify-center">
                    <Spin />
                </div>
            ) : !templates.length ? (
                <Empty description={t("templates.empty")} className="py-10" />
            ) : (
                <div className="grid max-h-[60dvh] gap-3 overflow-auto pt-1 sm:grid-cols-2">
                    {templates.map((tpl) => (
                        <button key={tpl.id} type="button" disabled={Boolean(usingId)} onClick={() => void use(tpl)} className="flex items-start gap-3 rounded-xl border border-stone-200 p-4 text-left transition hover:border-stone-400 hover:bg-black/5 disabled:opacity-60 dark:border-stone-800 dark:hover:bg-white/10">
                            <LayoutTemplate className="mt-0.5 size-5 shrink-0 text-stone-500" />
                            <span className="min-w-0">
                                <span className="block truncate text-sm font-medium">{tpl.title}</span>
                                {tpl.description ? <span className="mt-1 line-clamp-2 block text-xs text-stone-500">{tpl.description}</span> : null}
                                <span className="mt-2 block text-xs text-stone-400">{t("canvas.project.stats", { nodes: tpl.nodeCount, connections: tpl.connectionCount })}{usingId === tpl.id ? ` · ${t("templates.using")}` : ""}</span>
                            </span>
                        </button>
                    ))}
                </div>
            )}
        </Modal>
    );
}

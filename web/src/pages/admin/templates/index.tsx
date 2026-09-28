import { useCallback, useEffect, useState } from "react";
import { App, Button, Form, Input, Modal, Popconfirm, Select, Table, Typography } from "antd";
import { PencilLine, Plus, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";

import { createCanvasTemplate, deleteCanvasTemplate, listAdminCanvasTemplates, updateCanvasTemplate, type CanvasTemplate } from "@/services/api/canvas-templates";
import { listCanvasProjects } from "@/services/api/canvas-projects";

/** 管理员维护画布模板：从自己的画布快照生成模板，普通用户在画布库一键套用。 */
export default function AdminTemplatesPage() {
    const { message } = App.useApp();
    const { t } = useTranslation();
    const [form] = Form.useForm<{ title: string; description?: string; projectId?: string }>();
    const [templates, setTemplates] = useState<CanvasTemplate[]>([]);
    const [loading, setLoading] = useState(true);
    const [modalOpen, setModalOpen] = useState(false);
    const [editing, setEditing] = useState<CanvasTemplate | null>(null);
    const [saving, setSaving] = useState(false);
    const [projects, setProjects] = useState<{ value: string; label: string }[]>([]);

    const reload = useCallback(async () => {
        setTemplates(await listAdminCanvasTemplates());
    }, []);
    useEffect(() => {
        setLoading(true);
        reload()
            .catch((error) => message.error(error instanceof Error ? error.message : t("templates.loadFailed")))
            .finally(() => setLoading(false));
    }, [reload, message, t]);

    const openCreate = async () => {
        setEditing(null);
        form.resetFields();
        setModalOpen(true);
        if (!projects.length) {
            try {
                const { projects: items } = await listCanvasProjects(0);
                setProjects(items.map((item) => ({ value: item.id, label: `${item.title}（${item.nodeCount} 节点）` })));
            } catch {
                setProjects([]);
            }
        }
    };
    const openEdit = (tpl: CanvasTemplate) => {
        setEditing(tpl);
        form.setFieldsValue({ title: tpl.title, description: tpl.description });
        setModalOpen(true);
    };
    const save = async () => {
        const values = await form.validateFields();
        setSaving(true);
        try {
            if (editing) await updateCanvasTemplate(editing.id, { title: values.title, description: values.description });
            else await createCanvasTemplate({ title: values.title, description: values.description, projectId: values.projectId! });
            await reload();
            setModalOpen(false);
            message.success(t("templates.saved"));
        } catch (error) {
            message.error(error instanceof Error ? error.message : t("templates.saveFailed"));
        } finally {
            setSaving(false);
        }
    };

    return (
        <div className="mx-auto flex max-w-5xl flex-col gap-5 px-6 py-8">
            <header className="flex items-center justify-between">
                <div>
                    <h1 className="text-2xl font-semibold">{t("templates.adminTitle")}</h1>
                    <p className="mt-1 text-sm text-stone-500">{t("templates.adminHint")}</p>
                </div>
                <Button type="primary" icon={<Plus className="size-4" />} onClick={() => void openCreate()}>
                    {t("templates.create")}
                </Button>
            </header>
            <Table<CanvasTemplate>
                rowKey="id"
                loading={loading}
                dataSource={templates}
                pagination={false}
                columns={[
                    { title: t("templates.name"), dataIndex: "title" },
                    { title: t("templates.description"), dataIndex: "description", render: (value: string) => value || "—" },
                    { title: t("templates.size"), width: 130, render: (_, tpl) => t("canvas.project.stats", { nodes: tpl.nodeCount, connections: tpl.connectionCount }) },
                    { title: t("templates.createdAt"), width: 150, render: (_, tpl) => new Date(tpl.createdAt).toLocaleDateString() },
                    {
                        title: "",
                        width: 100,
                        render: (_, tpl) => (
                            <div className="flex items-center gap-1">
                                <Button size="small" type="text" icon={<PencilLine className="size-4" />} aria-label={t("common.edit")} onClick={() => openEdit(tpl)} />
                                <Popconfirm title={t("templates.deleteConfirm")} okText={t("common.delete")} okButtonProps={{ danger: true }} onConfirm={() => void deleteCanvasTemplate(tpl.id).then(reload).then(() => message.success(t("templates.deleted"))).catch((error) => message.error(error instanceof Error ? error.message : t("templates.deleteFailed")))}>
                                    <Button size="small" type="text" danger icon={<Trash2 className="size-4" />} aria-label={t("common.delete")} />
                                </Popconfirm>
                            </div>
                        ),
                    },
                ]}
            />
            <Modal title={editing ? t("templates.edit") : t("templates.create")} open={modalOpen} onCancel={() => !saving && setModalOpen(false)} onOk={() => void save()} confirmLoading={saving} okText={t("common.save")} cancelText={t("common.cancel")} destroyOnHidden>
                <Form form={form} layout="vertical" className="pt-2">
                    <Form.Item name="title" label={t("templates.name")} rules={[{ required: true, message: t("templates.nameRequired") }]}>
                        <Input maxLength={200} />
                    </Form.Item>
                    <Form.Item name="description" label={t("templates.description")}>
                        <Input.TextArea rows={3} maxLength={500} />
                    </Form.Item>
                    {!editing ? (
                        <Form.Item name="projectId" label={t("templates.sourceProject")} rules={[{ required: true, message: t("templates.sourceRequired") }]} extra={<Typography.Text type="secondary" className="text-xs">{t("templates.sourceHint")}</Typography.Text>}>
                            <Select showSearch optionFilterProp="label" options={projects} placeholder={t("templates.sourcePlaceholder")} />
                        </Form.Item>
                    ) : null}
                </Form>
            </Modal>
        </div>
    );
}

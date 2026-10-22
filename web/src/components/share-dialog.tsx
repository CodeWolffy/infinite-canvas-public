import { useEffect, useState } from "react";
import { App, Button, Input, Modal, Space, Typography } from "antd";
import { Copy, Link2, Trash2 } from "lucide-react";
import dayjs from "dayjs";
import { useTranslation } from "react-i18next";

import { createShareLink, getShareLink, revokeShareLink, sharePageUrl, type ShareKind, type ShareLink } from "@/services/api/sharing";
import { useCopyText } from "@/hooks/use-copy-text";

/** 画布/素材通用的只读分享弹窗：仅资源所有者可创建或撤销链接。 */
export function ShareDialog({ kind, targetId, open, onClose }: { kind: ShareKind; targetId: string; open: boolean; onClose: () => void }) {
    const { message } = App.useApp();
    const { t } = useTranslation();
    const copyText = useCopyText();
    const [share, setShare] = useState<ShareLink | null>(null);
    const [loading, setLoading] = useState(false);
    const [creating, setCreating] = useState(false);
    const [revoking, setRevoking] = useState(false);

    useEffect(() => {
        if (!open) return;
        setLoading(true);
        getShareLink(kind, targetId)
            .then((result) => setShare(result.share))
            .catch((error) => message.error(error instanceof Error ? error.message : t("share.loadFailed")))
            .finally(() => setLoading(false));
    }, [open, kind, targetId, message, t]);

    const create = async () => {
        setCreating(true);
        try {
            setShare((await createShareLink(kind, targetId)).share);
        } catch (error) {
            message.error(error instanceof Error ? error.message : t("share.createFailed"));
        } finally {
            setCreating(false);
        }
    };
    const revoke = async () => {
        setRevoking(true);
        try {
            await revokeShareLink(kind, targetId);
            setShare(null);
            message.success(t("share.revoked"));
        } catch (error) {
            message.error(error instanceof Error ? error.message : t("share.revokeFailed"));
        } finally {
            setRevoking(false);
        }
    };
    const url = share ? sharePageUrl(share.token) : "";

    return (
        <Modal title={t("share.title")} open={open} onCancel={onClose} footer={null} width={480} destroyOnHidden>
            <div className="space-y-4 pt-2">
                <Typography.Text type="secondary" className="block text-sm">
                    {t(kind === "canvas" ? "share.canvasHint" : "share.assetHint")}
                </Typography.Text>
                {share ? (
                    <>
                        <Space.Compact style={{ width: "100%" }}>
                            <Input readOnly value={url} onFocus={(event) => event.target.select()} />
                            <Button icon={<Copy className="size-4" />} onClick={() => copyText(url, t("share.copied"))}>
                                {t("common.copy")}
                            </Button>
                        </Space.Compact>
                        <div className="flex items-center justify-between">
                            <Typography.Text type="secondary" className="text-xs">
                                {t("share.readOnly")}
                                {share.expiresAt ? ` · ${t("share.expiresAt", { date: dayjs(share.expiresAt).format("YYYY-MM-DD HH:mm") })}` : ""}
                            </Typography.Text>
                            <Button danger size="small" icon={<Trash2 className="size-3.5" />} loading={revoking} onClick={() => void revoke()}>
                                {t("share.revoke")}
                            </Button>
                        </div>
                    </>
                ) : (
                    <Button type="primary" icon={<Link2 className="size-4" />} loading={creating || loading} onClick={() => void create()} block>
                        {t("share.create")}
                    </Button>
                )}
            </div>
        </Modal>
    );
}

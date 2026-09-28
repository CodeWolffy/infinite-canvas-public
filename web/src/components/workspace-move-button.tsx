import { useState } from "react";
import { App, Dropdown } from "antd";
import { FolderInput } from "lucide-react";
import { useTranslation } from "react-i18next";

import { updateCanvasProject } from "@/services/api/canvas-projects";
import { updateAsset } from "@/services/api/assets";
import { listWorkspaces, type Workspace } from "@/services/api/workspaces";

type MoveTarget = { kind: "canvas" | "asset"; id: string; workspaceId?: string | null };

/** 把画布/素材移入工作区（或移回个人空间）；仅资源所有者可见，目标工作区要求编辑者及以上。 */
export function WorkspaceMoveButton({ target, onMoved }: { target: MoveTarget; onMoved?: (workspaceId: string | null, workspaceName: string | null) => void }) {
    const { message } = App.useApp();
    const { t } = useTranslation();
    const [targets, setTargets] = useState<Workspace[]>([]);
    const loadTargets = async () => {
        try {
            setTargets((await listWorkspaces()).filter((item) => item.myRole === "owner" || item.myRole === "editor"));
        } catch {
            setTargets([]);
        }
    };
    const move = async (workspaceId: string | null) => {
        try {
            const record = target.kind === "canvas" ? await updateCanvasProject(target.id, { workspaceId }) : await updateAsset(target.id, { workspaceId });
            message.success(t("workspace.moved"));
            onMoved?.(record.workspaceId || null, record.workspaceName || null);
        } catch (error) {
            message.error(error instanceof Error ? error.message : t("workspace.moveFailed"));
        }
    };
    return (
        <Dropdown
            trigger={["click"]}
            onOpenChange={(open) => open && void loadTargets()}
            menu={{
                items: [
                    { key: "personal", label: t("workspace.personal"), disabled: !target.workspaceId, onClick: () => void move(null) },
                    { type: "divider" },
                    ...targets.map((item) => ({
                        key: item.id,
                        label: item.name + (target.workspaceId === item.id ? ` · ${t("workspace.current")}` : ""),
                        disabled: target.workspaceId === item.id,
                        onClick: () => void move(item.id),
                    })),
                ],
            }}
        >
            <button type="button" className="grid size-7 place-items-center rounded-full transition hover:bg-black/5 dark:hover:bg-white/10" aria-label={t("workspace.moveTo")} title={t("workspace.moveTo")} onClick={(event) => event.stopPropagation()}>
                <FolderInput className="size-4" />
            </button>
        </Dropdown>
    );
}

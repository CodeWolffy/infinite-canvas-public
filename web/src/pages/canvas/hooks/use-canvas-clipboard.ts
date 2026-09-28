import { useCallback, useRef, type Dispatch, type DragEvent as ReactDragEvent, type MutableRefObject, type SetStateAction } from "react";
import { useTranslation } from "react-i18next";
import { App } from "antd";

import { uploadImage } from "@/services/image-storage";
import { createCanvasNode, imageMetadata } from "@/lib/canvas/canvas-node-factory";
import { fitNodeSize } from "@/lib/canvas/canvas-node-size";
import { useUserStore } from "@/stores/use-user-store";
import { CanvasNodeType, type CanvasConnection, type CanvasNodeData, type ContextMenuState, type Position } from "@/types/canvas";

export type CanvasClipboard = {
    nodes: CanvasNodeData[];
    connections: CanvasConnection[];
};

const CANVAS_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);

export const isSupportedCanvasImage = (file: File) => CANVAS_IMAGE_TYPES.has(file.type);

type CanvasClipboardParams = {
    canEdit: () => boolean;
    nodesRef: MutableRefObject<CanvasNodeData[]>;
    connectionsRef: MutableRefObject<CanvasConnection[]>;
    selectedNodeIdsRef: MutableRefObject<Set<string>>;
    getCanvasCenter: () => Position;
    screenToCanvas: (clientX: number, clientY: number) => Position;
    setNodes: Dispatch<SetStateAction<CanvasNodeData[]>>;
    setConnections: Dispatch<SetStateAction<CanvasConnection[]>>;
    setSelectedNodeIds: Dispatch<SetStateAction<Set<string>>>;
    setSelectedConnectionId: Dispatch<SetStateAction<string | null>>;
    setContextMenu: Dispatch<SetStateAction<ContextMenuState | null>>;
    setDialogNodeId: Dispatch<SetStateAction<string | null>>;
};

/**
 * 画布剪贴板与文件导入：复制/粘贴节点、读取系统剪贴板、把拖入或粘贴的图片落成节点。
 */
export function useCanvasClipboard({ canEdit, nodesRef, connectionsRef, selectedNodeIdsRef, getCanvasCenter, screenToCanvas, setNodes, setConnections, setSelectedNodeIds, setSelectedConnectionId, setContextMenu, setDialogNodeId }: CanvasClipboardParams) {
    const { message } = App.useApp();
    const { t } = useTranslation();
    const clipboardRef = useRef<CanvasClipboard | null>(null);

    const copySelectedNodes = useCallback(() => {
        const selectedIds = selectedNodeIdsRef.current;
        if (!selectedIds.size) return;

        const copiedNodes = nodesRef.current
            .filter((node) => selectedIds.has(node.id))
            .map((node) => ({
                ...node,
                position: { ...node.position },
                metadata: node.metadata ? { ...node.metadata } : undefined,
            }));

        if (!copiedNodes.length) return;

        clipboardRef.current = {
            nodes: copiedNodes,
            connections: connectionsRef.current.filter((connection) => selectedIds.has(connection.fromNodeId) && selectedIds.has(connection.toNodeId)).map((connection) => ({ ...connection })),
        };
    }, [connectionsRef, nodesRef, selectedNodeIdsRef]);

    const pasteCopiedNodes = useCallback(() => {
        if (!canEdit()) return true;
        const clipboard = clipboardRef.current;
        if (!clipboard?.nodes.length) return false;

        const center = getCanvasCenter();
        const bounds = clipboard.nodes.reduce(
            (acc, node) => ({
                left: Math.min(acc.left, node.position.x),
                top: Math.min(acc.top, node.position.y),
                right: Math.max(acc.right, node.position.x + node.width),
                bottom: Math.max(acc.bottom, node.position.y + node.height),
            }),
            { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity },
        );
        const dx = center.x - (bounds.left + bounds.right) / 2;
        const dy = center.y - (bounds.top + bounds.bottom) / 2;
        const idMap = new Map<string, string>();
        const nextNodes = clipboard.nodes.map((node, index) => {
            const id = `${node.type}-${Date.now()}-${index}-${Math.random().toString(36).slice(2, 7)}`;
            idMap.set(node.id, id);
            return {
                ...node,
                id,
                title: node.title.endsWith(" Copy") ? node.title : `${node.title} Copy`,
                position: {
                    x: node.position.x + dx,
                    y: node.position.y + dy,
                },
                metadata: node.metadata ? { ...node.metadata } : undefined,
            };
        });

        const pastedNodes = nextNodes.map((node) => {
            const groupId = node.metadata?.groupId;
            if (!groupId) return node;
            return { ...node, metadata: { ...node.metadata, groupId: idMap.get(groupId) } };
        });

        const nextConnections = clipboard.connections.flatMap((connection, index) => {
            const fromNodeId = idMap.get(connection.fromNodeId);
            const toNodeId = idMap.get(connection.toNodeId);
            if (!fromNodeId || !toNodeId) return [];
            return [
                {
                    ...connection,
                    id: `conn-${Date.now()}-${index}-${Math.random().toString(36).slice(2, 7)}`,
                    fromNodeId,
                    toNodeId,
                },
            ];
        });

        setNodes((prev) => [...prev, ...pastedNodes]);
        setConnections((prev) => [...prev, ...nextConnections]);
        setSelectedNodeIds(new Set(pastedNodes.map((node) => node.id)));
        setSelectedConnectionId(null);
        setContextMenu(null);
        setDialogNodeId(pastedNodes[0]?.type === CanvasNodeType.Group ? null : pastedNodes[0]?.id || null);
        return true;
    }, [canEdit, getCanvasCenter, setConnections, setContextMenu, setDialogNodeId, setNodes, setSelectedConnectionId, setSelectedNodeIds]);

    const createImageFileNode = useCallback(async (file: File, position: Position, sessionVersion = useUserStore.getState().sessionVersion) => {
        if (!canEdit() || useUserStore.getState().sessionVersion !== sessionVersion) return;
        const image = await uploadImage(file);
        if (!canEdit() || useUserStore.getState().sessionVersion !== sessionVersion) return;
        const size = fitNodeSize(image.width, image.height);
        const id = `image-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        const newNode: CanvasNodeData = {
            id,
            type: CanvasNodeType.Image,
            title: file.name,
            position: { x: position.x - size.width / 2, y: position.y - size.height / 2 },
            width: size.width,
            height: size.height,
            metadata: imageMetadata(image),
        };

        if (!canEdit() || useUserStore.getState().sessionVersion !== sessionVersion) return;
        setNodes((prev) => [...prev, newNode]);
        setSelectedNodeIds(new Set([id]));
        setSelectedConnectionId(null);
        setDialogNodeId(id);
    }, [canEdit, setDialogNodeId, setNodes, setSelectedConnectionId, setSelectedNodeIds]);

    const createTextNodeFromClipboard = useCallback(
        (text: string) => {
            if (!canEdit()) return false;
            const trimmed = text.trim();
            if (!trimmed) return false;

            const node = {
                ...createCanvasNode(CanvasNodeType.Text, getCanvasCenter(), { content: trimmed, status: "success" }),
                title: trimmed.slice(0, 32) || t("canvas.projectPage.clipboardText"),
            };

            setNodes((prev) => [...prev, node]);
            setSelectedNodeIds(new Set([node.id]));
            setSelectedConnectionId(null);
            setContextMenu(null);
            setDialogNodeId(node.id);
            return true;
        },
        [canEdit, getCanvasCenter, setContextMenu, setDialogNodeId, setNodes, setSelectedConnectionId, setSelectedNodeIds, t],
    );

    const pasteSystemClipboard = useCallback(async () => {
        if (!navigator.clipboard || !canEdit()) return;
        const sessionVersion = useUserStore.getState().sessionVersion;
        const items = await navigator.clipboard.read();
        if (useUserStore.getState().sessionVersion !== sessionVersion) return;
        const imageItem = items.find((item) => item.types.some((type) => type.startsWith("image/")));
        if (imageItem) {
            const imageType = imageItem.types.find((type) => type.startsWith("image/"));
            if (!imageType) return;
            const blob = await imageItem.getType(imageType);
            if (useUserStore.getState().sessionVersion !== sessionVersion) return;
            const file = new File([blob], "clipboard-image.png", { type: imageType });
            if (!canEdit()) return;
            await createImageFileNode(file, getCanvasCenter(), sessionVersion);
            if (!canEdit() || useUserStore.getState().sessionVersion !== sessionVersion) return;
            message.success(t("canvas.projectPage.clipboardImageAdded"));
            return;
        }

        const text = await navigator.clipboard.readText();
        if (!canEdit() || useUserStore.getState().sessionVersion !== sessionVersion) return;
        if (createTextNodeFromClipboard(text)) message.success(t("canvas.projectPage.clipboardTextAdded"));
    }, [canEdit, createImageFileNode, createTextNodeFromClipboard, getCanvasCenter, message, t]);

    const handleDrop = useCallback(
        (event: ReactDragEvent<HTMLDivElement>) => {
            event.preventDefault();
            if (!canEdit()) return;
            const sessionVersion = useUserStore.getState().sessionVersion;
            const files = Array.from(event.dataTransfer.files).filter(isSupportedCanvasImage);
            if (!files.length) return;

            const basePos = screenToCanvas(event.clientX, event.clientY);
            const STAGGER = 40;
            for (let i = 0; i < files.length; i++) {
                const pos = { x: basePos.x + i * STAGGER, y: basePos.y + i * STAGGER };
                const f = files[i];
                void createImageFileNode(f, pos, sessionVersion);
            }
        },
        [canEdit, createImageFileNode, screenToCanvas],
    );

    return { copySelectedNodes, pasteCopiedNodes, pasteSystemClipboard, createImageFileNode, handleDrop };
}

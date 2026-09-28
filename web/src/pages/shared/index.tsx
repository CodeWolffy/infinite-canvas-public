import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { Spin, Tag, Typography } from "antd";
import { Eye } from "lucide-react";
import { useTranslation } from "react-i18next";

import { getSharedResource, sharedMediaUrl, type SharedResource } from "@/services/api/sharing";
import { InfiniteCanvas } from "@/components/canvas/infinite-canvas";
import { ConnectionPath } from "@/components/canvas/canvas-connections";
import { canvasThemes, type CanvasBackgroundMode } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";
import type { CanvasConnection, CanvasNodeData, CanvasNodeImage, CanvasNodeText, ViewportTransform } from "@/types/canvas";

const MEDIA_URL = /\/api\/media\/([0-9a-fA-F-]{36})/;

/** 分享快照里的媒体地址统一改走分享通道，匿名访客没有 /api/media 登录态。 */
function sharedUrl(token: string, value?: string | null): string {
    if (!value) return "";
    const match = value.match(MEDIA_URL);
    if (match) return sharedMediaUrl(token, match[1]);
    const keyed = value.match(/^(?:image|media):([0-9a-fA-F-]{36})$/);
    if (keyed) return sharedMediaUrl(token, keyed[1]);
    return value;
}

export default function SharedPage() {
    const { token = "" } = useParams();
    const { t } = useTranslation();
    const [resource, setResource] = useState<SharedResource | null>(null);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        let cancelled = false;
        getSharedResource(token)
            .then((result) => !cancelled && setResource(result))
            .catch((err) => !cancelled && setError(err instanceof Error ? err.message : "分享链接不可用"));
        return () => {
            cancelled = true;
        };
    }, [token]);

    return (
        <div className="flex h-dvh flex-col bg-background text-foreground">
            <header className="flex h-14 shrink-0 items-center gap-3 border-b border-stone-200 px-4 dark:border-stone-800">
                <Link to="/" className="flex items-center gap-2 text-sm font-semibold">
                    <span className="size-5 shrink-0 bg-current" style={{ mask: "url(/logo.svg) center / contain no-repeat", WebkitMask: "url(/logo.svg) center / contain no-repeat" }} />
                </Link>
                <span className="min-w-0 flex-1 truncate text-sm font-medium">
                    {resource?.kind === "canvas" ? resource.canvas.title : resource?.kind === "asset" ? resource.asset.title : t("share.loading")}
                </span>
                {resource ? (
                    <Typography.Text type="secondary" className="hidden text-xs sm:block">
                        {t("share.sharedBy", { name: (resource.kind === "canvas" ? resource.canvas.ownerName : resource.asset.ownerName) || t("share.anonymous") })}
                    </Typography.Text>
                ) : null}
                <Tag icon={<Eye className="size-3" />} className="m-0">
                    {t("share.readOnly")}
                </Tag>
            </header>
            <main className="min-h-0 flex-1">
                {error ? (
                    <div className="flex h-full flex-col items-center justify-center gap-3">
                        <Typography.Title level={4} className="!mb-0">
                            {t("share.unavailable")}
                        </Typography.Title>
                        <Typography.Text type="secondary">{error}</Typography.Text>
                    </div>
                ) : !resource ? (
                    <div className="flex h-full items-center justify-center">
                        <Spin />
                    </div>
                ) : resource.kind === "canvas" ? (
                    <SharedCanvasView token={token} snapshot={resource.canvas.snapshot} />
                ) : (
                    <SharedAssetView token={token} asset={resource.asset} />
                )}
            </main>
        </div>
    );
}

type SharedSnapshot = { nodes?: CanvasNodeData[]; connections?: CanvasConnection[]; viewport?: ViewportTransform; backgroundMode?: CanvasBackgroundMode };

function SharedCanvasView({ token, snapshot }: { token: string; snapshot: unknown }) {
    const parsed = (snapshot && typeof snapshot === "object" ? snapshot : {}) as SharedSnapshot;
    const nodes = useMemo(() => (Array.isArray(parsed.nodes) ? parsed.nodes : []), [parsed]);
    const connections = useMemo(() => (Array.isArray(parsed.connections) ? parsed.connections : []), [parsed]);
    const containerRef = useRef<HTMLDivElement>(null);
    const [viewport, setViewport] = useState<ViewportTransform>(() => initialViewport(nodes, parsed.viewport));
    const nodeById = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes]);
    const visibleConnections = connections.flatMap((connection) => {
        const from = nodeById.get(connection.fromNodeId);
        const to = nodeById.get(connection.toNodeId);
        return from && to ? [{ connection, from, to }] : [];
    });
    return (
        <InfiniteCanvas containerRef={containerRef} viewport={viewport} tool="pan" backgroundMode={parsed.backgroundMode || "lines"} onViewportChange={setViewport}>
            <svg className="absolute left-0 top-0 h-[10000px] w-[10000px] overflow-visible" style={{ pointerEvents: "none", zIndex: 0 }}>
                {visibleConnections.map(({ connection, from, to }) => (
                    <ConnectionPath key={connection.id} connection={connection} from={from} to={to} active={false} onSelect={() => {}} />
                ))}
            </svg>
            {nodes.map((node) => (
                <SharedNode key={node.id} token={token} node={node} />
            ))}
        </InfiniteCanvas>
    );
}

/** 初始视口优先用快照保存的视角，否则按节点包围盒居中。 */
function initialViewport(nodes: CanvasNodeData[], saved?: ViewportTransform): ViewportTransform {
    if (saved && typeof saved.x === "number" && typeof saved.y === "number" && typeof saved.k === "number") return saved;
    if (!nodes.length) return { x: 80, y: 60, k: 0.8 };
    const box = nodes.reduce(
        (acc, node) => ({
            minX: Math.min(acc.minX, node.position.x),
            minY: Math.min(acc.minY, node.position.y),
            maxX: Math.max(acc.maxX, node.position.x + node.width),
            maxY: Math.max(acc.maxY, node.position.y + node.height),
        }),
        { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity },
    );
    const k = Math.min(1, Math.max(0.1, Math.min(window.innerWidth / (box.maxX - box.minX + 200), (window.innerHeight - 100) / (box.maxY - box.minY + 200))));
    return { x: (window.innerWidth - (box.maxX - box.minX) * k) / 2 - box.minX * k, y: (window.innerHeight - 100 - (box.maxY - box.minY) * k) / 2 - box.minY * k, k };
}

function SharedNode({ token, node }: { token: string; node: CanvasNodeData }) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const meta = node.metadata || {};
    return (
        <div className="absolute flex flex-col overflow-hidden rounded-xl" style={{ left: node.position.x, top: node.position.y, width: node.width, height: node.height, background: theme.node.panel, border: `1px solid ${theme.node.stroke}` }}>
            <div className="flex h-7 shrink-0 items-center px-2.5 text-xs font-medium" style={{ color: theme.node.muted }}>
                <span className="truncate">{node.title}</span>
            </div>
            <div className="min-h-0 flex-1">
                <SharedNodeContent token={token} node={node} meta={meta} />
            </div>
        </div>
    );
}

function SharedNodeContent({ token, node, meta }: { token: string; node: CanvasNodeData; meta: NonNullable<CanvasNodeData["metadata"]> }) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    if (node.type === "image") {
        const images = Array.isArray(meta.images) ? (meta.images as CanvasNodeImage[]) : [];
        const primary = images.find((item) => item.id === meta.primaryImageId) || images[0];
        const url = primary ? sharedUrl(token, primary.storageKey || primary.content) : sharedUrl(token, meta.storageKey || meta.content);
        return url ? <img src={url} alt={node.title} className="h-full w-full object-contain" draggable={false} /> : <EmptyNode />;
    }
    if (node.type === "video") {
        const url = sharedUrl(token, meta.storageKey || meta.content);
        return url ? <video src={url} controls className="h-full w-full object-contain" /> : <EmptyNode />;
    }
    if (node.type === "audio") {
        const url = sharedUrl(token, meta.storageKey || meta.content);
        return url ? <div className="flex h-full items-center justify-center p-3"><audio src={url} controls className="w-full" /></div> : <EmptyNode />;
    }
    if (node.type === "text") {
        const texts = Array.isArray(meta.texts) ? (meta.texts as CanvasNodeText[]) : [];
        const primary = texts.find((item) => item.id === meta.primaryTextId) || texts[texts.length - 1];
        const content = meta.content || primary?.content || "";
        return <div className="h-full overflow-auto whitespace-pre-wrap p-3" style={{ color: theme.node.text, fontSize: meta.fontSize || 14 }}>{content}</div>;
    }
    if (node.type === "config") {
        return (
            <div className="space-y-1 p-3 text-xs" style={{ color: theme.node.muted }}>
                {meta.prompt ? <div className="line-clamp-6 whitespace-pre-wrap">{meta.prompt}</div> : null}
                <div>{[meta.model, meta.size, meta.count ? `${meta.count} 张` : ""].filter(Boolean).join(" · ")}</div>
            </div>
        );
    }
    // 组节点与插件节点只保留标题容器，不执行插件代码。
    return <div className="h-full" style={{ background: `${theme.node.fill}55` }} />;
}

function EmptyNode() {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    return <div className="flex h-full items-center justify-center text-xs" style={{ color: theme.node.faint }}>—</div>;
}

function SharedAssetView({ token, asset }: { token: string; asset: Extract<SharedResource, { kind: "asset" }>["asset"] }) {
    const { t } = useTranslation();
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const url = asset.mediaId ? sharedMediaUrl(token, asset.mediaId) : "";
    const tags = Array.isArray(asset.metadata?.tags) ? (asset.metadata.tags as string[]) : [];
    return (
        <div className="mx-auto flex h-full max-w-4xl flex-col gap-5 overflow-auto px-6 py-8">
            <div className="flex flex-wrap items-center gap-2">
                <Tag>{t(`assets.kinds.${asset.type}`)}</Tag>
                {tags.map((tag) => (
                    <Tag key={tag}>{tag}</Tag>
                ))}
            </div>
            <div className="overflow-hidden rounded-xl" style={{ border: `1px solid ${theme.node.stroke}`, background: theme.node.panel }}>
                {asset.type === "image" && url ? <img src={url} alt={asset.title} className="max-h-[70dvh] w-full object-contain" /> : null}
                {asset.type === "video" && url ? <video src={url} controls className="max-h-[70dvh] w-full bg-black" /> : null}
                {asset.type === "audio" && url ? <div className="p-6"><audio src={url} controls className="w-full" /></div> : null}
                {asset.type === "text" ? <pre className="whitespace-pre-wrap p-6 text-sm" style={{ color: theme.node.text }}>{asset.content}</pre> : null}
            </div>
            {typeof asset.metadata?.note === "string" && asset.metadata.note ? <Typography.Paragraph type="secondary">{asset.metadata.note}</Typography.Paragraph> : null}
        </div>
    );
}

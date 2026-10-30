import { useEffect, useRef, useState } from "react";
import { App, Button, Empty, Input, Modal, Spin } from "antd";
import { LayoutTemplate } from "lucide-react";
import { useTranslation } from "react-i18next";

import { applyCanvasTemplate, listCanvasTemplatePage, type CanvasTemplate } from "@/services/api/canvas-templates";
import type { CanvasProjectDetail } from "@/services/api/canvas-projects";
import { assertCurrentSession, useUserStore } from "@/stores/use-user-store";

/** 浏览真实画布模板，关键词在服务端全部模板中筛选，再按原有分页加载。 */
export function TemplatePickerModal({ open, onClose, onCreated, initialKeyword = "" }: { open: boolean; onClose: () => void; onCreated: (project: CanvasProjectDetail) => void; initialKeyword?: string }) {
    const { message } = App.useApp();
    const { t } = useTranslation();
    const sessionVersion = useUserStore((state) => state.sessionVersion);
    const requestVersion = useRef(0);
    const [templates, setTemplates] = useState<CanvasTemplate[]>([]);
    const [total, setTotal] = useState(0);
    const [keyword, setKeyword] = useState(initialKeyword);
    const [query, setQuery] = useState(initialKeyword);
    const [loading, setLoading] = useState(false);
    const [loadingMore, setLoadingMore] = useState(false);
    const [usingId, setUsingId] = useState("");
    const [loadError, setLoadError] = useState("");
    const [retry, setRetry] = useState(0);

    useEffect(() => {
        if (open) { setKeyword(initialKeyword); setQuery(initialKeyword); }
        setUsingId("");
    }, [initialKeyword, open, sessionVersion]);
    useEffect(() => {
        if (!open) return;
        const version = ++requestVersion.current;
        setTemplates([]);
        setTotal(0);
        setLoading(true);
        setLoadError("");
        setLoadingMore(false);
        void listCanvasTemplatePage(0, query)
            .then((data) => { if (version === requestVersion.current && useUserStore.getState().sessionVersion === sessionVersion) { setTemplates(data.templates); setTotal(data.total); } })
            .catch((error: unknown) => { if (version === requestVersion.current && useUserStore.getState().sessionVersion === sessionVersion) setLoadError(error instanceof Error ? error.message : t("templates.loadFailed")); })
            .finally(() => { if (version === requestVersion.current && useUserStore.getState().sessionVersion === sessionVersion) setLoading(false); });
        return () => { requestVersion.current += 1; };
    }, [open, query, retry, sessionVersion, t]);

    const loadMore = async () => {
        if (loadingMore || loading) return;
        const sessionVersion = useUserStore.getState().sessionVersion;
        const version = requestVersion.current;
        setLoadingMore(true);
        try {
            const data = await listCanvasTemplatePage(templates.length, query);
            assertCurrentSession(sessionVersion);
            if (version !== requestVersion.current) return;
            setTemplates((current) => [...new Map([...current, ...data.templates].map((item) => [item.id, item])).values()]);
            setTotal(data.total);
        } catch (error) {
            if (version === requestVersion.current && useUserStore.getState().sessionVersion === sessionVersion) message.error(error instanceof Error ? error.message : t("templates.loadFailed"));
        } finally {
            if (version === requestVersion.current && useUserStore.getState().sessionVersion === sessionVersion) setLoadingMore(false);
        }
    };
    const use = async (tpl: CanvasTemplate) => {
        if (usingId) return;
        const sessionVersion = useUserStore.getState().sessionVersion;
        const version = requestVersion.current;
        setUsingId(tpl.id);
        try {
            const project = await applyCanvasTemplate(tpl.id);
            assertCurrentSession(sessionVersion);
            if (version === requestVersion.current) onCreated(project);
        } catch (error) {
            if (version === requestVersion.current && useUserStore.getState().sessionVersion === sessionVersion) message.error(error instanceof Error ? error.message : t("templates.useFailed"));
        } finally {
            if (version === requestVersion.current && useUserStore.getState().sessionVersion === sessionVersion) setUsingId("");
        }
    };

    return (
        <Modal title={t("templates.pickTitle")} open={open} onCancel={onClose} footer={null} width={720} destroyOnHidden>
            <Input.Search aria-label="搜索画布模板" placeholder="按模板标题或用途搜索" value={keyword} disabled={Boolean(usingId)} allowClear onChange={(event) => { setKeyword(event.target.value); if (!event.target.value) setQuery(""); }} onSearch={(value) => setQuery(value.trim())} className="mb-3" />
            {loading ? <div className="flex min-h-40 items-center justify-center"><Spin /></div> : loadError ? <Empty description={loadError} className="py-10"><Button onClick={() => setRetry((value) => value + 1)}>重新加载</Button></Empty> : !templates.length ? <Empty description={query ? "暂无匹配的画布模板" : t("templates.empty")} className="py-10">{query ? <Button type="text" onClick={() => { setKeyword(""); setQuery(""); }}>查看全部模板</Button> : null}</Empty> : <>
                <p className="mb-3 text-xs text-muted-foreground">{query ? "匹配" : "共"} {total} 个模板 · 已显示 {templates.length} 个</p>
                <div className="grid max-h-[60dvh] gap-3 overflow-auto pt-1 sm:grid-cols-2">
                    {templates.map((tpl) => <button key={tpl.id} type="button" disabled={Boolean(usingId)} onClick={() => void use(tpl)} className="flex cursor-pointer items-start gap-3 rounded-xl border border-border p-4 text-left transition hover:bg-muted/25 disabled:opacity-60">
                        <LayoutTemplate className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
                        <span className="min-w-0"><span className="block truncate text-sm font-medium">{tpl.title}</span>{tpl.description ? <span className="mt-1 line-clamp-2 block text-xs text-muted-foreground">{tpl.description}</span> : null}<span className="mt-2 block text-xs text-muted-foreground">{t("canvas.project.stats", { nodes: tpl.nodeCount, connections: tpl.connectionCount })}{usingId === tpl.id ? ` · ${t("templates.using")}` : ""}</span></span>
                    </button>)}
                </div>
                {templates.length < total ? <div className="mt-4 text-center"><Button type="text" loading={loadingMore} disabled={Boolean(usingId)} onClick={() => void loadMore()}>加载更多模板</Button></div> : null}
            </>}
        </Modal>
    );
}

import { lazy, Suspense, useLayoutEffect, useState, type ReactNode } from "react";

import { AppTopNav } from "@/components/layout/app-top-nav";
import { useCanvasStore } from "@/stores/canvas/use-canvas-store";
import { useAgentStore } from "@/stores/use-agent-store";
import { useAssetStore } from "@/stores/use-asset-store";
import { useConfigStore } from "@/stores/use-config-store";
import { useUserStore } from "@/stores/use-user-store";

// Agent 面板只在用户真正使用本地 Agent 时才需要，独立 chunk 避免它的 Markdown 渲染链进入首屏。
const AgentPanel = lazy(() => import("@/components/agent/agent-panel").then((module) => ({ default: module.AgentPanel })));

function hasAgentBootstrapInHash() {
    return typeof window !== "undefined" && window.location.hash.includes("agent=");
}

export default function UserLayout({ children }: { children: ReactNode }) {
    const hydrateProjects = useCanvasStore((state) => state.hydrateProjects);
    const hydrateAssets = useAssetStore((state) => state.hydrateAssets);
    const hydratePlatformModels = useConfigStore((state) => state.hydratePlatformModels);
    const hydratePreferences = useConfigStore((state) => state.hydratePreferences);
    const userId = useUserStore((state) => state.user?.id || "");
    const agentPanelOpen = useAgentStore((state) => state.panelOpen);
    const agentEnabled = useAgentStore((state) => state.enabled);
    const agentToken = useAgentStore((state) => state.token);
    // SSE 连接由面板内部持有，因此已配置过 Agent 的用户和带 agent 参数的链接必须保持原有挂载时机。
    const [agentPanelUsed, setAgentPanelUsed] = useState(hasAgentBootstrapInHash);

    useLayoutEffect(() => {
        if (userId) void Promise.all([hydrateProjects(userId), hydrateAssets(userId), hydratePlatformModels(), hydratePreferences()]).catch(() => undefined);
    }, [hydrateAssets, hydratePlatformModels, hydratePreferences, hydrateProjects, userId]);

    useLayoutEffect(() => {
        if (agentPanelOpen) setAgentPanelUsed(true);
    }, [agentPanelOpen]);

    // 同一次会话内通过 #agent= 链接唤起面板时同样需要挂载。
    useLayoutEffect(() => {
        const syncHash = () => {
            if (hasAgentBootstrapInHash()) setAgentPanelUsed(true);
        };
        window.addEventListener("hashchange", syncHash);
        return () => window.removeEventListener("hashchange", syncHash);
    }, []);

    return (
        <div className="flex h-dvh overflow-hidden bg-background text-foreground">
            <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
                <AppTopNav />
                <div className="min-h-0 flex-1 overflow-hidden">{children}</div>
            </div>
            {agentPanelUsed || agentPanelOpen || agentEnabled || agentToken.trim() !== "" ? (
                <Suspense fallback={null}>
                    <AgentPanel />
                </Suspense>
            ) : null}
        </div>
    );
}

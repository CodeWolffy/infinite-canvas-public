import { useLayoutEffect, type ReactNode } from "react";

import { AgentPanel } from "@/components/agent/agent-panel";
import { AppTopNav } from "@/components/layout/app-top-nav";
import { useCanvasStore } from "@/stores/canvas/use-canvas-store";
import { useAssetStore } from "@/stores/use-asset-store";
import { useConfigStore } from "@/stores/use-config-store";
import { useUserStore } from "@/stores/use-user-store";

export default function UserLayout({ children }: { children: ReactNode }) {
    const hydrateProjects = useCanvasStore((state) => state.hydrateProjects);
    const hydrateAssets = useAssetStore((state) => state.hydrateAssets);
    const hydratePlatformModels = useConfigStore((state) => state.hydratePlatformModels);
    const userId = useUserStore((state) => state.user?.id || "");

    useLayoutEffect(() => {
        if (userId) void Promise.all([hydrateProjects(userId), hydrateAssets(userId), hydratePlatformModels()]).catch(() => undefined);
    }, [hydrateAssets, hydratePlatformModels, hydrateProjects, userId]);

    return (
        <div className="flex h-dvh overflow-hidden bg-background text-foreground">
            <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
                <AppTopNav />
                <div className="min-h-0 flex-1 overflow-hidden">{children}</div>
            </div>
            <AgentPanel />
        </div>
    );
}

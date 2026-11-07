import { useEffect } from "react";
import { watchCanvas } from "@/services/api/canvas-realtime";
import { useCanvasStore } from "@/stores/canvas/use-canvas-store";
import { useCanvasCollaborationStore } from "@/stores/canvas/use-canvas-collaboration-store";
import { useUserStore } from "@/stores/use-user-store";

export function useCanvasCollaboration(projectId: string, ready: boolean) {
    const session = useUserStore((state) => state.sessionVersion);
    useEffect(() => {
        if (!ready) return;
        useCanvasCollaborationStore.setState({ projectId, status: "connecting", members: [], remoteUpdatedAt: null });
        return watchCanvas(projectId, {
            snapshot: (project) => {
                const previous = useCanvasStore.getState().projects.find((item) => item.id === projectId)?.revision;
                useCanvasStore.getState().acceptRemoteProject(project);
                if (previous !== undefined && project.revision > previous) useCanvasCollaborationStore.setState({ remoteUpdatedAt: project.updatedAt });
            },
            presence: (members) => useCanvasCollaborationStore.setState({ members }),
            status: (status) => useCanvasCollaborationStore.setState({ status }),
            unavailable: () => useCanvasStore.getState().suspendProjectAccess(projectId),
        });
    }, [projectId, ready, session]);
}

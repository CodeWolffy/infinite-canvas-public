import { create } from "zustand";
import type { CanvasConnectionStatus, CanvasOnlineMember } from "@/services/api/canvas-realtime";
import { useUserStore } from "@/stores/use-user-store";

type Collaboration = { projectId: string; status: CanvasConnectionStatus; members: CanvasOnlineMember[]; remoteUpdatedAt: string | null };
const empty: Collaboration = { projectId: "", status: "connecting", members: [], remoteUpdatedAt: null };
export const useCanvasCollaborationStore = create<Collaboration>(() => empty);
useUserStore.subscribe((state, previous) => { if (state.sessionVersion !== previous.sessionVersion) useCanvasCollaborationStore.setState(empty); });

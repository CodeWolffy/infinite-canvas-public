import { useCallback } from "react";
import { useLocation } from "react-router-dom";

import type { InsertAssetPayload } from "@/components/canvas/asset-picker-modal";
import { useCanvasHandoffStore } from "@/stores/canvas/use-canvas-handoff-store";

export function useAddToCanvas() {
    const { key } = useLocation();
    return useCallback((items: InsertAssetPayload[]) => useCanvasHandoffStore.getState().open(items, key), [key]);
}

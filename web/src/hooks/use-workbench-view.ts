import { useRef, useState } from "react";

export function useWorkbenchView(initialView: "create" | "results") {
    const [view, setView] = useState(initialView);
    const interactionRef = useRef(0);
    const markInteraction = () => { ++interactionRef.current; };
    const selectView = (next: "create" | "results") => { markInteraction(); setView(next); };
    const captureResultView = () => {
        const interaction = interactionRef.current;
        return () => { if (interaction === interactionRef.current) selectView("results"); };
    };
    return { view, selectView, markInteraction, captureResultView };
}

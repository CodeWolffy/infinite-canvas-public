import { useEffect, useLayoutEffect, useRef } from "react";

export type CanvasShortcutActions = {
    undo: () => void;
    redo: () => void;
    selectAll: () => void;
    /** 返回是否执行了成组；未成组时不做 preventDefault，保留浏览器默认行为。 */
    group: () => boolean;
    /** 返回是否执行了解组；未解组时不做 preventDefault，保留浏览器默认行为。 */
    ungroup: () => boolean;
    copy: () => void;
    /** 返回是否从画布剪贴板粘贴；为 false 时回退到系统剪贴板。 */
    paste: () => boolean;
    pasteSystem: () => void;
    deleteSelection: () => void;
    escape: () => void;
};

/**
 * 画布全局键盘快捷键：撤销重做、全选、成组/解组、复制粘贴、删除与 Escape。
 * actions 由 useRef 持有最新值，keydown 监听只注册一次。
 */
export function useCanvasShortcuts(actions: CanvasShortcutActions) {
    const actionsRef = useRef(actions);
    useLayoutEffect(() => {
        actionsRef.current = actions;
    });

    useEffect(() => {
        const handleKeyDown = (event: KeyboardEvent) => {
            const current = actionsRef.current;
            const target = event.target instanceof Element ? event.target : null;
            if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLSelectElement || target?.closest("[contenteditable='true'],[data-canvas-no-zoom],[data-canvas-shortcuts-ignore],.ant-modal,.ant-drawer,.ant-select-dropdown,.ant-popover,.ant-dropdown")) return;

            const key = event.key.toLowerCase();
            const isModifierShortcut = event.metaKey || event.ctrlKey;

            if (isModifierShortcut && key === "c" && window.getSelection()?.toString()) return;

            if (isModifierShortcut && !event.altKey && key === "z") {
                event.preventDefault();
                if (event.shiftKey) current.redo();
                else current.undo();
                return;
            }

            if (isModifierShortcut && !event.altKey && key === "y") {
                event.preventDefault();
                current.redo();
                return;
            }

            if (isModifierShortcut && !event.altKey && key === "a") {
                event.preventDefault();
                current.selectAll();
                return;
            }

            if (isModifierShortcut && !event.altKey && key === "g") {
                if (event.shiftKey) {
                    if (current.ungroup()) event.preventDefault();
                    return;
                }
                if (current.group()) event.preventDefault();
                return;
            }

            if (isModifierShortcut && !event.altKey && key === "c") {
                event.preventDefault();
                current.copy();
                return;
            }

            if (isModifierShortcut && !event.altKey && key === "v") {
                event.preventDefault();
                if (!current.paste()) current.pasteSystem();
                return;
            }

            if (event.key === "Delete" || event.key === "Backspace") {
                current.deleteSelection();
            }

            if (event.key === "Escape") {
                current.escape();
            }
        };

        window.addEventListener("keydown", handleKeyDown);
        return () => window.removeEventListener("keydown", handleKeyDown);
    }, []);
}

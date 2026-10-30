import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";

import { useCanvasShortcuts, type CanvasShortcutActions } from "@/pages/canvas/hooks/use-canvas-shortcuts";

afterEach(cleanup);

function Surface({ actions, overlay }: { actions: CanvasShortcutActions; overlay?: string }) {
    useCanvasShortcuts(actions);
    return <div className={overlay}><button>当前操作区域</button></div>;
}

function shortcutActions(): CanvasShortcutActions {
    return { undo: vi.fn(), redo: vi.fn(), selectAll: vi.fn(), group: vi.fn(() => true), ungroup: vi.fn(() => true), copy: vi.fn(), paste: vi.fn(() => true), pasteSystem: vi.fn(), deleteSelection: vi.fn(), escape: vi.fn() };
}

test.each(["ant-modal", "ant-drawer", "ant-select-dropdown"])("操作 %s 时不触发背后画布的删除、撤销或粘贴", (overlay) => {
    const actions = shortcutActions();
    render(<Surface actions={actions} overlay={overlay} />);
    const target = screen.getByRole("button");
    fireEvent.keyDown(target, { key: "Delete" });
    fireEvent.keyDown(target, { key: "z", ctrlKey: true });
    fireEvent.keyDown(target, { key: "v", ctrlKey: true });
    expect(actions.deleteSelection).not.toHaveBeenCalled();
    expect(actions.undo).not.toHaveBeenCalled();
    expect(actions.paste).not.toHaveBeenCalled();
});

test("焦点回到画布后仍可使用原有快捷键", () => {
    const actions = shortcutActions();
    render(<Surface actions={actions} />);
    fireEvent.keyDown(screen.getByRole("button"), { key: "Delete" });
    fireEvent.keyDown(screen.getByRole("button"), { key: "z", ctrlKey: true });
    expect(actions.deleteSelection).toHaveBeenCalledOnce();
    expect(actions.undo).toHaveBeenCalledOnce();
});

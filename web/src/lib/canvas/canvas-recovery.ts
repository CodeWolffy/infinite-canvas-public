import localforage from "localforage";
import { nanoid } from "nanoid";
import type { CanvasProject } from "@/stores/canvas/use-canvas-store";

export type CanvasRecoverySnapshot = Pick<CanvasProject, "nodes" | "connections" | "chatSessions" | "activeChatId" | "backgroundMode" | "showImageInfo" | "viewport">;
export type CanvasRecovery = {
    key: string;
    writerId: string;
    version: number;
    userId: string;
    projectId: string;
    baseRevision: number;
    savedAt: string;
    title: string;
    snapshot?: CanvasRecoverySnapshot;
    supersededKeys?: string[];
};

const storage = localforage.createInstance({ name: "infinite-canvas", storeName: "canvas_recovery" });
const persisted = new Map<string, CanvasRecovery>();
let version = 0;

export function createCanvasRecovery(input: Omit<CanvasRecovery, "key" | "writerId" | "version" | "savedAt">, previous?: CanvasRecovery): CanvasRecovery {
    const next = ++version;
    const writerId = previous?.writerId || nanoid();
    return { ...input, writerId, version: next, savedAt: new Date().toISOString(), key: JSON.stringify([input.userId, input.projectId, writerId, next]) };
}

export async function readCanvasRecoveries(userId: string, projectId: string) {
    const latest = new Map<string, CanvasRecovery>();
    await storage.iterate<CanvasRecovery, void>((record) => {
        if (record.userId !== userId || record.projectId !== projectId) return;
        const previous = latest.get(record.writerId);
        if (!previous) latest.set(record.writerId, record);
        else if (previous.version < record.version) latest.set(record.writerId, { ...record, supersededKeys: [...(previous.supersededKeys || []), previous.key] });
        else latest.set(record.writerId, { ...previous, supersededKeys: [...(previous.supersededKeys || []), record.key] });
    });
    return [...latest.values()].sort((a, b) => b.savedAt.localeCompare(a.savedAt));
}

export async function writeCanvasRecovery(record: CanvasRecovery, previous: CanvasRecovery | undefined, isCurrent: () => boolean) {
    if (!isCurrent()) return;
    // 每一版本使用独立键，迟到清理与其他标签页都无法删除更新的编辑。
    await storage.setItem(record.key, record);
    if (!isCurrent()) { await storage.removeItem(record.key); return; }
    const scope = JSON.stringify([record.userId, record.projectId, record.writerId]);
    const older = persisted.get(scope) || previous;
    persisted.set(scope, record);
    if (older) await storage.removeItem(older.key);
}

export async function removeCanvasRecovery(record: CanvasRecovery, isCurrent: () => boolean) {
    if (!isCurrent()) return;
    const scope = JSON.stringify([record.userId, record.projectId, record.writerId]);
    const previous = persisted.get(scope);
    // 最新待写版本可能已被服务端保存而跳过写入，此时清理同一编辑链此前实际落盘的版本。
    const savedPrevious = previous && previous.version <= record.version;
    await Promise.all([record.key, ...(record.supersededKeys || []), ...(savedPrevious ? [previous.key] : [])].map((key) => storage.removeItem(key)));
    if ((persisted.get(scope)?.version ?? Infinity) <= record.version) persisted.delete(scope);
}

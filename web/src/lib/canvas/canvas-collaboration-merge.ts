import { applyPatch, compare, getValueByPointer, type Operation } from "fast-json-patch";
import stringify from "fast-json-stable-stringify";
import type { CanvasConnection, CanvasNodeData } from "@/types/canvas";

export type SharedCanvasSnapshot = { nodes: CanvasNodeData[]; connections: CanvasConnection[]; backgroundMode: string; showImageInfo: boolean };
type KeyedCanvasSnapshot = Omit<SharedCanvasSnapshot, "nodes" | "connections"> & { nodes: Record<string, CanvasNodeData>; connections: Record<string, CanvasConnection> };

function keyedSnapshot(snapshot: SharedCanvasSnapshot) {
    const snapshotValue = JSON.parse(JSON.stringify({ nodes: Object.fromEntries(snapshot.nodes.map((node) => [node.id, node])), connections: Object.fromEntries(snapshot.connections.map((connection) => [connection.id, connection])), backgroundMode: snapshot.backgroundMode, showImageInfo: snapshot.showImageInfo }));
    return mapLeaves(snapshotValue, stringify) as Record<string, unknown>;
}

function mapLeaves(value: unknown, convert: (value: unknown) => unknown): unknown {
    return value && typeof value === "object" && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, mapLeaves(item, convert)])) : convert(value);
}

/** Rebase local JSON Patch operations onto the authoritative snapshot; overlapping edits stay explicit. */
export function mergeCanvasSnapshots(base: SharedCanvasSnapshot, local: SharedCanvasSnapshot, remote: SharedCanvasSnapshot): SharedCanvasSnapshot {
    const before = keyedSnapshot(base), after = keyedSnapshot(local), merged = keyedSnapshot(remote);
    const operations = compare(before, after, true);
    const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
    for (let index = 0; index < operations.length; index += 1) {
        const operation = operations[index];
        if (operation.op === "test") {
            const change = operations[++index];
            const actual = getValueByPointer(merged, operation.path);
            if (change.op === "remove" && actual === undefined || change.op === "replace" && same(actual, change.value)) continue;
            applyPatch(merged, [operation, change], true, true, true);
        } else {
            const actual = getValueByPointer(merged, operation.path);
            if (operation.op === "add" && actual !== undefined) {
                if (same(actual, operation.value)) continue;
                throw new Error("同一内容已被其他协作者修改");
            }
            applyPatch(merged, [operation as Operation], true, true, true);
        }
    }
    const decoded = mapLeaves(merged, (value) => JSON.parse(value as string)) as KeyedCanvasSnapshot;
    const ordered = <T extends { id: string }>(values: Record<string, T>, original: T[], mine: T[], theirs: T[]) => {
        const ids = (items: T[]) => items.map((item) => item.id);
        const mineIds = new Set(ids(mine)), theirIds = new Set(ids(theirs));
        const common = new Set(ids(original).filter((id) => mineIds.has(id) && theirIds.has(id)));
        const order = (items: T[]) => ids(items).filter((id) => common.has(id));
        const localReordered = !same(order(original), order(mine));
        if (localReordered && !same(order(original), order(theirs)) && !same(order(mine), order(theirs))) throw new Error("节点顺序已被其他协作者修改");
        return [...new Set(localReordered ? [...ids(mine), ...ids(theirs)] : [...ids(theirs), ...ids(mine)])].filter((id) => Object.hasOwn(values, id)).map((id) => values[id]);
    };
    const nodes = ordered(decoded.nodes, base.nodes, local.nodes, remote.nodes), connections = ordered(decoded.connections, base.connections, local.connections, remote.connections);
    const ids = new Set(nodes.map((node) => node.id));
    if (connections.some((connection) => !ids.has(connection.fromNodeId) || !ids.has(connection.toNodeId))) throw new Error("连线引用的节点已被其他协作者删除");
    return { nodes, connections, backgroundMode: decoded.backgroundMode, showImageInfo: decoded.showImageInfo };
}

import { useEffect, useRef, useState } from "react";

import { useAssetStore } from "@/stores/use-asset-store";
import { assertCurrentSession, useUserStore } from "@/stores/use-user-store";
import { readAssetPackage, type AssetImportItem } from "./asset-transfer";

type ImportItem = AssetImportItem & { status: "pending" | "importing" | "succeeded" | "failed"; error?: string };

export function useAssetImport(onImported: () => void) {
    const sessionVersion = useUserStore((state) => state.sessionVersion);
    const [items, setItems] = useState<ImportItem[]>([]);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const [filename, setFilename] = useState("");
    const state = useRef({ version: 0, controller: new AbortController(), items: [] as ImportItem[], busy: false });
    useEffect(() => {
        setItems([]); setBusy(false); setError(""); setFilename("");
        state.current.items = []; state.current.busy = false;
        return () => { state.current.version++; state.current.controller.abort(); };
    }, [sessionVersion]);
    const capture = () => {
        const version = state.current.version;
        const session = useUserStore.getState().sessionVersion;
        return () => {
            assertCurrentSession(session);
            if (state.current.version !== version || state.current.controller.signal.aborted) throw new DOMException("导入已取消", "AbortError");
        };
    };
    const publish = (next: ImportItem[]) => { state.current.items = next; setItems(next); };
    const run = async (selected: ImportItem[], assertCurrent: () => void) => {
        state.current.busy = true; setBusy(true);
        await Promise.all(selected.map(async (item) => {
            const update = (patch: Partial<ImportItem>) => { assertCurrent(); publish(state.current.items.map((entry) => entry.requestId === item.requestId ? { ...entry, ...patch } : entry)); };
            try {
                update({ status: "importing", error: undefined });
                const draft = await item.prepare();
                assertCurrent();
                await useAssetStore.getState().addAsset(draft, item.requestId);
                update({ status: "succeeded" });
            } catch (reason) {
                try { update({ status: "failed", error: reason instanceof Error ? reason.message : "素材导入失败" }); } catch { /* 旧导入不写入新会话或新素材包。 */ }
            }
        }));
        try { assertCurrent(); state.current.busy = false; setBusy(false); onImported(); } catch { /* 已关闭或已切换会话。 */ }
    };
    const start = async (file?: File) => {
        if (!file || state.current.busy) return;
        state.current.controller.abort();
        state.current.controller = new AbortController();
        state.current.version++;
        state.current.busy = true; setBusy(true); setError(""); setFilename(file.name); publish([]);
        const assertCurrent = capture();
        try {
            const entries = await readAssetPackage(file, { signal: state.current.controller.signal, assertCurrent });
            assertCurrent();
            const next = entries.map((item) => ({ ...item, status: "pending" as const }));
            publish(next);
            await run(next, assertCurrent);
        } catch (reason) {
            try { assertCurrent(); setError(reason instanceof Error ? reason.message : "素材包读取失败"); state.current.busy = false; setBusy(false); } catch { /* 旧读取不写回。 */ }
        }
    };
    const retry = async () => {
        if (state.current.busy) return;
        const failed = state.current.items.filter((item) => item.status === "failed");
        if (failed.length) await run(failed, capture());
    };
    const clear = () => {
        state.current.version++; state.current.controller.abort(); state.current.busy = false;
        publish([]); setBusy(false); setError(""); setFilename("");
    };
    return { items, busy, error, filename, start, retry, clear };
}

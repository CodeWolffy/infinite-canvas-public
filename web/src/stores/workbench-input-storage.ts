import localforage from "localforage";
import { assertCurrentSession, useUserStore } from "@/stores/use-user-store";

const storage = localforage.createInstance({ name: "infinite-canvas", storeName: "workbench_inputs" });
const writes = new Map<string, Promise<unknown>>();

function storageKey(capability: "image" | "video", session: number) {
    assertCurrentSession(session);
    const userId = useUserStore.getState().user?.id;
    if (!userId) throw new DOMException("登录会话已变更", "AbortError");
    return JSON.stringify([userId, capability]);
}

export async function readWorkbenchInput<T>(capability: "image" | "video", session: number) {
    const key = storageKey(capability, session);
    await writes.get(key)?.catch(() => undefined);
    assertCurrentSession(session);
    const value = await storage.getItem<T>(key);
    assertCurrentSession(session);
    return value;
}

export async function writeWorkbenchInput<T>(capability: "image" | "video", value: T, session: number, assertInput: () => void) {
    const key = storageKey(capability, session);
    const snapshot = structuredClone(value);
    const operation = (writes.get(key) || Promise.resolve()).catch(() => undefined).then(async () => {
        assertCurrentSession(session);
        assertInput();
        await storage.setItem(key, snapshot);
        assertCurrentSession(session);
    });
    writes.set(key, operation);
    return operation.finally(() => { if (writes.get(key) === operation) writes.delete(key); });
}

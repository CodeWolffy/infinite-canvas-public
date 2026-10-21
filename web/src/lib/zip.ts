import { Unzip, UnzipInflate, zipSync, type UnzipFile } from "fflate";

// 用户确认的画布、素材导入边界；只在整包成功后把文件交给上传流程。
export const ZIP_IMPORT_LIMITS = { archive: 100 * 1024 * 1024, file: 50 * 1024 * 1024, total: 256 * 1024 * 1024, entries: 2000 };

type ZipFile = {
    name: string;
    data: BlobPart;
};

export async function createZip(files: ZipFile[]) {
    const entries = await Promise.all(
        files.map(async (file) => {
            const data = new Uint8Array(await new Blob([file.data]).arrayBuffer());
            return [file.name, data] as const;
        }),
    );
    return new Blob([zipSync(Object.fromEntries(entries), { level: 0 })], { type: "application/zip" });
}

export async function readZip(file: Blob) {
    if (file.size > ZIP_IMPORT_LIMITS.archive) throw new Error("ZIP 压缩包不能超过 100 MiB");
    const files = new Map<string, Blob>();
    const entries: UnzipFile[] = [];
    const names = new Set<string>();
    let total = 0, pending = 0;
    let failure: Error | null = null;
    const unzip = new Unzip((entry) => {
        entries.push(entry);
        if (failure) return;
        if (entries.length > ZIP_IMPORT_LIMITS.entries) { failure = new Error("ZIP 条目不能超过 2000 个"); return; }
        if (names.has(entry.name) || entry.name.includes("\\") || entry.name.startsWith("/") || entry.name.split("/").includes("..")) { failure = new Error("ZIP 文件路径重复或无效"); return; }
        names.add(entry.name);
        if (entry.originalSize !== undefined && entry.originalSize > ZIP_IMPORT_LIMITS.file) { failure = new Error("ZIP 单文件不能超过 50 MiB"); return; }
        let size = 0;
        const chunks: BlobPart[] = [];
        pending++;
        entry.ondata = (error, chunk, final) => {
            if (failure) return;
            if (error) { failure = error; return; }
            size += chunk.byteLength;
            total += chunk.byteLength;
            if (size > ZIP_IMPORT_LIMITS.file || total > ZIP_IMPORT_LIMITS.total) { failure = new Error("ZIP 单文件超过 50 MiB 或总解压量超过 256 MiB"); return; }
            chunks.push(new Uint8Array(chunk));
            if (final) {
                if (entry.originalSize !== undefined && entry.originalSize !== size) { failure = new Error("ZIP 文件长度不匹配"); return; }
                files.set(entry.name, new Blob(chunks));
                chunks.length = 0;
                pending--;
            }
        };
        entry.start();
    });
    unzip.register(UnzipInflate);
    const reader = file.stream().getReader();
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            // 小块输入避免伪造大小的 DEFLATE 流在一次回调前分配巨量输出。
            for (let offset = 0; offset < value.length; offset += 4096) {
                unzip.push(value.subarray(offset, offset + 4096));
                if (failure) throw failure;
            }
        }
        unzip.push(new Uint8Array(), true);
        if (failure) throw failure;
        if (pending) throw new Error("ZIP 文件不完整");
        return files;
    } finally {
        await reader.cancel();
        reader.releaseLock();
        entries.forEach((entry) => entry.terminate());
    }
}

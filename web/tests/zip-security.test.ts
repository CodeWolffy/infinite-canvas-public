import { Blob as NodeBlob } from "node:buffer";
import { Zip, ZipDeflate, zipSync } from "fflate";
import { expect, test } from "vitest";
import { readZip, ZIP_IMPORT_LIMITS } from "@/lib/zip";

const blob = (bytes: Uint8Array) => new NodeBlob([bytes]) as unknown as Blob;

test("普通导出包保持可读，目录与文件不会丢失", async () => {
    const files = await readZip(blob(zipSync({ "assets.json": new TextEncoder().encode('{"assets":[]}'), "images/demo.bin": new Uint8Array([1, 2, 3]) })));
    expect(await files.get("assets.json")!.text()).toBe('{"assets":[]}');
    expect(Array.from(new Uint8Array(await files.get("images/demo.bin")!.arrayBuffer()))).toEqual([1, 2, 3]);
});

test("压缩包过大时在读取内容前拒绝", async () => {
    const file = { size: ZIP_IMPORT_LIMITS.archive + 1, stream: () => { throw new Error("不得读取"); } } as unknown as Blob;
    await expect(readZip(file)).rejects.toThrow("100 MiB");
});

test("高压缩比、未知解压大小的流式文件按实际输出量拒绝", async () => {
    const parts: Uint8Array[] = [];
    const zip = new Zip((error, data) => { if (error) throw error; parts.push(data); });
    const entry = new ZipDeflate("bomb.bin", { level: 9 });
    zip.add(entry);
    const block = new Uint8Array(1024 * 1024);
    for (let i = 0; i < 51; i++) entry.push(block, i === 50);
    zip.end();
    await expect(readZip(new NodeBlob(parts) as unknown as Blob)).rejects.toThrow("50 MiB");
});

test("条目数量、重复名称和目录穿越均在整包返回前拒绝", async () => {
    const many = Object.fromEntries(Array.from({ length: 2001 }, (_, index) => [`${index}.txt`, new Uint8Array()]));
    await expect(readZip(blob(zipSync(many)))).rejects.toThrow("2000");
    await expect(readZip(blob(zipSync({ "../outside.txt": new Uint8Array([1]) })))).rejects.toThrow("路径");
    const parts: Uint8Array[] = [];
    const zip = new Zip((error, data) => { if (error) throw error; parts.push(data); });
    for (let i = 0; i < 2; i++) { const entry = new ZipDeflate("same.txt"); zip.add(entry); entry.push(new Uint8Array([i]), true); }
    zip.end();
    await expect(readZip(new NodeBlob(parts) as unknown as Blob)).rejects.toThrow("重复");
});

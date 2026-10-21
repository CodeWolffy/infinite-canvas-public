import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runClaudeTurn } from "./claude.js";

test("Windows Claude 包装器只从 stdin 收到提示词，命令元字符不能执行", { skip: process.platform !== "win32" }, async (context) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "canvas-claude-security-"));
    const originalPath = process.env.PATH;
    context.after(async () => {
        process.env.PATH = originalPath;
        assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
        await fs.rm(directory, { recursive: true, force: true });
    });
    const capture = path.join(directory, "capture.json");
    await fs.writeFile(path.join(directory, "capture.cjs"), `let input=''; process.stdin.setEncoding('utf8'); process.stdin.on('data', part => input+=part); process.stdin.on('end', () => { require('node:fs').writeFileSync(${JSON.stringify(capture)}, JSON.stringify({args:process.argv.slice(2), input})); console.log(JSON.stringify({type:'captured'})); });`);
    await fs.writeFile(path.join(directory, "claude.cmd"), `@"${process.execPath}" "${path.join(directory, "capture.cjs")}" %*\r\n`);
    process.env.PATH = `${directory}${path.delimiter}${originalPath || ""}`;
    const marker = path.join(directory, "must-not-exist.txt");
    const prompt = `检查普通文本 & echo harmless>"${marker}" & rem %PATH% | < > ^ "\n第二行`;
    await new Promise<void>((resolve, reject) => {
        runClaudeTurn(prompt, (type, data) => {
            const payload = data as { message?: string; code?: number };
            if (type === "agent_error") reject(new Error(String(payload.message)));
            if (type === "agent_done") payload.code === 0 ? resolve() : reject(new Error(`CLI exited ${payload.code}`));
        });
    });
    const result = JSON.parse(await fs.readFile(capture, "utf8"));
    assert.ok(result.input.endsWith(prompt));
    assert.ok(!result.args.some((argument: string) => argument.includes("harmless") || argument.includes("用户请求")));
    await assert.rejects(fs.stat(marker), { code: "ENOENT" });
});

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import ts from "typescript";

// Vitest runs with the web/ directory as the working directory.
const srcDir = resolve(process.cwd(), "src");

export function readSource(relativePath: string): string {
    return readFileSync(resolve(srcDir, relativePath), "utf8");
}

export function sourceFile(relativePath: string, kind: ts.ScriptKind = ts.ScriptKind.TS): ts.SourceFile {
    return ts.createSourceFile(relativePath, readSource(relativePath), ts.ScriptTarget.Latest, true, kind);
}

export function findNode(node: ts.Node, predicate: (node: ts.Node) => boolean): ts.Node | undefined {
    if (predicate(node)) return node;
    return ts.forEachChild(node, (child) => findNode(child, predicate));
}

// Execute a production module after transpiling it, with its browser/API dependencies injected.
export function loadModule(source: string, context: Record<string, unknown> = {}, imports: Record<string, unknown> = {}): Record<string, any> {
    const module = { exports: {} as Record<string, any> };
    const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
    runInNewContext(code, {
        module,
        exports: module.exports,
        require: (id: string) => {
            if (!(id in imports)) throw new Error(`Unexpected dependency: ${id}`);
            return imports[id];
        },
        ...context,
    });
    return module.exports;
}

// Compile a bare expression extracted from production source and return it as a callable.
export function evaluate(code: string, context: Record<string, any>): any {
    const compiled = ts.transpileModule(`globalThis.run = ${code}`, { compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
    runInNewContext(compiled, context);
    return context.run;
}

export { srcDir };

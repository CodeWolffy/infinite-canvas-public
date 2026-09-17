const assert = require("node:assert/strict");
const { test } = require("node:test");
const ts = require("typescript");
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");

const sourceCode = readFileSync(resolve(__dirname, "../src/lib/image-thumbnail.ts"), "utf8");
const compiled = ts.transpileModule(sourceCode, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
const moduleExports = {};
const moduleFunc = new Function("exports", "require", compiled);
moduleFunc(moduleExports, require);
const { pickImageSource } = moduleExports;

const base = {
    previewUrl: "data:image/webp;base64,preview",
    originalUrl: "data:image/png;base64,original",
    naturalWidth: 4000,
    naturalHeight: 3000,
    renderedWidth: 420,
    renderedHeight: 315,
};

test("uses the preview while it has enough pixels for the rendered size", () => {
    assert.equal(pickImageSource({ ...base, scale: 1, devicePixelRatio: 1 }), base.previewUrl);
});

test("falls back to the original once the rendered size outgrows the preview", () => {
    assert.equal(pickImageSource({ ...base, scale: 3, devicePixelRatio: 2 }), base.originalUrl);
});

test("uses the original when no preview exists", () => {
    assert.equal(pickImageSource({ ...base, previewUrl: undefined, scale: 1, devicePixelRatio: 1 }), base.originalUrl);
});

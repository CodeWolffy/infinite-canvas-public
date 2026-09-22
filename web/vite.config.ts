import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { visualizer } from "rollup-plugin-visualizer";
import { defineConfig, type Plugin } from "vite";

import { parseChangelog } from "./src/lib/release";

const webDir = dirname(fileURLToPath(import.meta.url));
const localVersion = readFileSync(resolve(webDir, "../VERSION"), "utf8").trim() || "dev";
const localChangelog = readFileSync(resolve(webDir, "../CHANGELOG.md"), "utf8");
const analyze = Boolean(process.env.ANALYZE);

// 把体积大且长期不变的第三方库拆成独立 chunk，入口 chunk 只留业务代码与路由壳。
function manualChunks(id: string) {
    const inNodeModules = /[\\/]node_modules[\\/]/.test(id);
    if (!inNodeModules) return undefined;
    if (/[\\/]node_modules[\\/](react|react-dom|react-router|react-router-dom|scheduler)[\\/]/.test(id)) return "react-vendor";
    if (/[\\/]node_modules[\\/](antd|@ant-design|@rc-component|rc-)[^\\/]*[\\/]/.test(id)) return "antd";
    if (id.includes("@tanstack/react-query")) return "query";
    if (/[\\/]node_modules[\\/](i18next|react-i18next)[\\/]/.test(id)) return "i18n";
    if (/[\\/]node_modules[\\/]motion[^\\/]*[\\/]/.test(id)) return "motion";
    return undefined;
}

// Expose /plugins/index.json with local plugin files from public/plugins.
// The frontend can discover and list them when enabled; development reads the directory live, while builds emit a static registry.
function localPluginsManifest(): Plugin {
    const pluginsDir = resolve(webDir, "public/plugins");
    const listLocalPlugins = () => {
        try {
            return readdirSync(pluginsDir)
                .filter((file) => file.endsWith(".js"))
                .sort()
                .map((file) => `/plugins/${file}`);
        } catch {
            return [];
        }
    };
    return {
        name: "local-plugins-manifest",
        configureServer(server) {
            server.middlewares.use("/plugins/index.json", (_req, res) => {
                res.setHeader("Content-Type", "application/json");
                res.end(JSON.stringify(listLocalPlugins()));
            });
        },
        generateBundle() {
            this.emitFile({ type: "asset", fileName: "plugins/index.json", source: JSON.stringify(listLocalPlugins()) });
        },
    };
}

export default defineConfig({
    base: process.env.VITE_BASE || "/",
    plugins: [react(), localPluginsManifest(), ...(analyze ? [visualizer({ filename: "dist/stats.html", gzipSize: true })] : [])],
    server: {
        proxy: {
            "/api": process.env.VITE_API_TARGET || "http://localhost:3001",
        },
    },
    resolve: {
        alias: {
            "@": resolve(webDir, "src"),
        },
    },
    define: {
        __APP_VERSION__: JSON.stringify(localVersion),
        __APP_RELEASES__: JSON.stringify(parseChangelog(localChangelog).slice(0, 5)),
    },
    build: {
        rollupOptions: {
            output: { manualChunks },
        },
    },
});

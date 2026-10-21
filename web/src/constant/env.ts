export const APP_VERSION = __APP_VERSION__ || "dev";

export const DOCS_URL = import.meta.env.VITE_DOC_URL || "https://docs.canvas.best";

// 留空时使用随应用发布的固定版本；自托管清单必须同时提供独立配置的 SHA-256。
export const PLUGIN_REGISTRY_URL = import.meta.env.VITE_PLUGIN_REGISTRY_URL || "";
export const PLUGIN_REGISTRY_SHA256 = import.meta.env.VITE_PLUGIN_REGISTRY_SHA256 || "";

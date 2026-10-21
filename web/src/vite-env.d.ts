/// <reference types="vite/client" />

declare const __APP_VERSION__: string;
declare const __APP_RELEASES__: import("@/lib/release").ReleaseInfo[];

interface ImportMetaEnv {
    // 开发插件只作为待确认来源列出，启用与更新都需确认具体内容。
    readonly VITE_DEV_PLUGINS?: string;
    readonly VITE_PLUGIN_REGISTRY_URL?: string;
    readonly VITE_PLUGIN_REGISTRY_SHA256?: string;
    // Optional build-time analytics configuration, with one independent variable per provider.
    // GA4 measurement ID (G-XXXX)
    readonly VITE_ANALYTICS_GA4_ID?: string;
    // Baidu Analytics site ID
    readonly VITE_ANALYTICS_BAIDU_ID?: string;
}

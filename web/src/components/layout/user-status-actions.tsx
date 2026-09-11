import type { CSSProperties } from "react";
import { useState } from "react";
import { Dropdown, Tooltip } from "antd";
import { BookOpen, CircleUserRound, Keyboard, LogOut, ShieldCheck } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";

import { AnimatedThemeToggler } from "@/components/ui/animated-theme-toggler";
import { GitHubLink } from "@/components/layout/github-link";
import { VersionReleaseModal } from "@/components/layout/version-release-modal";
import { NotificationCenter } from "@/components/layout/notification-center";
import { DOCS_URL } from "@/constant/env";
import { changeAppLocale, type AppLocale } from "@/i18n";
import { formatBytes } from "@/lib/image-utils";
import { cn } from "@/lib/utils";
import { canvasThemes } from "@/lib/canvas-theme";
import { getMyStorageUsage } from "@/services/api/media";
import { useThemeStore } from "@/stores/use-theme-store";
import { useUserStore } from "@/stores/use-user-store";

type UserStatusActionsProps = {
    variant?: "default" | "canvas";
    onOpenShortcuts?: () => void;
};

export function UserStatusActions({ variant = "default", onOpenShortcuts }: UserStatusActionsProps) {
    const navigate = useNavigate();
    const { i18n, t } = useTranslation();
    const theme = useThemeStore((state) => state.theme);
    const setTheme = useThemeStore((state) => state.setTheme);
    const canvasTheme = canvasThemes[theme];
    const user = useUserStore((state) => state.user);
    const logout = useUserStore((state) => state.logout);
    const naturalIconClass = "inline-flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md text-stone-600 transition-colors hover:bg-black/5 hover:text-stone-950 dark:text-stone-300 dark:hover:bg-white/10 dark:hover:text-white [&_svg]:size-4";
    const iconStyle: CSSProperties | undefined = variant === "canvas" ? { color: canvasTheme.node.text } : undefined;
    const versionStyle = iconStyle;
    const gitHubClassName = "size-7 text-base";
    const gitHubStyle = iconStyle;
    const locale = i18n.resolvedLanguage as AppLocale;
    const nextLocale = locale === "zh-CN" ? "en-US" : "zh-CN";
    const languageLabel = t("topNav.switchLanguage", { language: t(nextLocale === "zh-CN" ? "locale.zhCN" : "locale.enUS") });
    const [storageUsage, setStorageUsage] = useState("");

    const loadStorageUsage = (open: boolean) => {
        if (!open || storageUsage) return;
        void getMyStorageUsage()
            .then(({ totalCount, totalBytes, quotaBytes }) => setStorageUsage(`${totalCount} 个文件 · ${formatBytes(totalBytes) || "0 B"}${quotaBytes > 0 ? ` / ${formatBytes(quotaBytes)}` : ""}`))
            .catch(() => undefined);
    };

    return (
        <div className="inline-flex shrink-0 items-center gap-1">
            <a href={DOCS_URL} target="_blank" rel="noopener noreferrer" className={naturalIconClass} style={iconStyle} aria-label={t("topNav.docs")} title={t("topNav.docs")}>
                <BookOpen className="size-4" />
            </a>
            <Tooltip title={languageLabel} mouseEnterDelay={0.2}>
                <button type="button" className={`${naturalIconClass} text-[11px] font-semibold tracking-tight`} style={iconStyle} onClick={() => void changeAppLocale(nextLocale)} aria-label={languageLabel}>
                    {locale === "zh-CN" ? "中" : "EN"}
                </button>
            </Tooltip>
            <AnimatedThemeToggler theme={theme} onThemeChange={setTheme} className={naturalIconClass} style={iconStyle} aria-label={t(theme === "dark" ? "topNav.lightTheme" : "topNav.darkTheme")} title={t(theme === "dark" ? "topNav.lightTheme" : "topNav.darkTheme")} />
            <VersionReleaseModal style={versionStyle} />
            <NotificationCenter />
            <GitHubLink className={cn("bg-transparent hover:bg-transparent dark:hover:bg-transparent", gitHubClassName)} style={gitHubStyle} />
            <Dropdown
                trigger={["click"]}
                onOpenChange={loadStorageUsage}
                menu={{
                    items: [
                        { key: "identity", disabled: true, label: <div className="min-w-32"><div className="truncate font-medium">{user?.displayName}</div><div className="truncate text-xs opacity-55">@{user?.username}</div></div> },
                        ...(storageUsage ? [{ key: "storage", disabled: true, label: <div className="min-w-32 text-xs opacity-55">我的占用：{storageUsage}</div> }] : []),
                        { type: "divider" as const },
                        { key: "userCenter", icon: <CircleUserRound className="size-4" />, label: t("userCenter.title"), onClick: () => navigate("/user/generations") },
                        ...(user?.role === "admin" ? [{ key: "admin", icon: <ShieldCheck className="size-4" />, label: "平台管理", onClick: () => navigate("/admin/stats") }] : []),
                        { key: "logout", icon: <LogOut className="size-4" />, label: "退出登录", onClick: () => void logout().then(() => navigate("/login", { replace: true })) },
                    ],
                }}
            >
                <button type="button" className={naturalIconClass} style={iconStyle} aria-label="账号菜单" title={user?.displayName || "账号菜单"}><CircleUserRound className="size-4" /></button>
            </Dropdown>
            {onOpenShortcuts ? (
                <button type="button" className={naturalIconClass} style={iconStyle} onClick={onOpenShortcuts} aria-label={t("topNav.shortcuts")} title={t("topNav.shortcuts")}>
                    <Keyboard className="size-4" />
                </button>
            ) : null}
        </div>
    );
}

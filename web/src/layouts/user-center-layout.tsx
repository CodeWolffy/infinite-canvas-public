import { Suspense } from "react";
import { Spin } from "antd";
import { BarChart3, History, Images, LayoutDashboard, LogOut, ShieldCheck, Users, Wallet } from "lucide-react";
import { Link, NavLink, Outlet, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";

import { AnnouncementCenter } from "@/components/layout/announcement-center";
import { NotificationCenter } from "@/components/layout/notification-center";
import { AnimatedThemeToggler } from "@/components/ui/animated-theme-toggler";
import { cn } from "@/lib/utils";
import { useThemeStore } from "@/stores/use-theme-store";
import { useUserStore } from "@/stores/use-user-store";

export default function UserCenterLayout() {
    const { t } = useTranslation();
    const navigate = useNavigate();
    const user = useUserStore((state) => state.user);
    const logout = useUserStore((state) => state.logout);
    const theme = useThemeStore((state) => state.theme);
    const setTheme = useThemeStore((state) => state.setTheme);

    const userLinks = [
        { to: "/user/wallet", label: "余额与签到", icon: Wallet },
        { to: "/user/referrals", label: "邀请好友", icon: Users },
        { to: "/user/generations", label: t("userCenter.navGenerations"), icon: Images },
        { to: "/user/stats", label: t("userCenter.navStats"), icon: BarChart3 },
        { to: "/user/logs", label: t("userCenter.navLogs"), icon: History },
        { to: "/user/account", label: t("userCenter.navAccount"), icon: ShieldCheck },
    ];

    return (
        <div className="flex h-dvh overflow-hidden bg-background text-foreground">
            <aside className="hidden w-[156px] shrink-0 flex-col border-r border-stone-200 bg-stone-50/70 md:flex dark:border-stone-800 dark:bg-stone-950/40">
                <Link to="/user/generations" className="flex h-16 items-center gap-2 border-b border-stone-200 px-3.5 text-sm font-semibold dark:border-stone-800">
                    <span className="size-5 shrink-0 bg-current" style={{ mask: "url(/logo.svg) center / contain no-repeat", WebkitMask: "url(/logo.svg) center / contain no-repeat" }} />
                    <span className="truncate">{t("userCenter.title")}</span>
                </Link>
                <nav className="flex-1 space-y-1 p-2">
                    {userLinks.map(({ to, label, icon: Icon }) => (
                        <NavLink
                            key={to}
                            to={to}
                            className={({ isActive }) =>
                                cn(
                                    "flex items-center gap-2 rounded-lg px-2.5 py-2 text-sm transition",
                                    isActive
                                        ? "bg-stone-950 font-medium text-white dark:bg-stone-100 dark:text-stone-950"
                                        : "text-stone-600 hover:bg-black/5 hover:text-stone-950 dark:text-stone-400 dark:hover:bg-white/10 dark:hover:text-stone-100",
                                )
                            }
                        >
                            <Icon className="size-4 shrink-0" />
                            <span className="truncate">{label}</span>
                        </NavLink>
                    ))}
                </nav>
                <div className="border-t border-stone-200 p-2.5 dark:border-stone-800">
                    <div className="mb-2.5 min-w-0 px-1.5">
                        <div className="truncate text-sm font-medium">{user?.displayName}</div>
                        <div className="truncate text-xs text-stone-500">@{user?.username}</div>
                    </div>
                    <button
                        type="button"
                        className="flex w-full items-center gap-2 rounded-lg px-1.5 py-1.5 text-sm text-stone-500 transition hover:bg-black/5 hover:text-stone-950 dark:hover:bg-white/10 dark:hover:text-stone-100"
                        onClick={() => void logout().then(() => navigate("/login", { replace: true }))}
                    >
                        <LogOut className="size-4 shrink-0" />
                        <span className="truncate">{t("userCenter.logout")}</span>
                    </button>
                </div>
            </aside>
            <div className="flex min-w-0 flex-1 flex-col">
                <header className="flex h-16 shrink-0 items-center justify-between border-b border-stone-200 px-4 sm:px-6 dark:border-stone-800">
                    <div className="flex items-center gap-2 md:hidden">
                        <span className="size-5 bg-current" style={{ mask: "url(/logo.svg) center / contain no-repeat", WebkitMask: "url(/logo.svg) center / contain no-repeat" }} />
                        <span className="font-semibold">{t("userCenter.title")}</span>
                    </div>
                    <nav className="hide-scrollbar flex min-w-0 items-center gap-1 overflow-x-auto md:hidden">
                        {userLinks.map(({ to, label }) => (
                            <NavLink
                                key={to}
                                to={to}
                                className={({ isActive }) =>
                                    cn("shrink-0 rounded-md px-2 py-1.5 text-sm", isActive ? "font-medium text-stone-950 dark:text-stone-100" : "text-stone-500")
                                }
                            >
                                {label}
                            </NavLink>
                        ))}
                    </nav>
                    <div className="ml-auto flex items-center gap-1.5">
                        <AnnouncementCenter />
                        <NotificationCenter />
                        <Link
                            to="/"
                            className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-sm text-stone-600 transition hover:bg-black/5 hover:text-stone-950 dark:text-stone-400 dark:hover:bg-white/10 dark:hover:text-stone-100"
                            title={t("userCenter.backToWorkspace")}
                        >
                            <LayoutDashboard className="size-4" />
                            <span className="hidden sm:inline">{t("userCenter.backToWorkspace")}</span>
                        </Link>
                        <AnimatedThemeToggler
                            theme={theme}
                            onThemeChange={setTheme}
                            className="inline-flex size-9 items-center justify-center rounded-lg text-stone-500 transition hover:bg-black/5 hover:text-stone-950 dark:hover:bg-white/10 dark:hover:text-stone-100"
                            aria-label="切换主题"
                        />
                        <button
                            type="button"
                            className="inline-flex size-9 items-center justify-center rounded-lg text-stone-500 transition hover:bg-black/5 hover:text-stone-950 md:hidden dark:hover:bg-white/10 dark:hover:text-stone-100"
                            title={t("userCenter.logout")}
                            onClick={() => void logout().then(() => navigate("/login", { replace: true }))}
                        >
                            <LogOut className="size-4" />
                        </button>
                    </div>
                </header>
                <main className="min-h-0 flex-1 overflow-y-auto">
                    <Suspense fallback={<div className="flex h-full items-center justify-center"><Spin /></div>}>
                        <Outlet />
                    </Suspense>
                </main>
            </div>
        </div>
    );
}

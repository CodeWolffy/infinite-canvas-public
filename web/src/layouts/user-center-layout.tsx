import { Suspense, useState } from "react";
import { Drawer, Grid, Spin } from "antd";
import { BarChart3, History, Images, LayoutDashboard, LogOut, Menu, UserRound, Users, Wallet } from "lucide-react";
import { Link, NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";

import { AnnouncementCenter } from "@/components/layout/announcement-center";
import { NotificationCenter } from "@/components/layout/notification-center";
import { AnimatedThemeToggler } from "@/components/ui/animated-theme-toggler";
import { cn } from "@/lib/utils";
import { useThemeStore } from "@/stores/use-theme-store";
import { useUserStore } from "@/stores/use-user-store";

export default function UserCenterLayout() {
    const screens = Grid.useBreakpoint();
    const { t } = useTranslation();
    const navigate = useNavigate();
    const { pathname } = useLocation();
    const [mobileNavOpen, setMobileNavOpen] = useState(false);
    const user = useUserStore((state) => state.user);
    const logout = useUserStore((state) => state.logout);
    const theme = useThemeStore((state) => state.theme);
    const setTheme = useThemeStore((state) => state.setTheme);

    const userLinks = [
        { to: "/user/wallet", label: t("userCenter.navWallet"), icon: Wallet },
        { to: "/user/generations", label: t("userCenter.navGenerations"), icon: Images },
        { to: "/user/stats", label: t("userCenter.navStats"), icon: BarChart3 },
        { to: "/user/logs", label: t("userCenter.navLogs"), icon: History },
        { to: "/user/workspaces", label: t("userCenter.navWorkspaces"), icon: Users },
        { to: "/user/account", label: t("userCenter.navAccount"), icon: UserRound },
    ];
    const navigation = (
        <nav className="min-h-0 flex-1 space-y-1 overflow-y-auto overscroll-contain p-2" aria-label={t("userCenter.title")}>
            {userLinks.map(({ to, label, icon: Icon }) => (
                <NavLink key={to} to={to} onClick={() => setMobileNavOpen(false)} className={({ isActive }) => cn("flex min-h-11 items-center gap-2 rounded-lg px-2.5 py-2 text-sm transition md:min-h-0", isActive ? "bg-stone-950 font-medium text-white dark:bg-stone-100 dark:text-stone-950" : "text-stone-600 hover:bg-black/5 hover:text-stone-950 dark:text-stone-400 dark:hover:bg-white/10 dark:hover:text-stone-100")}>
                    <Icon className="size-4 shrink-0" /><span className="truncate">{label}</span>
                </NavLink>
            ))}
        </nav>
    );
    const account = (
        <div className="shrink-0 border-t border-stone-200 p-2.5 dark:border-stone-800">
            <div className="mb-2.5 min-w-0 px-1.5"><div className="truncate text-sm font-medium">{user?.displayName}</div><div className="truncate text-xs text-stone-500">@{user?.username}</div></div>
            <div className="flex items-center">
                <button type="button" className="flex min-h-11 min-w-0 flex-1 items-center gap-2 rounded-lg px-1.5 py-1.5 text-sm text-stone-500 transition hover:bg-black/5 hover:text-stone-950 md:min-h-0 dark:hover:bg-white/10 dark:hover:text-stone-100" onClick={() => void logout().then(() => navigate("/login", { replace: true }))}><LogOut className="size-4 shrink-0" /><span className="truncate">{t("userCenter.logout")}</span></button>
                <AnimatedThemeToggler theme={theme} onThemeChange={setTheme} className="inline-flex size-11 shrink-0 items-center justify-center rounded-lg text-stone-500 hover:bg-black/5 md:hidden dark:hover:bg-white/10 [&_svg]:size-4" aria-label="切换主题" />
            </div>
        </div>
    );

    return (
        <div className="flex h-dvh overflow-hidden bg-background text-foreground">
            <aside className="hidden w-[156px] shrink-0 flex-col border-r border-stone-200 bg-stone-50/70 md:flex dark:border-stone-800 dark:bg-stone-950/40">
                <Link to="/user/generations" className="flex h-16 shrink-0 items-center gap-2 border-b border-stone-200 px-3.5 text-sm font-semibold dark:border-stone-800">
                    <span className="size-5 shrink-0 bg-current" style={{ mask: "url(/logo.svg) center / contain no-repeat", WebkitMask: "url(/logo.svg) center / contain no-repeat" }} />
                    <span className="truncate">{t("userCenter.title")}</span>
                </Link>
                {navigation}
                {account}
            </aside>
            <div className="flex min-w-0 flex-1 flex-col">
                <header className="flex h-[calc(3.5rem+env(safe-area-inset-top))] shrink-0 items-center justify-between gap-2 border-b border-stone-200 pt-[env(safe-area-inset-top)] pr-[max(0.75rem,env(safe-area-inset-right))] pl-[max(0.75rem,env(safe-area-inset-left))] sm:pr-[max(1.5rem,env(safe-area-inset-right))] sm:pl-[max(1.5rem,env(safe-area-inset-left))] md:h-16 md:pt-0 dark:border-stone-800">
                    <div className="flex min-w-0 items-center gap-2"><button type="button" className="inline-flex size-10 shrink-0 items-center justify-center rounded-lg hover:bg-black/5 md:hidden dark:hover:bg-white/10" aria-label="打开用户中心导航" aria-expanded={mobileNavOpen} onClick={() => setMobileNavOpen(true)}><Menu className="size-5" /></button><span className="truncate text-sm font-semibold">{userLinks.find(({ to }) => pathname.startsWith(to))?.label || t("userCenter.title")}</span></div>
                    <div className="ml-auto flex shrink-0 items-center gap-0.5 sm:gap-1.5">
                        <AnnouncementCenter className="!hidden sm:!inline-flex" />
                        <NotificationCenter />
                        <Link
                            to="/"
                            className="inline-flex size-10 items-center justify-center gap-1.5 rounded-lg text-sm text-stone-600 transition hover:bg-black/5 hover:text-stone-950 sm:h-9 sm:w-auto sm:px-2.5 dark:text-stone-400 dark:hover:bg-white/10 dark:hover:text-stone-100"
                            title={t("userCenter.backToWorkspace")}
                            aria-label={t("userCenter.backToWorkspace")}
                        >
                            <LayoutDashboard className="size-4" />
                            <span className="hidden sm:inline">{t("userCenter.backToWorkspace")}</span>
                        </Link>
                        <AnimatedThemeToggler
                            theme={theme}
                            onThemeChange={setTheme}
                            className="hidden size-9 items-center justify-center rounded-lg text-stone-500 transition hover:bg-black/5 hover:text-stone-950 md:inline-flex dark:hover:bg-white/10 dark:hover:text-stone-100 [&_svg]:size-4"
                            aria-label="切换主题"
                        />
                    </div>
                </header>
                <main className="min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain pb-[env(safe-area-inset-bottom)]">
                    <Suspense fallback={<div className="flex h-full items-center justify-center"><Spin /></div>}>
                        <Outlet />
                    </Suspense>
                </main>
            </div>
            <Drawer title={t("userCenter.title")} placement="left" size="min(320px, 100vw)" open={mobileNavOpen && !screens.md} onClose={() => setMobileNavOpen(false)} rootClassName="md:hidden [&_.ant-drawer-close]:!size-10" styles={{ header: { paddingTop: "max(12px, env(safe-area-inset-top))" }, body: { display: "flex", flexDirection: "column", padding: 0 }, footer: { padding: "0 0 env(safe-area-inset-bottom)", borderTop: 0 } }} footer={account}>{navigation}</Drawer>
        </div>
    );
}

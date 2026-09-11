import { Suspense, useState } from "react";
import { Button, Spin } from "antd";
import { BarChart3, Cable, History, Images, LayoutDashboard, LogOut, Megaphone, Shapes, UsersRound, CreditCard, ListChecks, SlidersHorizontal, Ticket, Users, ShieldAlert, Gift, Activity } from "lucide-react";
import { Link, NavLink, Outlet, useNavigate } from "react-router-dom";

import { AnimatedThemeToggler } from "@/components/ui/animated-theme-toggler";
import { AnnouncementEditor } from "@/components/layout/announcement-editor";
import { NotificationCenter } from "@/components/layout/notification-center";
import { cn } from "@/lib/utils";
import { useThemeStore } from "@/stores/use-theme-store";
import { useUserStore } from "@/stores/use-user-store";

const adminLinks = [
    { to: "/admin/stats", label: "用量统计", icon: BarChart3 },
    { to: "/admin/status", label: "平台状态", icon: Activity },
    { to: "/admin/tasks", label: "任务与审计", icon: ListChecks },
    { to: "/admin/models", label: "模型管理", icon: Shapes },
    { to: "/admin/channels", label: "渠道管理", icon: Cable },
    { to: "/admin/logs", label: "请求日志", icon: History },
    { to: "/admin/assets", label: "公共素材", icon: Images },
    { to: "/admin/users", label: "用户管理", icon: UsersRound },
    { to: "/admin/invitations", label: "邀请注册", icon: Ticket },
    { to: "/admin/groups", label: "用户分组", icon: Users },
    { to: "/admin/redeem", label: "充值兑换码", icon: Gift },
    { to: "/admin/sensitive", label: "敏感词", icon: ShieldAlert },
    { to: "/admin/billing", label: "充值与账务", icon: CreditCard },
    { to: "/admin/platform-settings", label: "运营设置", icon: SlidersHorizontal },
];

export default function AdminLayout() {
    const navigate = useNavigate();
    const user = useUserStore((state) => state.user);
    const logout = useUserStore((state) => state.logout);
    const theme = useThemeStore((state) => state.theme);
    const setTheme = useThemeStore((state) => state.setTheme);
    const [announcementOpen, setAnnouncementOpen] = useState(false);

    return (
        <div className="flex h-dvh overflow-hidden bg-background text-foreground">
            <aside className="hidden w-[156px] shrink-0 flex-col border-r border-stone-200 bg-stone-50/70 md:flex dark:border-stone-800 dark:bg-stone-950/40">
                <Link to="/admin/stats" className="flex h-16 items-center gap-2 border-b border-stone-200 px-3.5 text-sm font-semibold dark:border-stone-800">
                    <span className="size-5 shrink-0 bg-current" style={{ mask: "url(/logo.svg) center / contain no-repeat", WebkitMask: "url(/logo.svg) center / contain no-repeat" }} />
                    <span className="truncate">平台管理</span>
                </Link>
                <nav className="flex-1 space-y-1 p-2">
                    {adminLinks.map(({ to, label, icon: Icon }) => (
                        <NavLink key={to} to={to} className={({ isActive }) => cn("flex items-center gap-2 rounded-lg px-2.5 py-2 text-sm transition", isActive ? "bg-stone-950 font-medium text-white dark:bg-stone-100 dark:text-stone-950" : "text-stone-600 hover:bg-black/5 hover:text-stone-950 dark:text-stone-400 dark:hover:bg-white/10 dark:hover:text-stone-100")}>
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
                    <button type="button" className="flex w-full items-center gap-2 rounded-lg px-1.5 py-1.5 text-sm text-stone-500 transition hover:bg-black/5 hover:text-stone-950 dark:hover:bg-white/10 dark:hover:text-stone-100" onClick={() => void logout().then(() => navigate("/login", { replace: true }))}>
                        <LogOut className="size-4 shrink-0" />
                        <span className="truncate">退出登录</span>
                    </button>
                </div>
            </aside>
            <div className="flex min-w-0 flex-1 flex-col">
                <header className="flex h-16 shrink-0 items-center justify-between border-b border-stone-200 px-4 sm:px-6 dark:border-stone-800">
                    <div className="flex items-center gap-2 md:hidden"><span className="size-5 bg-current" style={{ mask: "url(/logo.svg) center / contain no-repeat", WebkitMask: "url(/logo.svg) center / contain no-repeat" }} /><span className="font-semibold">平台管理</span></div>
                    <nav className="hide-scrollbar flex min-w-0 items-center gap-1 overflow-x-auto md:hidden">{adminLinks.map(({ to, label }) => <NavLink key={to} to={to} className={({ isActive }) => cn("shrink-0 rounded-md px-2 py-1.5 text-sm", isActive ? "font-medium text-stone-950 dark:text-stone-100" : "text-stone-500")}>{label}</NavLink>)}</nav>
                    <div className="ml-auto flex items-center gap-1">
                        <Button type="text" size="small" className="!px-2 text-stone-500 hover:text-stone-950 dark:text-stone-400 dark:hover:text-stone-100" icon={<Megaphone className="size-4" />} onClick={() => setAnnouncementOpen(true)}>公告</Button>
                        <NotificationCenter />
                        <Link to="/" className="inline-flex size-9 items-center justify-center rounded-lg text-stone-500 transition hover:bg-black/5 hover:text-stone-950 dark:hover:bg-white/10 dark:hover:text-stone-100" title="返回工作台"><LayoutDashboard className="size-4" /></Link>
                        <AnimatedThemeToggler theme={theme} onThemeChange={setTheme} className="inline-flex size-9 items-center justify-center rounded-lg text-stone-500 transition hover:bg-black/5 hover:text-stone-950 dark:hover:bg-white/10 dark:hover:text-stone-100" aria-label="切换主题" />
                        <button type="button" className="inline-flex size-9 items-center justify-center rounded-lg text-stone-500 transition hover:bg-black/5 hover:text-stone-950 md:hidden dark:hover:bg-white/10 dark:hover:text-stone-100" title="退出登录" onClick={() => void logout().then(() => navigate("/login", { replace: true }))}><LogOut className="size-4" /></button>
                    </div>
                </header>
                <main className="min-h-0 flex-1 overflow-y-auto">
                    <Suspense fallback={<div className="flex h-full items-center justify-center"><Spin /></div>}>
                        <Outlet />
                    </Suspense>
                </main>
            </div>
            <AnnouncementEditor open={announcementOpen} onClose={() => setAnnouncementOpen(false)} />
        </div>
    );
}

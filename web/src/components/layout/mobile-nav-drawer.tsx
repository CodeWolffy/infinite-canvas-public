import { Drawer } from "antd";
import { Activity, CircleUserRound, LayoutDashboard, ShieldCheck } from "lucide-react";
import { Link, NavLink } from "react-router-dom";
import { useTranslation } from "react-i18next";

import { navigationTools, type NavigationToolSlug } from "@/constant/navigation-tools";
import { cn } from "@/lib/utils";
import { useUserStore } from "@/stores/use-user-store";

type MobileNavDrawerProps = {
    open: boolean;
    activeToolSlug?: NavigationToolSlug;
    onClose: () => void;
};

export function MobileNavDrawer({ open, activeToolSlug, onClose }: MobileNavDrawerProps) {
    const { t } = useTranslation();
    const user = useUserStore((state) => state.user);

    return (
        <Drawer title={t("topNav.navigation")} placement="left" size="min(320px, 100vw)" open={open} onClose={onClose} rootClassName="[&_.ant-drawer-close]:!size-10" styles={{ header: { paddingTop: "max(12px, env(safe-area-inset-top))" }, body: { padding: "12px 12px max(16px, env(safe-area-inset-bottom))", overscrollBehavior: "contain" } }}>
            <nav className="space-y-1" aria-label={t("topNav.navigation")}>
                <NavLink to="/" end onClick={onClose} className={({ isActive }) => cn("flex items-center gap-3 rounded-lg px-3 py-3 text-base transition hover:bg-muted hover:text-foreground", isActive ? "bg-muted font-medium text-foreground" : "text-muted-foreground")}><LayoutDashboard className="size-5" /><span>{t("userCenter.backToWorkspace")}</span></NavLink>
                {navigationTools.map((tool) => {
                    const Icon = tool.icon;
                    const active = tool.slug === activeToolSlug;
                    return (
                        <Link
                            key={tool.slug}
                            to={`/${tool.slug}`}
                            onClick={onClose}
                            aria-current={active ? "page" : undefined}
                            className={cn(
                                "flex items-center gap-3 rounded-lg px-3 py-3 text-base transition",
                                active ? "bg-stone-100 font-medium text-stone-950 dark:bg-stone-800 dark:text-stone-100" : "text-stone-600 hover:bg-stone-100 hover:text-stone-950 dark:text-stone-300 dark:hover:bg-stone-800 dark:hover:text-stone-100",
                            )}
                        >
                            <Icon className="size-5" />
                            <span>{t(`navigation.${tool.slug}`)}</span>
                        </Link>
                    );
                })}
                <NavLink to="/status" onClick={onClose} className={({ isActive }) => cn("flex items-center gap-3 rounded-lg px-3 py-3 text-base transition hover:bg-muted hover:text-foreground", isActive ? "bg-muted font-medium text-foreground" : "text-muted-foreground")}>
                    <Activity className="size-5" /><span>{t("topNav.modelStatus")}</span>
                </NavLink>
                <div className="my-3 border-t border-border" />
                <Link to="/user/generations" onClick={onClose} className="flex items-center gap-3 rounded-lg px-3 py-3 text-base text-muted-foreground transition hover:bg-muted hover:text-foreground"><CircleUserRound className="size-5" /><span>{t("userCenter.title")}</span></Link>
                {user?.role === "admin" ? <Link to="/admin/stats" onClick={onClose} className="flex items-center gap-3 rounded-lg px-3 py-3 text-base text-muted-foreground transition hover:bg-muted hover:text-foreground"><ShieldCheck className="size-5" /><span>{t("topNav.admin")}</span></Link> : null}
            </nav>
        </Drawer>
    );
}

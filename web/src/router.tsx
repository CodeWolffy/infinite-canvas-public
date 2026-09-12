import { lazy, Suspense } from "react";
import { Spin } from "antd";
import { createBrowserRouter, Navigate, Outlet } from "react-router-dom";

import { AdminGuard, AuthGuard } from "@/components/auth/auth-guard";
import { AnalyticsTracker } from "@/components/layout/analytics-tracker";
import AdminLayout from "@/layouts/admin-layout";
import UserLayout from "@/layouts/user-layout";
import AssetsPage from "@/pages/assets";
import CanvasPage from "@/pages/canvas";
import ChangePasswordPage from "@/pages/change-password";
import HomePage from "@/pages/home";
import LoginPage from "@/pages/login";
import AccountRecoveryPage from "@/pages/account-recovery";
import NotFound from "@/pages/not-found";
import PromptsPage from "@/pages/prompts";
import UserCenterLayout from "@/layouts/user-center-layout";

// 管理后台、个人中心、画布详情和生图工作台体积最大且不是进入应用就需要，拆成独立 chunk 按需加载。
const AdminAssetsPage = lazy(() => import("@/pages/admin/assets"));
const AdminChannelsPage = lazy(() => import("@/pages/admin/channels"));
const AdminLogsPage = lazy(() => import("@/pages/admin/logs"));
const AdminModelsPage = lazy(() => import("@/pages/admin/models"));
const AdminPlaygroundPage = lazy(() => import("@/pages/admin/playground"));
const AdminStatsPage = lazy(() => import("@/pages/admin/stats"));
const AdminUsersPage = lazy(() => import("@/pages/admin/users"));
const UserGenerationsPage = lazy(() => import("@/pages/user/generations"));
const UserStatsPage = lazy(() => import("@/pages/user/stats"));
const UserLogsPage = lazy(() => import("@/pages/user/logs"));
const UserAccountPage = lazy(() => import("@/pages/user/account"));
const CanvasProjectPage = lazy(() => import("@/pages/canvas/project"));
const ImagePage = lazy(() => import("@/pages/image"));
const StudioPage = lazy(() => import("@/pages/studio"));
const WalletPage = lazy(() => import("@/pages/user/wallet"));
const AdminInvitationsPage = lazy(() => import("@/pages/admin/invitations"));
const AdminBillingPage = lazy(() => import("@/pages/admin/billing"));
const AdminPlatformSettingsPage = lazy(() => import("@/pages/admin/platform-settings"));
const AdminTasksPage = lazy(() => import("@/pages/admin/tasks"));
const AdminGroupsPage = lazy(() => import("@/pages/admin/groups"));
const AdminRedeemPage = lazy(() => import("@/pages/admin/redeem"));
const AdminSensitivePage = lazy(() => import("@/pages/admin/sensitive"));
const AdminStatusPage = lazy(() => import("@/pages/admin/status"));
const StatusPage = lazy(() => import("@/pages/status"));
const TextPage = lazy(() => import("@/pages/text"));
const ReferralsPage = lazy(() => import("@/pages/user/referrals"));

export const router = createBrowserRouter([
    { path: "/login", element: <LoginPage /> },
    { path: "/forgot-password", element: <AccountRecoveryPage /> },
    { path: "/reset-password", element: <AccountRecoveryPage /> },
    { path: "/verify-email", element: <AccountRecoveryPage /> },
    {
        element: (
            <AuthGuard>
                <Outlet />
            </AuthGuard>
        ),
        children: [
            { path: "/change-password", element: <ChangePasswordPage /> },
            { path: "/status", element: <Suspense fallback={<Spin />}><StatusPage /></Suspense> },
            {
                element: (
                    <UserLayout>
                        <AnalyticsTracker />
                        <Suspense fallback={<div className="flex h-full items-center justify-center"><Spin /></div>}>
                            <Outlet />
                        </Suspense>
                    </UserLayout>
                ),
                children: [
                    { path: "/", element: <HomePage /> },
                    { path: "/image", element: <ImagePage /> },
                    { path: "/studio", element: <StudioPage /> },
                    { path: "/video", element: <Navigate to="/studio?type=video" replace /> },
                    { path: "/audio", element: <Navigate to="/studio?type=audio" replace /> },
                    { path: "/text", element: <TextPage /> },
                    { path: "/assets", element: <AssetsPage /> },
                    { path: "/prompts", element: <PromptsPage /> },
                    { path: "/canvas", element: <CanvasPage /> },
                    { path: "/canvas/:id", element: <CanvasProjectPage /> },
                ],
            },
            {
                path: "/user",
                element: <UserCenterLayout />,
                children: [
                    { index: true, element: <Navigate to="generations" replace /> },
                    { path: "generations", element: <UserGenerationsPage /> },
                    { path: "stats", element: <UserStatsPage /> },
                    { path: "logs", element: <UserLogsPage /> },
                    { path: "account", element: <UserAccountPage /> },
                    { path: "wallet", element: <WalletPage /> },
                    { path: "referrals", element: <ReferralsPage /> },
                ],
            },
            {
                path: "/admin",
                element: <AdminGuard><AdminLayout /></AdminGuard>,
                children: [
                    { index: true, element: <Navigate to="stats" replace /> },
                    { path: "users", element: <AdminUsersPage /> },
                    { path: "models", element: <AdminModelsPage /> },
                    { path: "channels", element: <AdminChannelsPage /> },
                    { path: "playground", element: <AdminPlaygroundPage /> },
                    { path: "logs", element: <AdminLogsPage /> },
                    { path: "assets", element: <AdminAssetsPage /> },
                    { path: "stats", element: <AdminStatsPage /> },
                    { path: "status", element: <AdminStatusPage /> },
                    { path: "invitations", element: <AdminInvitationsPage /> },
                    { path: "billing", element: <AdminBillingPage /> },
                    { path: "platform-settings", element: <AdminPlatformSettingsPage /> },
                    { path: "tasks", element: <AdminTasksPage /> },
                    { path: "groups", element: <AdminGroupsPage /> },
                    { path: "redeem", element: <AdminRedeemPage /> },
                    { path: "sensitive", element: <AdminSensitivePage /> },
                ],
            },
            { path: "*", element: <NotFound /> },
        ],
    },
]);

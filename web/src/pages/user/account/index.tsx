import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { App, Button, Card, Descriptions, Form, Input, Tag } from "antd";
import { Gift, Lock, Save, ShieldCheck, UserRound } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import dayjs from "dayjs";

import { checkin, getWallet } from "@/services/api/billing";
import { useUserStore } from "@/stores/use-user-store";
import SecuritySettings from "./components/security-settings";

export default function UserAccountPage() {
    const { t } = useTranslation();
    const { message } = App.useApp();
    const navigate = useNavigate();
    const user = useUserStore((state) => state.user);
    const updateDisplayName = useUserStore((state) => state.updateDisplayName);
    const changePassword = useUserStore((state) => state.changePassword);
    const logout = useUserStore((state) => state.logout);
    const sessionVersion = useUserStore((state) => state.sessionVersion);
    const queryClient = useQueryClient();

    const [profileLoading, setProfileLoading] = useState(false);
    const [passwordLoading, setPasswordLoading] = useState(false);
    const [displayName, setDisplayName] = useState(user?.displayName || "");

    const [passwordForm] = Form.useForm();
    const overview = useQuery({ queryKey: ["wallet", sessionVersion], queryFn: getWallet });
    const reward = overview.data?.checkin;
    const claim = useMutation({ mutationFn: checkin, onSuccess: (result) => { void queryClient.invalidateQueries({ queryKey: ["wallet"] }); void queryClient.invalidateQueries({ queryKey: ["wallet-entries"] }); message.success(result.alreadyCheckedIn ? "今天已经领过签到奖励了" : `签到成功，获得 ¥${result.reward}`); }, onError: (error: Error) => message.error(error.message) });

    const handleUpdateProfile = async () => {
        if (!displayName.trim()) {
            message.warning("显示昵称不能为空");
            return;
        }
        setProfileLoading(true);
        try {
            await updateDisplayName(displayName.trim());
            message.success(t("userCenter.profileUpdated"));
        } catch (error) {
            message.error(error instanceof Error ? error.message : "更新失败");
        } finally {
            setProfileLoading(false);
        }
    };

    const handleChangePassword = async (values: { currentPassword: string; newPassword: string; confirmPassword: string }) => {
        if (values.newPassword !== values.confirmPassword) {
            message.error(t("userCenter.passwordMismatch"));
            return;
        }
        setPasswordLoading(true);
        try {
            await changePassword({ currentPassword: values.currentPassword, newPassword: values.newPassword });
            message.success(t("userCenter.passwordChanged"));
            passwordForm.resetFields();
            await logout();
            navigate("/login", { replace: true });
        } catch (error) {
            message.error(error instanceof Error ? error.message : "密码修改失败");
        } finally {
            setPasswordLoading(false);
        }
    };

    return (
        <div className="grid w-full grid-cols-1 gap-6 px-4 py-6 sm:px-6 lg:px-8 lg:py-8 xl:grid-cols-2">
            <div className="xl:col-span-2">
                <div className="flex items-center gap-2 text-stone-500 mb-1">
                    <UserRound className="size-4 text-emerald-500" />
                    <span className="text-xs font-semibold uppercase tracking-wider">Profile</span>
                </div>
                <h1 className="text-2xl font-bold tracking-tight text-stone-950 dark:text-stone-100">
                    {t("userCenter.accountTitle")}
                </h1>
                <p className="mt-1 text-sm text-stone-500">
                    {t("userCenter.accountDesc")}
                </p>
            </div>

            <Card title={<span className="inline-flex items-center gap-2"><UserRound className="size-4" /> 个人信息</span>} className="border-stone-200 dark:border-stone-800">
                <Descriptions column={{ xs: 1, sm: 2 }} className="mb-4">
                    <Descriptions.Item label={t("userCenter.username")}>
                        <span className="font-mono font-medium">{user?.username}</span>
                    </Descriptions.Item>
                    <Descriptions.Item label={t("userCenter.role")}>
                        <Tag color={user?.role === "admin" ? "purple" : "blue"}>
                            {user?.role === "admin" ? t("userCenter.roleAdmin") : t("userCenter.roleUser")}
                        </Tag>
                    </Descriptions.Item>
                    <Descriptions.Item label={t("userCenter.createdAt")}>
                        <span className="font-mono text-xs text-stone-500">
                            {user?.createdAt ? dayjs(user.createdAt).format("YYYY-MM-DD HH:mm") : "-"}
                        </span>
                    </Descriptions.Item>
                    <Descriptions.Item label={t("userCenter.lastLoginAt")}>
                        <span className="font-mono text-xs text-stone-500">
                            {user?.lastLoginAt ? dayjs(user.lastLoginAt).format("YYYY-MM-DD HH:mm") : "-"}
                        </span>
                    </Descriptions.Item>
                </Descriptions>

                <div className="flex max-w-md items-center gap-3 border-t border-stone-100 pt-4 dark:border-stone-800/60">
                    <Input
                        value={displayName}
                        maxLength={80}
                        onChange={(e) => setDisplayName(e.target.value)}
                        placeholder={t("userCenter.displayName")}
                    />
                    <Button
                        type="primary"
                        icon={<Save className="size-4" />}
                        loading={profileLoading}
                        onClick={() => void handleUpdateProfile()}
                    >
                        {t("userCenter.updateProfile")}
                    </Button>
                </div>
            </Card>

            <Card title={<span className="inline-flex items-center gap-2"><Gift className="size-4" /> 每日签到</span>} className="flex flex-col border-stone-200 dark:border-stone-800" classNames={{ body: "flex flex-1 flex-col justify-center" }}>
                <div className="flex flex-wrap items-center justify-between gap-4">
                    <div>
                        <p className="text-sm">{reward?.enabled ? `今日随机奖励 ¥${reward.rewardMin} – ¥${reward.rewardMax}` : "签到奖励暂未开放"}</p>
                        <p className="mt-1 text-xs text-muted-foreground">每天按北京时间计算，领取后直接计入余额，永久保留。</p>
                    </div>
                    <Button type="primary" disabled={!reward?.enabled || reward.checkedIn} loading={claim.isPending} onClick={() => claim.mutate()}>{reward?.checkedIn ? "今天已签到" : "领取今日奖励"}</Button>
                </div>
            </Card>

            <Card title={<span className="inline-flex items-center gap-2"><Lock className="size-4" /> {t("userCenter.changePassword")}</span>} className="border-stone-200 dark:border-stone-800">
                <Form
                    form={passwordForm}
                    layout="vertical"
                    className="max-w-md"
                    onFinish={(values) => void handleChangePassword(values)}
                >
                    <Form.Item
                        name="currentPassword"
                        label={t("userCenter.currentPassword")}
                        rules={[{ required: true, message: "请输入当前密码" }]}
                    >
                        <Input.Password placeholder={t("userCenter.currentPassword")} />
                    </Form.Item>

                    <Form.Item
                        name="newPassword"
                        label={t("userCenter.newPassword")}
                        rules={[{ required: true, min: 10, message: "新密码至少 10 位" }]}
                    >
                        <Input.Password placeholder={t("userCenter.newPassword")} />
                    </Form.Item>

                    <Form.Item
                        name="confirmPassword"
                        label={t("userCenter.confirmPassword")}
                        rules={[{ required: true, message: "请确认新密码" }]}
                    >
                        <Input.Password placeholder={t("userCenter.confirmPassword")} />
                    </Form.Item>

                    <Form.Item className="mb-0">
                        <Button type="primary" htmlType="submit" loading={passwordLoading} icon={<ShieldCheck className="size-4" />}>
                            {t("userCenter.changePassword")}
                        </Button>
                    </Form.Item>
                </Form>
            </Card>
            <SecuritySettings />
        </div>
    );
}

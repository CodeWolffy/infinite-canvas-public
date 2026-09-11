import { useState } from "react";
import { Alert, App, Button, Form, Input } from "antd";
import { Check, KeyRound, LogOut } from "lucide-react";
import { Navigate, useLocation, useNavigate } from "react-router-dom";

import { useUserStore } from "@/stores/use-user-store";
import { authReturnPath } from "@/lib/auth-return-path";

type PasswordValues = { currentPassword: string; newPassword: string; confirmPassword: string };

export default function ChangePasswordPage() {
    const { message } = App.useApp();
    const navigate = useNavigate();
    const location = useLocation();
    const target = authReturnPath((location.state as { from?: string } | null)?.from);
    const user = useUserStore((state) => state.user);
    const changePassword = useUserStore((state) => state.changePassword);
    const logout = useUserStore((state) => state.logout);
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState("");

    if (user && !user.mustChangePassword) return <Navigate to={target} replace />;

    const submit = async ({ currentPassword, newPassword }: PasswordValues) => {
        setSubmitting(true);
        setError("");
        try {
            await changePassword({ currentPassword, newPassword });
            message.success("密码已更新");
            navigate(target, { replace: true });
        } catch (reason) {
            setError(reason instanceof Error ? reason.message : "密码修改失败");
        } finally {
            setSubmitting(false);
        }
    };

    return (
        <main className="grid h-dvh place-items-center overflow-y-auto bg-background bg-[radial-gradient(#e5e7eb_1px,transparent_1px)] px-5 py-10 [background-size:18px_18px] dark:bg-[radial-gradient(rgba(245,245,244,.12)_1px,transparent_1px)]">
            <section className="w-full max-w-md rounded-2xl border border-stone-200 bg-background p-6 shadow-[0_24px_80px_rgba(28,25,23,.08)] sm:p-9 dark:border-stone-800 dark:shadow-[0_24px_80px_rgba(0,0,0,.3)]">
                <div className="flex size-11 items-center justify-center rounded-xl bg-stone-950 text-white dark:bg-stone-100 dark:text-stone-950"><KeyRound className="size-5" /></div>
                <h1 className="mt-6 text-2xl font-semibold tracking-[-0.03em] text-stone-950 dark:text-stone-100">设置你的新密码</h1>
                <p className="mt-2 text-sm leading-6 text-stone-500 dark:text-stone-400">这是首次登录的必要步骤。新密码至少 10 位，修改后即可进入工作台。</p>
                {error ? <Alert className="mt-5" type="error" showIcon message={error} /> : null}
                <Form<PasswordValues> layout="vertical" requiredMark={false} className="mt-7" onFinish={(values) => void submit(values)}>
                    <Form.Item name="currentPassword" label="当前临时密码" rules={[{ required: true, message: "请输入当前临时密码" }]}>
                        <Input.Password size="large" autoComplete="current-password" />
                    </Form.Item>
                    <Form.Item name="newPassword" label="新密码" rules={[{ required: true, message: "请输入新密码" }, { min: 10, message: "新密码至少需要 10 位" }]}>
                        <Input.Password size="large" autoComplete="new-password" />
                    </Form.Item>
                    <Form.Item name="confirmPassword" label="确认新密码" dependencies={["newPassword"]} rules={[{ required: true, message: "请再次输入新密码" }, ({ getFieldValue }) => ({ validator(_, value) { return !value || getFieldValue("newPassword") === value ? Promise.resolve() : Promise.reject(new Error("两次输入的密码不一致")); } })]}>
                        <Input.Password size="large" autoComplete="new-password" />
                    </Form.Item>
                    <Button type="primary" size="large" htmlType="submit" loading={submitting} block icon={<Check className="size-4" />}>保存并进入平台</Button>
                </Form>
                <button type="button" className="mx-auto mt-5 flex items-center gap-2 text-xs text-stone-500 transition hover:text-stone-950 dark:hover:text-stone-100" onClick={() => void logout()}><LogOut className="size-3.5" />退出登录</button>
            </section>
        </main>
    );
}

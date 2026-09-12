import { useEffect, useState } from "react";
import { Alert, Button, Form, Input } from "antd";
import { ArrowRight, LockKeyhole, UserRound } from "lucide-react";
import { Link, Navigate, useLocation, useNavigate } from "react-router-dom";

import { AnimatedThemeToggler } from "@/components/ui/animated-theme-toggler";
import { useThemeStore } from "@/stores/use-theme-store";
import { useUserStore } from "@/stores/use-user-store";
import { authReturnPath } from "@/lib/auth-return-path";

type LoginValues = { username: string; password: string; displayName?: string; invitationCode?: string; code?: string; referralCode?: string };

export default function LoginPage() {
    const navigate = useNavigate();
    const location = useLocation();
    const target = authReturnPath((location.state as { from?: string } | null)?.from);
    const theme = useThemeStore((state) => state.theme);
    const setTheme = useThemeStore((state) => state.setTheme);
    const user = useUserStore((state) => state.user);
    const status = useUserStore((state) => state.status);
    const initialize = useUserStore((state) => state.initialize);
    const login = useUserStore((state) => state.login);
    const completeMfa = useUserStore((state) => state.completeMfa);
    const register = useUserStore((state) => state.register);
    const referralCode = new URLSearchParams(location.search).get("ref") || "";
    const [registering, setRegistering] = useState(Boolean(referralCode));
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState("");
    const [challenge, setChallenge] = useState("");

    useEffect(() => {
        void initialize();
    }, [initialize]);

    if (user) return <Navigate to={user.mustChangePassword ? "/change-password" : target} replace state={{ from: target }} />;

    const submit = async (values: LoginValues) => {
        setSubmitting(true);
        setError("");
        try {
            const loggedInUser = challenge ? await completeMfa({ challenge, code: values.code || "" }) : registering
                ? await register({ ...values, displayName: values.displayName || "", invitationCode: values.invitationCode || "" })
                : await login(values);
            if ("mfaRequired" in loggedInUser) { setChallenge(loggedInUser.challenge); return; }
            navigate(loggedInUser.mustChangePassword ? "/change-password" : target, { replace: true, state: { from: target } });
        } catch (reason) {
            setError(reason instanceof Error ? reason.message : "登录失败，请稍后重试");
        } finally {
            setSubmitting(false);
        }
    };

    return (
        <main className="relative grid h-dvh overflow-y-auto bg-background px-5 py-8 text-foreground lg:grid-cols-[minmax(0,1.1fr)_minmax(420px,.9fr)] lg:p-4">
            <section className="relative hidden overflow-hidden rounded-2xl bg-stone-950 p-12 text-white lg:flex lg:flex-col lg:justify-between dark:bg-stone-900">
                <div className="absolute inset-0 opacity-60 [background-image:radial-gradient(circle_at_20%_20%,rgba(255,255,255,.18),transparent_28%),radial-gradient(circle_at_80%_70%,rgba(168,162,158,.25),transparent_30%)]" />
                <div className="relative flex items-center gap-3 text-sm font-medium tracking-wide">
                    <span className="size-6 bg-white" style={{ mask: "url(/logo.svg) center / contain no-repeat", WebkitMask: "url(/logo.svg) center / contain no-repeat" }} />
                    INFINITE CANVAS
                </div>
                <div className="relative max-w-xl">
                    <p className="mb-5 text-xs font-semibold uppercase tracking-[0.28em] text-stone-400">开放灵感，自由创作</p>
                    <h1 className="text-5xl font-semibold leading-[1.08] tracking-[-0.045em]">把灵感、生成与画布，收进同一个工作空间。</h1>
                    <p className="mt-7 max-w-lg text-base leading-7 text-stone-400">图片、视频、文本与声音，在这里一起生长。签到领取创作余额，选择模型即可开始。</p>
                </div>
            </section>

            <section className="relative flex items-center justify-center px-1 py-8 sm:px-10 lg:px-16">
                <AnimatedThemeToggler theme={theme} onThemeChange={setTheme} className="absolute right-1 top-0 inline-flex size-9 items-center justify-center rounded-lg text-stone-500 transition hover:bg-stone-100 dark:hover:bg-stone-800 sm:right-10 sm:top-6" aria-label="切换主题" />
                <div className="w-full max-w-sm">
                    <div className="mb-10 lg:hidden"><span className="inline-flex items-center gap-2 text-sm font-semibold"><span className="size-5 bg-current" style={{ mask: "url(/logo.svg) center / contain no-repeat", WebkitMask: "url(/logo.svg) center / contain no-repeat" }} />Infinite Canvas</span></div>
                    <p className="text-xs font-semibold uppercase tracking-[0.22em] text-stone-400">欢迎回来</p>
                    <h2 className="mt-3 text-3xl font-semibold tracking-[-0.035em] text-stone-950 dark:text-stone-100">{challenge ? "完成两步验证" : registering ? "加入创作平台" : "登录创作平台"}</h2>
                    <p className="mt-3 text-sm leading-6 text-stone-500 dark:text-stone-400">{registering ? "使用邀请码注册，开启你的创作空间。" : "登录后继续你的创作，也可以使用邀请码加入。"}</p>
                    {error || status === "error" ? <Alert className="mt-6" type="error" showIcon message={error || "暂时无法连接到平台服务"} /> : null}
                    <Form<LoginValues> layout="vertical" requiredMark={false} className="mt-8" initialValues={{ referralCode }} onFinish={(values) => void submit(values)}>
                        {challenge ? <><Form.Item name="code" label="验证码或恢复码" rules={[{ required: true, message: "请输入验证器中的验证码" }]}><Input size="large" autoComplete="one-time-code" autoFocus placeholder="输入最新验证码" /></Form.Item><p className="mb-5 text-xs leading-5 text-muted-foreground">使用验证器中的 6 位验证码。恢复码只能使用一次，使用后会关闭两步验证，请重新绑定验证器。</p></> : <>
                        <Form.Item name="username" label="用户名" rules={[{ required: true, message: "请输入用户名" }]}>
                            <Input size="large" prefix={<UserRound className="size-4 text-stone-400" />} autoComplete="username" placeholder="请输入用户名" autoFocus />
                        </Form.Item>
                        {registering ? <Form.Item name="displayName" label="昵称" rules={[{ required: true, message: "请输入昵称" }, { max: 80 }]}><Input size="large" autoComplete="nickname" placeholder="创作时使用的名字" /></Form.Item> : null}
                        <Form.Item name="password" label="密码" rules={[{ required: true, message: "请输入密码" }, ...(registering ? [{ min: 10, max: 128, message: "密码需为 10–128 个字符" }] : [])]}>
                            <Input.Password size="large" prefix={<LockKeyhole className="size-4 text-stone-400" />} autoComplete={registering ? "new-password" : "current-password"} placeholder="请输入密码" />
                        </Form.Item>
                        {registering ? <Form.Item name="invitationCode" label="邀请码" rules={[{ required: true, message: "请输入邀请码" }]}><Input size="large" autoComplete="off" placeholder="请输入管理员提供的邀请码" /></Form.Item> : null}
                        {registering ? <Form.Item name="referralCode" label="好友推荐码（选填）" extra="推荐码用于记录邀请关系，注册仍需填写上方邀请码。"><Input autoComplete="off" placeholder="通过好友推荐链接可自动填入" /></Form.Item> : null}
                        </>}
                        <Button type="primary" size="large" htmlType="submit" loading={submitting || status === "loading"} block className="mt-2" iconPlacement="end" icon={<ArrowRight className="size-4" />}>{challenge ? "验证并登录" : registering ? "注册并开始创作" : "登录"}</Button>
                    </Form>
                    {challenge ? <Button type="link" block className="mt-4" disabled={submitting} onClick={() => { setChallenge(""); setError(""); }}>返回账号密码登录</Button> : (
                        <div className="mt-4 flex items-center justify-center gap-6 text-sm">
                            <Button type="link" size="small" className="px-0" disabled={submitting} onClick={() => { setRegistering((value) => !value); setError(""); }}>{registering ? "已有账号，返回登录" : "注册"}</Button>
                            {!registering ? <Link to="/forgot-password" className="text-muted-foreground hover:text-foreground">忘记密码</Link> : null}
                        </div>
                    )}
                    <div className="mt-5 text-center text-xs"><Link to="/status" className="text-muted-foreground hover:text-foreground">查看模型运行状态</Link></div>
                </div>
            </section>
        </main>
    );
}

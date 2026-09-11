import { useState } from "react";
import { Alert, Button, Form, Input } from "antd";
import { ArrowLeft, ShieldCheck } from "lucide-react";
import { Link, useLocation, useSearchParams } from "react-router-dom";

import { completePasswordReset, requestPasswordReset, verifyEmail } from "@/services/api/platform-operations";

export default function AccountRecoveryPage() {
    const location = useLocation();
    const [search] = useSearchParams();
    const mode = location.pathname === "/verify-email" ? "email" : location.pathname === "/reset-password" ? "reset" : "request";
    const token = search.get("token") || "";
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const [done, setDone] = useState("");
    const submit = async (values: { email?: string; password?: string }) => {
        setBusy(true); setError("");
        try {
            const result = mode === "request" ? await requestPasswordReset(values.email || "") : mode === "reset" ? await completePasswordReset(token, values.password || "") : await verifyEmail(token);
            setDone(result.message);
            if (mode !== "request") window.history.replaceState(null, "", location.pathname);
        } catch (reason) { setError(reason instanceof Error ? reason.message : "操作失败，请稍后重试"); }
        finally { setBusy(false); }
    };
    return <main className="grid min-h-dvh place-items-center bg-background px-5 py-12 text-foreground"><section className="w-full max-w-md">
        <ShieldCheck className="mb-7 size-7 text-muted-foreground" />
        <h1 className="text-3xl font-semibold tracking-tight">{mode === "email" ? "验证邮箱" : mode === "reset" ? "设置新密码" : "找回账号密码"}</h1>
        <p className="mb-8 mt-3 text-sm leading-6 text-muted-foreground">{mode === "request" ? "使用账号已验证的邮箱接收重置链接。尚未绑定邮箱时，请联系管理员重置密码。" : "链接 30 分钟内有效，仅可使用一次。"}</p>
        {error ? <Alert className="mb-5" type="error" showIcon title={error} /> : null}
        {done ? <Alert type="success" showIcon title={done} /> : <Form layout="vertical" onFinish={(values) => void submit(values)}>
            {mode === "request" ? <Form.Item name="email" label="已验证邮箱" rules={[{ required: true, type: "email", message: "请输入有效邮箱" }]}><Input autoComplete="email" size="large" /></Form.Item> : null}
            {mode === "reset" ? <><Form.Item name="password" label="新密码" rules={[{ required: true, min: 10, max: 128, message: "密码需为 10–128 个字符" }]}><Input.Password autoComplete="new-password" size="large" /></Form.Item><Form.Item name="confirm" label="确认新密码" dependencies={["password"]} rules={[{ required: true }, ({ getFieldValue }) => ({ validator: (_, value) => value === getFieldValue("password") ? Promise.resolve() : Promise.reject(new Error("两次密码不一致")) })]}><Input.Password autoComplete="new-password" size="large" /></Form.Item></> : null}
            <Button type="primary" htmlType="submit" size="large" block loading={busy} disabled={mode !== "request" && !token}>{mode === "request" ? "发送重置链接" : mode === "email" ? "确认验证邮箱" : "更新密码"}</Button>
        </Form>}
        <Link to="/login" replace className="mt-7 inline-flex items-center gap-2 text-sm text-muted-foreground"><ArrowLeft className="size-4" />返回登录</Link>
    </section></main>;
}

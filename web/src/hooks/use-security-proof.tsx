import { useEffect, useState } from "react";
import { Form, Input, Modal } from "antd";

import { getAccountSecurity, type SecurityProof } from "@/services/api/platform-operations";

export type { SecurityProof };

let openProof: (() => void) | null = null;
let settle: { resolve: (proof: SecurityProof) => void; reject: (error: Error) => void } | null = null;

/**
 * 高危管理操作前收集管理员密码（已启用两步验证时还要验证码）。
 * 弹窗由 SecurityProofProvider 渲染，所以调用方只要 await 即可。
 */
export function requestSecurityProof(): Promise<SecurityProof> {
    if (!openProof) return Promise.reject(new Error("安全验证弹窗尚未就绪，请刷新页面重试"));
    return new Promise((resolve, reject) => {
        settle = { resolve, reject };
        openProof?.();
    });
}

export function useSecurityProof() {
    return { requestProof: requestSecurityProof };
}

export function SecurityProofProvider() {
    const [open, setOpen] = useState(false);
    const [mfaEnabled, setMfaEnabled] = useState(false);
    const [form] = Form.useForm<SecurityProof>();

    useEffect(() => {
        openProof = () => {
            form.resetFields();
            setOpen(true);
            void getAccountSecurity()
                .then(({ security }) => setMfaEnabled(security.mfaEnabled))
                .catch(() => setMfaEnabled(false));
        };
        return () => {
            openProof = null;
        };
    }, [form]);

    const close = (proof?: SecurityProof) => {
        setOpen(false);
        const pending = settle;
        settle = null;
        if (!pending) return;
        if (proof) pending.resolve(proof);
        else pending.reject(new Error("已取消安全验证"));
    };

    return (
        <Modal
            open={open}
            title="安全验证"
            okText="确认"
            cancelText="取消"
            destroyOnHidden
            onOk={async () => {
                try {
                    close(await form.validateFields());
                } catch {
                    // 校验不通过时保持弹窗打开，让管理员补齐。
                }
            }}
            onCancel={() => close()}
        >
            <p className="mb-4 text-sm leading-6 text-muted-foreground">
                该操作会影响账号安全或资金，请再次输入当前密码确认{mfaEnabled ? "，并填写验证器验证码" : ""}。
            </p>
            <Form form={form} layout="vertical" requiredMark={false}>
                <Form.Item name="password" label="当前密码" rules={[{ required: true, message: "请输入当前密码" }]}>
                    <Input.Password autoComplete="current-password" />
                </Form.Item>
                {mfaEnabled ? (
                    <Form.Item name="code" label="验证器验证码" rules={[{ required: true, message: "请输入验证码" }]}>
                        <Input autoComplete="one-time-code" />
                    </Form.Item>
                ) : null}
            </Form>
        </Modal>
    );
}

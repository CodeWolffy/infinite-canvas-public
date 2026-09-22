// 与后端 validatePassword 保持一致的密码强度规则，避免只在服务端报错。
export const PASSWORD_MIN_LENGTH = 10;
export const PASSWORD_MAX_LENGTH = 128;

export function passwordIssues(password: string, username?: string): string[] {
    const issues: string[] = [];
    if (password.length < PASSWORD_MIN_LENGTH || password.length > PASSWORD_MAX_LENGTH) {
        issues.push(`密码长度需为 ${PASSWORD_MIN_LENGTH}–${PASSWORD_MAX_LENGTH} 位`);
    }
    if (username && password.toLowerCase() === username.trim().toLowerCase()) {
        issues.push("密码不能与用户名相同");
    }
    if (password && new Set(password).size === 1) {
        issues.push("密码不能全部是同一个字符");
    }
    const classes = [/[A-Za-z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((pattern) => pattern.test(password)).length;
    if (password && classes < 2) {
        issues.push("密码需至少包含字母、数字、符号中的两类");
    }
    return issues;
}

export const PASSWORD_HINT = `至少 ${PASSWORD_MIN_LENGTH} 位，需包含字母、数字、符号中的两类，且不能与用户名相同`;

export function passwordRule(username?: string) {
    return {
        validator(_rule: unknown, value: string) {
            const issues = passwordIssues(value || "", username);
            return issues.length ? Promise.reject(new Error(issues[0])) : Promise.resolve();
        },
    };
}

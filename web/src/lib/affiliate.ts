const STORAGE_KEYS = {
    AFFILIATE: "aff",
} as const;

export function getAffiliateCode(): string {
    if (typeof window === "undefined") return "";
    try {
        return window.localStorage.getItem(STORAGE_KEYS.AFFILIATE) ?? "";
    } catch {
        return "";
    }
}

// 从 URL 查询串解析邀请码（兼容 new-api ?aff= 与旧 ?ref=），不做任何存储。
export function affiliateCodeFromSearch(search: string): string {
    const params = new URLSearchParams(search);
    return (params.get("aff") || params.get("ref") || "").trim();
}

// 解析并暂存邀请码，返回解析结果。
export function takeAffiliateCodeFromSearch(search: string): string {
    const code = affiliateCodeFromSearch(search);
    if (code) {
        saveAffiliateCode(code);
    }
    return code;
}

export function saveAffiliateCode(code: string): void {
    if (typeof window === "undefined") return;
    const clean = code.trim();
    if (!clean) return;
    try {
        window.localStorage.setItem(STORAGE_KEYS.AFFILIATE, clean);
    } catch {}
}

export function clearAffiliateCode(): void {
    if (typeof window === "undefined") return;
    try {
        window.localStorage.removeItem(STORAGE_KEYS.AFFILIATE);
    } catch {}
}

export function generateAffiliateLink(code: string): string {
    if (typeof window === "undefined") return `/sign-up?aff=${code}`;
    return `${window.location.origin}/sign-up?aff=${code}`;
}

/** 服务端金额为十进制元字符串，直接去尾零，避免浮点转换丢失微元精度。 */
export function formatMoney(value?: string | number | null): string {
    if (value == null) return "—";
    const amount = typeof value === "number" ? Number.isFinite(value) ? value.toLocaleString("en-US", { useGrouping: false, maximumFractionDigits: 6 }) : "" : value.trim();
    if (!/^-?\d+(?:\.\d+)?$/.test(amount)) return "—";
    return `¥${amount.replace(/(\.\d*?[1-9])0+$|\.0+$/, "$1")}`;
}

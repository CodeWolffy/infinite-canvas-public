import { apiRequest } from "@/services/api/request";

export type AssetScope = "private" | "public";
export type AssetType = "image" | "text" | "video" | "audio";

export type AssetRecord = {
    id: string;
    ownerId: string;
    scope: AssetScope;
    type: AssetType;
    title: string;
    content: string | null;
    mediaId: string | null;
    metadata: Record<string, unknown>;
    createdAt: string;
    updatedAt: string;
};

export type AssetInput = {
    scope?: AssetScope;
    type: AssetType;
    title: string;
    content?: string | null;
    mediaId?: string | null;
    metadata?: Record<string, unknown>;
};

export const ASSET_PAGE_SIZE = 100;
export const MAX_LISTED_ASSETS = 1000;

/**
 * 接口已分页（单页最多 200 条）。这里按页拉满，最多 MAX_LISTED_ASSETS 条后停止，
 * 避免一次性把全站公共素材全部下发。返回条数达到上限即代表被截断。
 */
export async function listAssets(scope: AssetScope | "all" = "all") {
    const all: AssetRecord[] = [];
    while (all.length < MAX_LISTED_ASSETS) {
        const page = (
            await apiRequest<{ assets: AssetRecord[] }>(
                `/api/assets?scope=${scope}&limit=${ASSET_PAGE_SIZE}&offset=${all.length}`,
            )
        ).assets;
        all.push(...page);
        if (page.length < ASSET_PAGE_SIZE) break;
    }
    return all;
}

export type AssetPageQuery = { page: number; size: number; scope?: AssetScope | "all"; kind?: AssetType | "all"; keyword?: string };

/** 素材页的服务端分页：筛选与分页都在后端执行，返回总数供表格分页使用。 */
export async function listAssetPage(query: AssetPageQuery) {
    const params = new URLSearchParams({ limit: String(query.size), offset: String((query.page - 1) * query.size) });
    if (query.scope && query.scope !== "all") params.set("scope", query.scope);
    if (query.kind && query.kind !== "all") params.set("kind", query.kind);
    if (query.keyword?.trim()) params.set("keyword", query.keyword.trim());
    return await apiRequest<{ assets: AssetRecord[]; total: number }>(`/api/assets?${params}`);
}

/** 画布侧栏只需要最近一批素材，不再把全量素材拉进内存。 */
export async function listRecentAssets(scope: AssetScope | "all" = "all") {
    return (await listAssetPage({ page: 1, size: ASSET_PAGE_SIZE, scope })).assets;
}

export async function createAsset(input: AssetInput) {
    return (await apiRequest<{ asset: AssetRecord }>("/api/assets", { method: "POST", body: input })).asset;
}

export async function updateAsset(id: string, input: Partial<AssetInput>) {
    return (await apiRequest<{ asset: AssetRecord }>(`/api/assets/${id}`, { method: "PUT", body: input })).asset;
}

export async function deleteAsset(id: string) {
    await apiRequest<void>(`/api/assets/${id}`, { method: "DELETE" });
}

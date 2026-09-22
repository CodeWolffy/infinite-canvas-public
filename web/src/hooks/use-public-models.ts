import { useQuery } from "@tanstack/react-query";

import { queryClient } from "@/components/layout/app-providers";
import { getPublicModels } from "@/services/api/generation";
import { useUserStore } from "@/stores/use-user-store";

/** 平台模型列表按登录会话隔离缓存，切换账号后自动失效。 */
export const publicModelsQueryKey = (sessionVersion: number) => ["public-models", sessionVersion] as const;

export function usePublicModels() {
    const sessionVersion = useUserStore((state) => state.sessionVersion);
    return useQuery({ queryKey: publicModelsQueryKey(sessionVersion), queryFn: getPublicModels, staleTime: 60_000 });
}

/** 非组件代码（services、store、agent 工具）走同一个查询缓存，不再各自发请求。 */
export function fetchPublicModels() {
    return queryClient.fetchQuery({ queryKey: publicModelsQueryKey(useUserStore.getState().sessionVersion), queryFn: getPublicModels, staleTime: 60_000 });
}

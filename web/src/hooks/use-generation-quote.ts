import { useDeferredValue } from "react";
import { useQuery } from "@tanstack/react-query";

import { quoteGeneration } from "@/services/api/platform-operations";
import { assertCurrentSession, useUserStore } from "@/stores/use-user-store";

export function useGenerationQuote(input: Parameters<typeof quoteGeneration>[0], enabled = true) {
    const sessionVersion = useUserStore((state) => state.sessionVersion);
    const content = useDeferredValue(input.content);
    const active = enabled && Boolean(input.modelId && input.content.trim());
    const query = useQuery({
        queryKey: ["generation-quote", sessionVersion, { ...input, content }],
        queryFn: async ({ signal }) => {
            assertCurrentSession(sessionVersion);
            const result = await quoteGeneration({ ...input, content }, signal);
            assertCurrentSession(sessionVersion);
            return result;
        },
        enabled: active && Boolean(content.trim()),
        gcTime: 0,
    });
    const current = active && content === input.content;
    return {
        quote: current && !query.isFetching && !query.isError ? query.data?.quote : undefined,
        error: current ? query.error : null,
        isFetching: active && (!current || query.isFetching),
        ready: current && Boolean(query.data && !query.isFetching && !query.isError),
    };
}

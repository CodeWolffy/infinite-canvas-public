import { useMemo, useState } from "react";
import { APP_VERSION } from "@/constant/env";
import type { ReleaseInfo } from "@/lib/release";

// 版本信息全部来自构建时内嵌的本地 CHANGELOG，不再请求上游仓库。
function readLocalReleases(): ReleaseInfo[] {
    return __APP_RELEASES__ || [];
}

export function useVersionCheck() {
    const [open, setOpen] = useState(false);
    const releases = useMemo(readLocalReleases, []);

    return {
        open,
        setOpen,
        openReleaseModal: () => setOpen(true),
        currentVersion: APP_VERSION,
        releases,
    };
}

import { App } from "antd";
import { useTranslation } from "react-i18next";

import { useAssetStore } from "@/stores/use-asset-store";
import { useUserStore } from "@/stores/use-user-store";

export function useSaveToAssets() {
    const { message } = App.useApp();
    const { t } = useTranslation();
    const addAsset = useAssetStore((state) => state.addAsset);

    return async (draft: Parameters<typeof addAsset>[0]) => {
        const session = useUserStore.getState().sessionVersion;
        try {
            const id = await addAsset(draft);
            if (useUserStore.getState().sessionVersion !== session) return;
            message.success(t("common.addedToAssets"));
            return id;
        } catch (error) {
            if (useUserStore.getState().sessionVersion === session) message.error(error instanceof Error ? error.message : "素材保存失败");
        }
    };
}

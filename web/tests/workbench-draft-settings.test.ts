import { expect, test, vi } from "vitest";

vi.mock("@/hooks/use-public-models", () => ({ fetchPublicModels: vi.fn() }));
vi.mock("@/stores/use-user-store", () => ({ useUserStore: { getState: () => ({ sessionVersion: 1 }), subscribe: () => () => undefined }, assertCurrentSession: vi.fn() }));

import { defaultConfig } from "@/stores/use-config-store";
import { readImageDraftSettings } from "@/pages/image/creation-draft";
import { readVideoDraftSettings } from "@/pages/video/creation-draft";

test("图片草稿尺寸沿用现有比例和分辨率预设，4K 正方形保持合法尺寸", () => {
    expect(readImageDraftSettings({ size: "1K", count: "4" }, { ...defaultConfig, size: "2048x1152" })).toEqual({ settings: { size: "1536x864", count: "4" }, warnings: [] });
    expect(readImageDraftSettings({ size: "4k" }, { ...defaultConfig, size: "auto" }).settings.size).toBe("2880x2880");
    expect(readImageDraftSettings({ size: "2:3" }, { ...defaultConfig, size: "2048x2048" }).settings.size).toBe("1360x2048");
});

test("不明确尺寸、非法像素或超出原张数范围的草稿不覆盖当前配置", () => {
    const config = { ...defaultConfig, size: "2048x2048", count: "3" };
    for (const size of ["4K 高清", "1024x0", "999999x999999", "7:4"]) {
        expect(readImageDraftSettings({ size, count: "21" }, config)).toEqual({ settings: {}, warnings: ["图片尺寸", "生成张数"] });
    }
    expect(config).toMatchObject({ size: "2048x2048", count: "3" });
});

test("视频草稿使用现有尺寸计算和时长区间，不添加新的范围", () => {
    expect(readVideoDraftSettings({ vquality: "1080p", size: "9:16", videoSeconds: "12", videoMode: "reference" }, defaultConfig)).toEqual({ settings: { vquality: "1080", size: "1080x1920", videoSeconds: "12", videoMode: "reference" }, warnings: [] });
    expect(readVideoDraftSettings({ vquality: "4K 高清", size: "未知", videoSeconds: "31", videoMode: "other" }, defaultConfig)).toEqual({ settings: {}, warnings: ["视频分辨率", "视频尺寸", "视频时长", "视频模式"] });
});

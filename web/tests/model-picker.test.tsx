import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, expect, test, vi } from "vitest";

vi.mock("@/services/api/models", () => ({ listModels: async () => [] }));
vi.mock("@/stores/use-user-store", () => ({
    useUserStore: {
        getState: () => ({ sessionVersion: 1, user: { id: "user-1" } }),
        subscribe: () => () => undefined,
        persist: undefined,
    },
}));

const { ModelPicker } = await import("@/components/model-picker");
const { useConfigStore, defaultConfig } = await import("@/stores/use-config-store");
type AiConfig = import("@/stores/use-config-store").AiConfig;

const platformConfig = (): AiConfig => ({
    ...defaultConfig,
    platformModels: [
        { name: "img-1", displayName: "图像模型", capability: "image", price: "0.1" },
        { name: "txt-1", displayName: "文本模型", capability: "text" },
    ],
    models: ["platform::img-1", "platform::txt-1"],
});

beforeAll(() => {
    // Radix Select 在 jsdom 下需要 pointer capture 相关 API。
    Element.prototype.hasPointerCapture ??= () => false;
    Element.prototype.setPointerCapture ??= () => undefined;
    Element.prototype.releasePointerCapture ??= () => undefined;
    Element.prototype.scrollIntoView ??= () => undefined;
});

afterEach(cleanup);

test("ModelPicker 显示当前模型并按能力过滤候选列表", async () => {
    useConfigStore.setState({ config: platformConfig() });
    const { container } = render(<ModelPicker config={platformConfig()} value="platform::img-1" onChange={() => undefined} capability="image" />);
    expect(container.textContent).toContain("图像模型");

    const user = userEvent.setup();
    await user.click(screen.getAllByRole("combobox")[0]);
    const options = await screen.findAllByRole("option");
    const labels = options.map((option) => option.textContent || "");
    expect(labels.some((label) => label.includes("图像模型"))).toBe(true);
    // capability=image 时文本模型不应出现在候选里。
    expect(labels.some((label) => label.includes("文本模型"))).toBe(false);
});

test("选择候选项会回调编码后的模型值", async () => {
    useConfigStore.setState({ config: platformConfig() });
    const changed: string[] = [];
    const user = userEvent.setup();
    render(<ModelPicker config={platformConfig()} value="platform::img-1" onChange={(value) => changed.push(value)} />);
    await user.click(screen.getAllByRole("combobox")[0]);
    const options = await screen.findAllByRole("option");
    await user.click(options.find((option) => (option.textContent || "").includes("文本模型"))!);
    expect(changed).toEqual(["platform::txt-1"]);
});

test("没有可用模型时点击会提示配置渠道", async () => {
    const empty = { ...defaultConfig, platformModels: [], models: [] };
    useConfigStore.setState({ config: empty });
    let missing = 0;
    const user = userEvent.setup();
    render(<ModelPicker config={empty} value="" onChange={() => undefined} onMissingConfig={() => (missing += 1)} />);
    await user.click(screen.getAllByRole("combobox")[0]);
    expect(missing).toBe(1);
});

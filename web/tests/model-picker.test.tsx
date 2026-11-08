import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, expect, test, vi } from "vitest";

vi.mock("@/services/api/models", () => ({ listModels: async () => [] }));
const account = vi.hoisted(() => ({ role: "user" }));
vi.mock("@/stores/use-user-store", () => ({
    useUserStore: Object.assign((select: (value: { user: { role: string } }) => unknown) => select({ user: account }), {
        getState: () => ({ sessionVersion: 1, user: { id: "user-1" } }),
        subscribe: () => () => undefined,
        persist: undefined,
    }),
}));

const { ModelPicker } = await import("@/components/model-picker");
const { initI18n } = await import("@/i18n");
const { useConfigStore, defaultConfig } = await import("@/stores/use-config-store");
type AiConfig = import("@/stores/use-config-store").AiConfig;

const platformConfig = (): AiConfig => ({
    ...defaultConfig,
    platformModels: [
        { name: "img-1", modelName: "gpt-image-one", displayName: "图像模型", description: "擅长文字排版和多参考图编辑", capability: "image", price: "0.1" },
        { name: "txt-1", displayName: "文本模型", capability: "text" },
    ],
    models: ["platform::img-1", "platform::txt-1"],
});

beforeAll(async () => {
    Object.defineProperty(window, "matchMedia", { configurable: true, value: () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }) });
    Element.prototype.hasPointerCapture ??= () => false;
    Element.prototype.setPointerCapture ??= () => undefined;
    Element.prototype.releasePointerCapture ??= () => undefined;
    Element.prototype.scrollIntoView ??= () => undefined;
    vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
    await initI18n();
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

test("普通用户没有可用模型时提示联系管理员", async () => {
    const empty = { ...defaultConfig, platformModels: [], models: [] };
    useConfigStore.setState({ config: empty });
    let missing = 0;
    const user = userEvent.setup();
    render(<ModelPicker config={empty} value="" onChange={() => undefined} onMissingConfig={() => (missing += 1)} />);
    await user.click(screen.getAllByRole("combobox")[0]);
    expect(missing).toBe(1);
    expect(screen.getByText("暂无可用模型，请联系管理员开放模型")).toBeInTheDocument();
});

test("原始 UUID 可以显示名称并选中对应的编码候选", async () => {
    const user = userEvent.setup();
    const config = platformConfig();
    render(<ModelPicker config={config} value="img-1" onChange={() => undefined} capability="image" />);
    expect(screen.getByText("图像模型")).toBeInTheDocument();
    expect(screen.queryByText("已选模型不可用")).not.toBeInTheDocument();
    await user.click(screen.getByRole("combobox"));
    const selected = (await screen.findAllByRole("option")).find((option) => option.textContent?.includes("图像模型"))!;
    expect(selected).toHaveAttribute("aria-selected", "true");
});

test("模型候选显示服务端简介和单价，并按展示名及原始模型名搜索", async () => {
    const user = userEvent.setup();
    render(<ModelPicker config={platformConfig()} value="img-1" onChange={() => undefined} />);
    await user.click(screen.getByRole("combobox"));
    expect(await screen.findByText("适用说明：擅长文字排版和多参考图编辑")).toBeInTheDocument();
    expect(screen.getByText("单价 ¥0.1 / 张")).toBeInTheDocument();
    await user.type(screen.getByRole("combobox"), "GPT-IMAGE");
    expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual([expect.stringContaining("图像模型")]);
    await user.clear(screen.getByRole("combobox"));
    await user.type(screen.getByRole("combobox"), "文本");
    expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual([expect.stringContaining("文本模型")]);
    await user.clear(screen.getByRole("combobox"));
    await user.type(screen.getByRole("combobox"), "排版");
    expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual([expect.stringContaining("图像模型")]);
});

test.each(["mouse", "touch", "pen"])("画布拦截 %s 指针事件时仍收起菜单且不改模型", async (pointerType) => {
    const changed = vi.fn();
    const gesture = vi.fn();
    render(<><ModelPicker config={platformConfig()} value="img-1" onChange={changed} /><div data-testid="canvas" onPointerDown={(event) => { event.preventDefault(); event.stopPropagation(); gesture(); }} /></>);
    const picker = screen.getByRole("combobox");
    await userEvent.setup().click(picker);
    expect(picker).toHaveAttribute("aria-expanded", "true");
    fireEvent.pointerDown(screen.getByTestId("canvas"), { pointerType, pointerId: 1, button: 0 });
    expect(picker).toHaveAttribute("aria-expanded", "false");
    expect(picker).not.toHaveFocus();
    expect(gesture).toHaveBeenCalledOnce();
    expect(changed).not.toHaveBeenCalled();
});

test("画布滚轮收起菜单但保留原缩放事件", async () => {
    const zoom = vi.fn();
    render(<><ModelPicker config={platformConfig()} value="img-1" onChange={vi.fn()} /><div data-testid="canvas" onWheel={(event) => { event.stopPropagation(); zoom(event.deltaY); }} /></>);
    const picker = screen.getByRole("combobox");
    await userEvent.setup().click(picker);
    fireEvent.wheel(screen.getByTestId("canvas"), { deltaY: -100 });
    expect(picker).toHaveAttribute("aria-expanded", "false");
    expect(picker).not.toHaveFocus();
    expect(zoom).toHaveBeenCalledWith(-100);
});

test("搜索及独立弹层内的指针和滚动不会误关菜单，仍可选择模型", async () => {
    const changed = vi.fn();
    const view = render(<ModelPicker config={platformConfig()} value="img-1" onChange={changed} />);
    const user = userEvent.setup();
    const picker = screen.getByRole("combobox");
    await user.click(picker);
    await user.type(picker, "文本");
    const option = screen.getByRole("option");
    const popup = option.closest(".ant-select-dropdown")!;
    expect(view.container.contains(popup)).toBe(false);
    fireEvent.pointerDown(popup, { pointerType: "touch", pointerId: 1 });
    fireEvent.wheel(option, { deltaY: 100 });
    fireEvent.scroll(popup);
    expect(picker).toHaveAttribute("aria-expanded", "true");
    await user.click(option);
    expect(changed).toHaveBeenCalledWith("platform::txt-1", expect.anything());
    expect(picker).toHaveAttribute("aria-expanded", "false");
});

test.each(["scroll", "resize", "blur"])("窗口 %s 后菜单不残留", async (eventType) => {
    render(<ModelPicker config={platformConfig()} value="img-1" onChange={vi.fn()} />);
    const picker = screen.getByRole("combobox");
    await userEvent.setup().click(picker);
    fireEvent(window, new Event(eventType));
    expect(picker).toHaveAttribute("aria-expanded", "false");
});

test("切换模型选择框只保留当前菜单", async () => {
    render(<><ModelPicker config={platformConfig()} value="img-1" onChange={vi.fn()} /><ModelPicker config={platformConfig()} value="txt-1" onChange={vi.fn()} /></>);
    const [first, second] = screen.getAllByRole("combobox");
    const user = userEvent.setup();
    await user.click(first);
    await user.click(second);
    expect(first).toHaveAttribute("aria-expanded", "false");
    expect(second).toHaveAttribute("aria-expanded", "true");
});

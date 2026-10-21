import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { App } from "antd";
import { afterEach, beforeAll, expect, test, vi } from "vitest";

const state = vi.hoisted(() => ({ preferences: { size: "2048x2048", vquality: "1080", canvasImageCount: "3", nodeRegenerateBehavior: "new-node", autoFocusOnSelect: true, imageModelId: "keep-model" } as Record<string, unknown> }));
vi.mock("@/hooks/use-public-models", () => ({ fetchPublicModels: vi.fn() }));
vi.mock("@/services/api/generation", () => ({
    getGenerationPreferences: async () => state.preferences,
    updateGenerationPreferences: vi.fn(async (patch) => ({ ...state.preferences, ...patch })),
}));
vi.mock("@/stores/use-user-store", () => {
    const current = { sessionVersion: 1, user: { id: "test" } };
    const useUserStore = Object.assign((selector: (state: typeof current) => unknown) => selector(current), { getState: () => current, subscribe: () => () => undefined });
    return { useUserStore, assertCurrentSession: vi.fn() };
});

const { initI18n } = await import("@/i18n");
const { default: GenerationPreferencesModal } = await import("@/components/layout/generation-preferences-modal");
const { updateGenerationPreferences } = await import("@/services/api/generation");
const { useConfigStore } = await import("@/stores/use-config-store");

beforeAll(async () => {
    Object.defineProperty(window, "matchMedia", { configurable: true, value: () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }) });
    await initI18n();
});
afterEach(cleanup);

test("生成偏好读取服务端设置，并只提交受本弹窗管理的字段", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const closed = vi.fn();
    render(<MemoryRouter><QueryClientProvider client={client}><App><GenerationPreferencesModal onClose={closed} /></App></QueryClientProvider></MemoryRouter>);
    const user = userEvent.setup();
    await waitFor(() => expect(screen.getByRole("switch")).toBeChecked());
    await user.click(screen.getByRole("radio", { name: /原地重新生成/ }));
    await user.click(screen.getByRole("button", { name: /保\s*存/ }));
    await waitFor(() => expect(closed).toHaveBeenCalledTimes(1));
    const patch = vi.mocked(updateGenerationPreferences).mock.calls[0][0];
    expect(patch).toMatchObject({ size: "2048x2048", vquality: "1080", nodeRegenerateBehavior: "overwrite", autoFocusOnSelect: true });
    expect(patch).not.toHaveProperty("imageModelId");
    expect(useConfigStore.getState().config.nodeRegenerateBehavior).toBe("overwrite");
    client.clear();
});

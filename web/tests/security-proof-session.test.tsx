import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const session = vi.hoisted(() => ({ version: 1 }));
vi.mock("@/stores/use-user-store", () => ({
    useUserStore: { getState: () => ({ sessionVersion: session.version }) },
    assertCurrentSession: (version: number) => { if (version !== session.version) throw new DOMException("登录会话已变更", "AbortError"); },
}));
vi.mock("@/services/api/platform-operations", () => ({ getAccountSecurity: async () => ({ security: { mfaEnabled: false } }) }));
import { requestSecurityProof, SecurityProofProvider } from "@/hooks/use-security-proof";

beforeEach(() => {
    session.version = 1;
    vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false, addListener: vi.fn(), removeListener: vi.fn() })));
    const getStyle = window.getComputedStyle;
    vi.spyOn(window, "getComputedStyle").mockImplementation((element) => getStyle(element));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

test.each([false, true])("安全证明只返回给发起弹窗的登录会话，期间切号=%s", async (changed) => {
    render(<SecurityProofProvider />);
    let proof!: ReturnType<typeof requestSecurityProof>;
    act(() => { proof = requestSecurityProof(); });
    const result = changed ? expect(proof).rejects.toThrow("登录会话已变更") : expect(proof).resolves.toEqual({ password: "test-password" });
    await userEvent.type(await screen.findByLabelText("当前密码"), "test-password");
    if (changed) session.version++;
    await userEvent.click(screen.getByRole("button", { name: /确\s*认/ }));
    await result;
});

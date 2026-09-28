import { createRequire } from "node:module";
import { expect, test } from "vitest";
import { loadModule, readSource } from "./support/source-loader";

const nodeRequire = createRequire(import.meta.url);

function deferred() {
    let resolve: (value?: any) => void, reject: (reason?: any) => void;
    const promise = new Promise((accept, fail) => { resolve = accept; reject = fail; });
    return { promise, resolve: resolve!, reject: reject! };
}

const tick = () => new Promise(setImmediate);
const record = (id: string, title = id) => ({ id, title, nodeCount: 0, connectionCount: 0, snapshot: {}, createdAt: "2026-01-01", updatedAt: "2026-01-01" });

function setup(t: { onTestFinished: (fn: () => void) => void }) {
    const channels: any[] = [];
    const browserStorage = new Map<string, string>();
    const auth: any = { __esModule: true, login: async ({ username }: { username: string }) => ({ id: username }) };
    const canvasApi: any = { __esModule: true, onCanvasWorkspaceMove: () => {} };
    const assetApi: any = { __esModule: true };
    const profile: any = {};
    const imports: Record<string, any> = {
        zustand: nodeRequire("zustand"),
        "@/i18n": { default: { t: (key: string) => key }, __esModule: true },
        "@/services/api/auth": auth,
        "@/services/api/user-center": profile,
        "@/services/api/request": { ApiError: class extends Error {} },
        "@/services/api/canvas-projects": canvasApi,
        "@/services/api/assets": assetApi,
        "@/services/api/media": { mediaId: (id: string) => id, mediaUrl: (id: string) => `/api/media/${id}` },
        "@/lib/utils": { randomId: nodeRequire("nanoid").nanoid },
        "@/lib/password-rules": loadModule(readSource("lib/password-rules.ts")),
        "@/services/image-storage": { ensureImagePreview: async () => undefined, previewUrlFor: () => undefined },
    };
    // Load production stores and real Zustand, replacing only their browser/API dependencies.
    const load = (file: string) => {
        const source = readSource(`stores/${file}`);
        return loadModule(source, {
            DOMException, URL, URLSearchParams, setTimeout, clearTimeout, window: { location: { origin: "https://canvas.example.test" } },
            localStorage: { getItem: (key: string) => browserStorage.get(key) ?? null, setItem: (key: string, value: string) => browserStorage.set(key, value), removeItem: (key: string) => browserStorage.delete(key) },
            BroadcastChannel: class {
                sent: any[] = [];
                constructor() { channels.push(this); }
                postMessage(value: any) { this.sent.push(value); }
            },
        }, imports);
    };
    const users = load("use-user-store.ts");
    imports["@/stores/use-user-store"] = users;
    const canvas = load("canvas/use-canvas-store.ts").useCanvasStore;
    const assets = load("use-asset-store.ts").useAssetStore;
    const user = users.useUserStore;
    const login = (username: string) => user.getState().login({ username, password: "test-only" });
    const prime = async (id = "project") => {
        canvasApi.listCanvasProjects = async () => ({ projects: [record(id)], total: 1 });
        canvasApi.getCanvasProject = async () => record(id);
        await canvas.getState().hydrateProjects(user.getState().user.id);
        await canvas.getState().loadProject(id);
    };
    t.onTestFinished(() => user.getState().clearSession());
    return { auth, profile, canvasApi, assetApi, user, canvas, assets, login, prime, channels, imports, load, browserStorage };
}

test("private canvas details and failed asset deletion cannot cross accounts", async (t) => {
    const { canvasApi, assetApi, canvas, assets, login } = setup(t);
    await login("A");
    const detail = deferred();
    const deletion = deferred();
    canvasApi.getCanvasProject = () => detail.promise;
    assetApi.deleteAsset = () => deletion.promise;
    assets.getState().replaceAssets([{ id: "A-asset", title: "private A text", editable: true }]);
    const loading = canvas.getState().loadProject("A-project");
    const removing = expect(assets.getState().removeAsset("A-asset")).rejects.toThrow(/network failure/);
    await login("B");
    assets.getState().replaceAssets([{ id: "B-asset" }]);
    detail.resolve(record("A-project", "private A canvas"));
    deletion.reject(new Error("network failure"));
    await removing;
    expect(await loading).toBe(null);
    await tick();
    expect(canvas.getState().projects.length).toBe(0);
    expect(Array.from(assets.getState().assets, (item: any) => item.id)).toEqual(["B-asset"]);
});

test("asset creation works without secure-context crypto.randomUUID", async (t) => {
    const { assetApi, assets, login } = setup(t);
    await login("A");
    assetApi.createAsset = async (input: any) => ({ ...input, id: "asset", ownerId: "A" });
    const id = await assets.getState().addAsset({ kind: "text", title: "private", data: { content: "saved text" } });
    expect(id).toBe("asset");
    expect(assets.getState().assets[0].data.content).toBe("saved text");
});

test("same-user relogin cannot reuse old hydration or clear the new pending request", async (t) => {
    const { canvasApi, canvas, user, login } = setup(t);
    await login("A");
    const old = deferred(), current = deferred();
    let calls = 0;
    canvasApi.listCanvasProjects = () => ++calls === 1 ? old.promise : current.promise;
    const previousLoad = canvas.getState().hydrateProjects("A");
    user.getState().clearSession();
    await login("A");
    const currentLoad = canvas.getState().hydrateProjects("A");
    old.resolve({ projects: [record("stale")], total: 1 });
    await previousLoad;
    const deduplicated = canvas.getState().hydrateProjects("A");
    expect(calls).toBe(2);
    expect(canvas.getState().projects.length).toBe(0);
    current.resolve({ projects: [record("current")], total: 1 });
    await Promise.all([currentLoad, deduplicated]);
    expect(canvas.getState().projects[0].id).toBe("current");
});

test("create/import results from the previous account are rejected", async (t) => {
    const { canvasApi, canvas, login } = setup(t);
    await login("A");
    const creation = deferred();
    canvasApi.createCanvasProject = () => creation.promise;
    const creating = expect(canvas.getState().createProject("A")).rejects.toMatchObject({ name: "AbortError" });
    const importing = expect(canvas.getState().importProject({ title: "A import" })).rejects.toMatchObject({ name: "AbortError" });
    await login("B");
    creation.resolve(record("A-project"));
    await Promise.all([creating, importing]);
    expect(canvas.getState().projects.length).toBe(0);
});

test("flush waits for both the running save and the newer queued snapshot", async (t) => {
    const { canvasApi, canvas, login, prime } = setup(t);
    await login("A");
    await prime();
    const first = deferred(), second = deferred();
    const savedTitles: string[] = [];
    canvasApi.updateCanvasProject = (_id: string, patch: any) => { savedTitles.push(patch.title); return savedTitles.length === 1 ? first.promise : second.promise; };
    await canvas.getState().renameProject("project", "first");
    let finished = false;
    const saving = canvas.getState().flushProject("project");
    await canvas.getState().renameProject("project", "second");
    const flush = canvas.getState().flushProject("project").then(() => { finished = true; });
    first.resolve(record("project"));
    await tick();
    expect(savedTitles).toEqual(["first", "second"]);
    expect(finished).toBe(false);
    second.resolve(record("project"));
    await Promise.all([saving, flush]);
    expect(finished).toBe(true);
});

test("old save finalizers cannot remove a new session's in-flight save", async (t) => {
    const { canvasApi, canvas, login, prime } = setup(t);
    await login("A");
    await prime();
    const previous = deferred(), current = deferred(), latest = deferred();
    const responses = [previous, current, latest];
    let calls = 0;
    canvasApi.updateCanvasProject = () => responses[calls++].promise;
    await canvas.getState().renameProject("project", "old");
    const oldSave = canvas.getState().flushProject("project");
    await login("A");
    await prime();
    await canvas.getState().renameProject("project", "current");
    const currentSave = canvas.getState().flushProject("project");
    previous.reject(new Error("old save failed"));
    await oldSave;
    expect(canvas.getState().saveError).toBe(null);
    await canvas.getState().renameProject("project", "latest");
    const latestSave = canvas.getState().flushProject("project");
    expect(calls).toBe(2);
    current.resolve(record("project"));
    await tick();
    expect(calls).toBe(3);
    latest.resolve(record("project"));
    await Promise.all([currentSave, latestSave]);
});

test("a pending delete does not issue writes after the account changes", async (t) => {
    const { canvasApi, canvas, login, prime } = setup(t);
    await login("A");
    await prime();
    const save = deferred();
    let deletes = 0;
    canvasApi.updateCanvasProject = () => save.promise;
    canvasApi.deleteCanvasProject = async () => { deletes += 1; };
    await canvas.getState().renameProject("project", "pending");
    const saving = canvas.getState().flushProject("project");
    const deleting = expect(canvas.getState().deleteProjects(["project"])).rejects.toMatchObject({ name: "AbortError" });
    await login("B");
    save.resolve(record("project"));
    await Promise.all([saving, deleting]);
    expect(deletes).toBe(0);
});

test("stale auth/profile responses cannot revive the previous session", async (t) => {
    const { auth, profile, user, login } = setup(t);
    const initial = deferred();
    auth.getCurrentUser = () => initial.promise;
    const initializing = user.getState().initialize();
    user.getState().clearSession();
    initial.resolve({ id: "A" });
    await initializing;
    expect(user.getState().user).toBe(null);
    await login("A");
    const updating = deferred();
    profile.updateUserProfile = () => updating.promise;
    const result = expect(user.getState().updateDisplayName("A name")).rejects.toMatchObject({ name: "AbortError" });
    await login("B");
    updating.resolve({ id: "A", displayName: "A name" });
    await result;
    expect(user.getState().user.id).toBe("B");
});

test("another tab's auth change clears private state without echoing the event", async (t) => {
    const { user, canvas, assets, channels, login, prime } = setup(t);
    await login("A");
    await prime();
    assets.getState().replaceAssets([{ id: "A-asset" }]);
    const events = channels[0].sent.length;
    channels[0].onmessage();
    expect(user.getState().user).toBe(null);
    expect(canvas.getState().projects.length).toBe(0);
    expect(assets.getState().assets.length).toBe(0);
    expect(channels[0].sent.length).toBe(events);
});

test("account changes clear query history and prevent delayed queries from repopulating it", async (t) => {
    const { imports, load, login } = setup(t);
    const { QueryClient } = nodeRequire("@tanstack/react-query");
    let client: any;
    for (const id of ["react", "react/jsx-runtime"]) imports[id] = nodeRequire(id);
    for (const id of ["@ant-design/pro-components", "antd", "antd/es/locale/en_US", "antd/es/locale/zh_CN", "dayjs", "dayjs/locale/zh-cn", "react-i18next", "@/components/layout/client-root-init", "@/components/layout/app-error-boundary", "@/lib/app-theme", "@/stores/use-theme-store"]) imports[id] = {};
    imports["@tanstack/react-query"] = { QueryClient: class extends QueryClient { constructor(options: any) { super(options); client = this; } } };
    load("../components/layout/app-providers.tsx");
    t.onTestFinished(() => client.clear());
    await login("A");
    client.setQueryData(["user-generations", 0], [{ prompt: "private A prompt" }]);
    const pending = deferred();
    const loading = client.fetchQuery({ queryKey: ["delayed-private-data"], queryFn: () => pending.promise }).catch(() => undefined);
    await login("B");
    expect(client.getQueryCache().getAll().length).toBe(0);
    pending.resolve([{ prompt: "late A prompt" }]);
    await loading;
    await tick();
    expect(client.getQueryCache().getAll().length).toBe(0);
});

test("personal configuration and delayed model hydration stay within the authenticated account", async (t) => {
    const { imports, load, login, user } = setup(t);
    const { persist, createJSONStorage } = nodeRequire("zustand/middleware");
    const storage = new Map<string, string>();
    imports.react = nodeRequire("react");
    imports.nanoid = nodeRequire("nanoid");
    imports["zustand/middleware"] = { persist: (creator: any, options: any) => persist(creator, { ...options, storage: createJSONStorage(() => ({ getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) })) }) };
    const models = deferred();
    imports["@/hooks/use-public-models"] = { fetchPublicModels: () => models.promise, usePublicModels: () => ({ data: [] }) };
    imports["@/lib/model-price"] = load("../lib/model-price.ts");
    const config = load("use-config-store.ts").useConfigStore;
    await login("A");
    config.getState().updateConfig("systemPrompt", "private A instructions");
    config.getState().updateConfig("quality", "high");
    const hydration = config.getState().hydratePlatformModels();
    await login("B");
    expect(config.getState().config.systemPrompt).toBe("");
    expect(config.getState().config.quality).toBe("auto");
    models.resolve([{ id: "A-model", capability: "text", displayName: "A model" }]);
    await hydration;
    expect(config.getState().config.textModel).toBe("");
    config.getState().updateConfig("systemPrompt", "private B instructions");
    user.getState().clearSession();
    expect(config.getState().config.systemPrompt).toBe("");
    await login("A");
    expect(config.getState().config.systemPrompt).toBe("private A instructions");
    expect(config.getState().config.quality).toBe("high");
});

test("local Agent credentials survive same-user login while platform messages and tools stay isolated", async (t) => {
    const { imports, load, login, user, assets, assetApi, canvas } = setup(t);
    const agent = load("use-agent-store.ts").useAgentStore;
    const workbench = load("use-workbench-agent-store.ts").useWorkbenchAgentStore;
    await login("A");
    agent.getState().setAgentState({ token: "local-test-token-A", messages: [{ id: "private-A", text: "private" }] });
    agent.getState().connectAgent();
    await login("B");
    expect(agent.getState().token).toBe("");
    expect(agent.getState().messages.length).toBe(0);
    await login("A");
    expect(agent.getState().token).toBe("local-test-token-A");
    expect(agent.getState().messages.length).toBe(0);
    expect(agent.getState().enabled).toBe(false);

    imports["@/services/api/prompts"] = {};
    imports["@/components/image-settings-panel"] = {};
    imports["@/services/image-storage"] = {};
    imports["@/stores/canvas/use-canvas-store"] = { useCanvasStore: canvas };
    imports["@/stores/use-asset-store"] = { useAssetStore: assets };
    imports["@/stores/use-workbench-agent-store"] = { useWorkbenchAgentStore: workbench };
    const videoModels = [{ id: "video-model", capability: "video", displayName: "平台视频" }];
    const videoSubmissions: any[] = [];
    const generationApi: any = {
        getPublicModels: async () => videoModels,
        createGenerationBatch: async (input: any) => { videoSubmissions.push(input); return { batch: { id: "video-batch" }, tasks: [{ id: "video-task" }] }; },
    };
    imports["@/services/api/generation"] = generationApi;
    // 平台模型统一走 use-public-models 单入口，测试沿用同一个桩。
    imports["@/hooks/use-public-models"] = { fetchPublicModels: () => generationApi.getPublicModels(), usePublicModels: () => ({ data: videoModels }) };
    imports["@/services/api/tasks"] = { selectedPlatformModel: (models: any[], _selected: any, capability: string) => models.find((model) => model.capability === capability).id };
    imports["@/stores/use-config-store"] = {
        useConfigStore: { getState: () => ({ config: { channels: [], videoModel: "platform::video-model", videoSeconds: "6" }, updateConfig() {} }) },
        normalizeModelOptionValue: (value: any) => value,
        selectableModelsByCapability: () => ["platform::image-model"],
    };
    const { runSiteTool } = load("../lib/agent/agent-site-tools.ts");
    const saved = deferred();
    assetApi.createAsset = () => saved.promise;
    let reported = false;
    const adding = runSiteTool("assets_add", { kind: "text", title: "A asset", content: "saved by platform" }, () => {}).then((result: any) => { reported = true; return result; });
    await tick();
    expect(reported).toBe(false);
    saved.resolve({ id: "saved-asset-id", ownerId: "A", type: "text", title: "A asset", content: "saved by platform" });
    expect((await adding).id).toBe("saved-asset-id");
    const result = await runSiteTool("workbench_image_generate", { model: "platform::image-model", quality: "high", size: "2:3", count: 2, prompt: "generate" }, () => {});
    expect(result.taskId).toBe(workbench.getState().imageCommand.taskId);
    expect(workbench.getState().imageCommand.config.model).toBe("platform::image-model");
    expect(workbench.getState().imageCommand.config.quality).toBe("high");
    await expect(runSiteTool("workbench_video_generate", {}, () => expect.fail("Invalid video input must not navigate"))).rejects.toThrow(/请输入视频提示词/);
    const videoResult = await runSiteTool("workbench_video_generate", { prompt: "platform video" }, (path: string) => expect(path).toBe("/video?batch=video-batch"));
    expect(videoResult.taskId).toBe("video-task");
    expect(videoSubmissions[0].modelId).toBe("video-model");
    expect(videoSubmissions[0].apiKey).toBe(undefined);
    const lookup = deferred();
    generationApi.getPublicModels = () => lookup.promise;
    const staleVideo = runSiteTool("workbench_video_generate", { prompt: "private A video" }, () => expect.fail("Stale video must not navigate"));
    await login("B");
    lookup.resolve(videoModels);
    await expect(staleVideo).rejects.toMatchObject({ name: "AbortError" });
    expect(videoSubmissions.length).toBe(1);
    user.getState().clearSession();
    expect(workbench.getState().imageCommand).toBe(null);
});

test("local Agent fragment survives login and required password change without leaving the site", async (t) => {
    const { imports, load, user, login } = setup(t);
    const destination = "/canvas/project?mode=new#agentUrl=http%3A%2F%2F127.0.0.1%3A17371&agentToken=test-only";
    const { authReturnPath } = load("../lib/auth-return-path.ts");
    imports["@/lib/auth-return-path"] = { authReturnPath };
    imports["@/lib/affiliate"] = { affiliateCodeFromSearch: () => "", getAffiliateCode: () => "", saveAffiliateCode: () => {} };
    imports.react = { useEffect() {}, useState: (value: any) => [value, () => {}] };
    imports["react/jsx-runtime"] = nodeRequire("react/jsx-runtime");
    let location = { pathname: "/canvas/project", search: "?mode=new", hash: destination.slice(destination.indexOf("#")), state: null };
    imports["react-router-dom"] = { Navigate() {}, useLocation: () => location, useNavigate: () => () => {} };
    imports.antd = { App: { useApp: () => ({ message: {} }) } };
    imports["lucide-react"] = {};
    imports["@/components/ui/animated-theme-toggler"] = {};
    imports["@/stores/use-theme-store"] = { useThemeStore: (select: any) => select({ theme: "light", setTheme() {} }) };
    imports["@/stores/use-user-store"] = { useUserStore: (select: any) => select(user.getState()) };
    user.getState().clearSession();
    const guard = load("../components/auth/auth-guard.tsx").AuthGuard;
    const loginPage = load("../pages/login/index.tsx").default;
    const passwordPage = load("../pages/change-password/index.tsx").default;
    const redirect = guard({ children: null });
    expect(redirect.props.to).toBe("/login");
    expect(redirect.props.state.from).toBe(destination);
    location = { pathname: "/login", search: "", hash: "", state: redirect.props.state };
    await login("A");
    user.setState({ user: { id: "A", mustChangePassword: true } });
    const passwordRedirect = loginPage();
    expect(passwordRedirect.props.to).toBe("/change-password");
    expect(passwordRedirect.props.state.from).toBe(destination);
    location = { pathname: "/change-password", search: "", hash: "", state: passwordRedirect.props.state };
    user.setState({ user: { id: "A", mustChangePassword: false } });
    expect(passwordPage().props.to).toBe(destination);
    expect(authReturnPath("https://other.example.test/#agentToken=test-only")).toBe("/");
    expect(new URL(authReturnPath(destination), "https://canvas.example.test").searchParams.has("agentToken")).toBe(false);
});

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");
const { runInNewContext } = require("node:vm");
const { test } = require("node:test");
const { transpileModule, ModuleKind, ScriptTarget, JsxEmit } = require("typescript");
const { create } = require("zustand");

function deferred() {
    let resolve, reject;
    const promise = new Promise((accept, fail) => { resolve = accept; reject = fail; });
    return { promise, resolve, reject };
}

const tick = () => new Promise(setImmediate);
const record = (id, title = id) => ({ id, title, nodeCount: 0, connectionCount: 0, snapshot: {}, createdAt: "2026-01-01", updatedAt: "2026-01-01" });

function setup(t) {
    const channels = [];
    const browserStorage = new Map();
    const auth = { __esModule: true, login: async ({ username }) => ({ id: username }) };
    const canvasApi = { __esModule: true };
    const assetApi = { __esModule: true };
    const profile = {};
    const imports = {
        zustand: { create },
        "@/i18n": { default: { t: (key) => key }, __esModule: true },
        "@/services/api/auth": auth,
        "@/services/api/user-center": profile,
        "@/services/api/request": { ApiError: class extends Error {} },
        "@/services/api/canvas-projects": canvasApi,
        "@/services/api/assets": assetApi,
        "@/services/api/media": { mediaId: (id) => id, mediaUrl: (id) => `/api/media/${id}` },
        "@/lib/utils": { randomId: require("nanoid").nanoid },
    };
    // Load production stores and real Zustand, replacing only their browser/API dependencies.
    const load = (file) => {
        const module = { exports: {} };
        const source = readFileSync(resolve(__dirname, "../src/stores", file), "utf8");
        const compiled = transpileModule(source, { fileName: file, compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022, jsx: JsxEmit.ReactJSX } }).outputText;
        runInNewContext(compiled, {
            module, exports: module.exports,
            require: (id) => { assert.ok(imports[id], `Unexpected dependency: ${id}`); return imports[id]; },
            DOMException, URL, setTimeout, clearTimeout, window: { location: { origin: "https://canvas.example.test" } },
            localStorage: { getItem: (key) => browserStorage.get(key) ?? null, setItem: (key, value) => browserStorage.set(key, value), removeItem: (key) => browserStorage.delete(key) },
            BroadcastChannel: class {
                sent = [];
                constructor() { channels.push(this); }
                postMessage(value) { this.sent.push(value); }
            },
        });
        return module.exports;
    };
    const users = load("use-user-store.ts");
    imports["@/stores/use-user-store"] = users;
    const canvas = load("canvas/use-canvas-store.ts").useCanvasStore;
    const assets = load("use-asset-store.ts").useAssetStore;
    const user = users.useUserStore;
    const login = (username) => user.getState().login({ username, password: "test-only" });
    const prime = async (id = "project") => {
        canvasApi.listCanvasProjects = async () => [record(id)];
        canvasApi.getCanvasProject = async () => record(id);
        await canvas.getState().hydrateProjects(user.getState().user.id);
        await canvas.getState().loadProject(id);
    };
    t.after(() => user.getState().clearSession());
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
    const removing = assert.rejects(assets.getState().removeAsset("A-asset"), /network failure/);
    await login("B");
    assets.getState().replaceAssets([{ id: "B-asset" }]);
    detail.resolve(record("A-project", "private A canvas"));
    deletion.reject(new Error("network failure"));
    await removing;
    assert.equal(await loading, null);
    await tick();
    assert.equal(canvas.getState().projects.length, 0);
    assert.deepEqual(Array.from(assets.getState().assets, (item) => item.id), ["B-asset"]);
});

test("asset creation works without secure-context crypto.randomUUID", async (t) => {
    const { assetApi, assets, login } = setup(t);
    await login("A");
    assetApi.createAsset = async (input) => ({ ...input, id: "asset", ownerId: "A" });
    const id = await assets.getState().addAsset({ kind: "text", title: "private", data: { content: "saved text" } });
    assert.equal(id, "asset");
    assert.equal(assets.getState().assets[0].data.content, "saved text");
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
    old.resolve([record("stale")]);
    await previousLoad;
    const deduplicated = canvas.getState().hydrateProjects("A");
    assert.equal(calls, 2);
    assert.equal(canvas.getState().projects.length, 0);
    current.resolve([record("current")]);
    await Promise.all([currentLoad, deduplicated]);
    assert.equal(canvas.getState().projects[0].id, "current");
});

test("create/import results from the previous account are rejected", async (t) => {
    const { canvasApi, canvas, login } = setup(t);
    await login("A");
    const creation = deferred();
    canvasApi.createCanvasProject = () => creation.promise;
    const creating = assert.rejects(canvas.getState().createProject("A"), { name: "AbortError" });
    const importing = assert.rejects(canvas.getState().importProject({ title: "A import" }), { name: "AbortError" });
    await login("B");
    creation.resolve(record("A-project"));
    await Promise.all([creating, importing]);
    assert.equal(canvas.getState().projects.length, 0);
});

test("flush waits for both the running save and the newer queued snapshot", async (t) => {
    const { canvasApi, canvas, login, prime } = setup(t);
    await login("A");
    await prime();
    const first = deferred(), second = deferred();
    const savedTitles = [];
    canvasApi.updateCanvasProject = (_id, patch) => { savedTitles.push(patch.title); return savedTitles.length === 1 ? first.promise : second.promise; };
    await canvas.getState().renameProject("project", "first");
    let finished = false;
    const saving = canvas.getState().flushProject("project");
    await canvas.getState().renameProject("project", "second");
    const flush = canvas.getState().flushProject("project").then(() => { finished = true; });
    first.resolve(record("project"));
    await tick();
    assert.deepEqual(savedTitles, ["first", "second"]);
    assert.equal(finished, false);
    second.resolve(record("project"));
    await Promise.all([saving, flush]);
    assert.equal(finished, true);
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
    assert.equal(canvas.getState().saveError, null);
    await canvas.getState().renameProject("project", "latest");
    const latestSave = canvas.getState().flushProject("project");
    assert.equal(calls, 2);
    current.resolve(record("project"));
    await tick();
    assert.equal(calls, 3);
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
    const deleting = assert.rejects(canvas.getState().deleteProjects(["project"]), { name: "AbortError" });
    await login("B");
    save.resolve(record("project"));
    await Promise.all([saving, deleting]);
    assert.equal(deletes, 0);
});

test("stale auth/profile responses cannot revive the previous session", async (t) => {
    const { auth, profile, user, login } = setup(t);
    const initial = deferred();
    auth.getCurrentUser = () => initial.promise;
    const initializing = user.getState().initialize();
    user.getState().clearSession();
    initial.resolve({ id: "A" });
    await initializing;
    assert.equal(user.getState().user, null);
    await login("A");
    const updating = deferred();
    profile.updateUserProfile = () => updating.promise;
    const result = assert.rejects(user.getState().updateDisplayName("A name"), { name: "AbortError" });
    await login("B");
    updating.resolve({ id: "A", displayName: "A name" });
    await result;
    assert.equal(user.getState().user.id, "B");
});

test("another tab's auth change clears private state without echoing the event", async (t) => {
    const { user, canvas, assets, channels, login, prime } = setup(t);
    await login("A");
    await prime();
    assets.getState().replaceAssets([{ id: "A-asset" }]);
    const events = channels[0].sent.length;
    channels[0].onmessage();
    assert.equal(user.getState().user, null);
    assert.equal(canvas.getState().projects.length, 0);
    assert.equal(assets.getState().assets.length, 0);
    assert.equal(channels[0].sent.length, events);
});

test("account changes clear query history and prevent delayed queries from repopulating it", async (t) => {
    const { imports, load, login } = setup(t);
    const { QueryClient } = require("@tanstack/react-query");
    let client;
    for (const id of ["react", "react/jsx-runtime"]) imports[id] = require(id);
    for (const id of ["@ant-design/pro-components", "antd", "antd/es/locale/en_US", "antd/es/locale/zh_CN", "dayjs", "dayjs/locale/zh-cn", "react-i18next", "@/components/layout/client-root-init", "@/lib/app-theme", "@/stores/use-theme-store"]) imports[id] = {};
    imports["@tanstack/react-query"] = { QueryClient: class extends QueryClient { constructor(options) { super(options); client = this; } } };
    load("../components/layout/app-providers.tsx");
    t.after(() => client.clear());
    await login("A");
    client.setQueryData(["user-generations", 0], [{ prompt: "private A prompt" }]);
    const pending = deferred();
    const loading = client.fetchQuery({ queryKey: ["delayed-private-data"], queryFn: () => pending.promise }).catch(() => undefined);
    await login("B");
    assert.equal(client.getQueryCache().getAll().length, 0);
    pending.resolve([{ prompt: "late A prompt" }]);
    await loading;
    await tick();
    assert.equal(client.getQueryCache().getAll().length, 0);
});

test("personal configuration and delayed model hydration stay within the authenticated account", async (t) => {
    const { imports, load, login, user } = setup(t);
    const { persist, createJSONStorage } = require("zustand/middleware");
    const storage = new Map();
    imports.react = require("react");
    imports.nanoid = require("nanoid");
    imports["zustand/middleware"] = { persist: (creator, options) => persist(creator, { ...options, storage: createJSONStorage(() => ({ getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: (key) => storage.delete(key) })) }) };
    const models = deferred();
    imports["@/services/api/models"] = { listModels: () => models.promise };
    const config = load("use-config-store.ts").useConfigStore;
    await login("A");
    config.getState().updateConfig("systemPrompt", "private A instructions");
    config.getState().updateConfig("quality", "high");
    const hydration = config.getState().hydratePlatformModels();
    await login("B");
    assert.equal(config.getState().config.systemPrompt, "");
    assert.equal(config.getState().config.quality, "auto");
    models.resolve([{ id: "A-model", capability: "text", displayName: "A model" }]);
    await hydration;
    assert.equal(config.getState().config.textModel, "");
    config.getState().updateConfig("systemPrompt", "private B instructions");
    user.getState().clearSession();
    assert.equal(config.getState().config.systemPrompt, "");
    await login("A");
    assert.equal(config.getState().config.systemPrompt, "private A instructions");
    assert.equal(config.getState().config.quality, "high");
});

test("local Agent credentials survive same-user login while platform messages and tools stay isolated", async (t) => {
    const { imports, load, login, user, assets, assetApi, canvas } = setup(t);
    const agent = load("use-agent-store.ts").useAgentStore;
    const workbench = load("use-workbench-agent-store.ts").useWorkbenchAgentStore;
    await login("A");
    agent.getState().setAgentState({ token: "local-test-token-A", messages: [{ id: "private-A", text: "private" }] });
    agent.getState().connectAgent();
    await login("B");
    assert.equal(agent.getState().token, "");
    assert.equal(agent.getState().messages.length, 0);
    await login("A");
    assert.equal(agent.getState().token, "local-test-token-A");
    assert.equal(agent.getState().messages.length, 0);
    assert.equal(agent.getState().enabled, false);

    imports["@/services/api/prompts"] = {};
    imports["@/components/image-settings-panel"] = {};
    imports["@/services/image-storage"] = {};
    imports["@/stores/canvas/use-canvas-store"] = { useCanvasStore: canvas };
    imports["@/stores/use-asset-store"] = { useAssetStore: assets };
    imports["@/stores/use-workbench-agent-store"] = { useWorkbenchAgentStore: workbench };
    const videoModels = [{ id: "video-model", capability: "video", displayName: "平台视频" }];
    const videoSubmissions = [];
    const generationApi = {
        getPublicModels: async () => videoModels,
        createGenerationBatch: async (input) => { videoSubmissions.push(input); return { batch: { id: "video-batch" }, tasks: [{ id: "video-task" }] }; },
    };
    imports["@/services/api/generation"] = generationApi;
    imports["@/services/api/tasks"] = { selectedPlatformModel: (models, _selected, capability) => models.find((model) => model.capability === capability).id };
    imports["@/stores/use-config-store"] = {
        useConfigStore: { getState: () => ({ config: { channels: [], videoModel: "platform::video-model", videoSeconds: "6" }, updateConfig() {} }) },
        normalizeModelOptionValue: (value) => value,
        selectableModelsByCapability: () => ["platform::image-model"],
    };
    const { runSiteTool } = load("../lib/agent/agent-site-tools.ts");
    const saved = deferred();
    assetApi.createAsset = () => saved.promise;
    let reported = false;
    const adding = runSiteTool("assets_add", { kind: "text", title: "A asset", content: "saved by platform" }, () => {}).then((result) => { reported = true; return result; });
    await tick();
    assert.equal(reported, false);
    saved.resolve({ id: "saved-asset-id", ownerId: "A", type: "text", title: "A asset", content: "saved by platform" });
    assert.equal((await adding).id, "saved-asset-id");
    const result = await runSiteTool("workbench_image_generate", { model: "platform::image-model", quality: "high", size: "2:3", count: 2, prompt: "generate" }, () => {});
    assert.equal(result.taskId, workbench.getState().imageCommand.taskId);
    assert.equal(workbench.getState().imageCommand.config.model, "platform::image-model");
    assert.equal(workbench.getState().imageCommand.config.quality, "high");
    await assert.rejects(runSiteTool("workbench_video_generate", {}, () => assert.fail("Invalid video input must not navigate")), /请输入视频提示词/);
    const videoResult = await runSiteTool("workbench_video_generate", { prompt: "platform video" }, (path) => assert.equal(path, "/studio?type=video&batch=video-batch"));
    assert.equal(videoResult.taskId, "video-task");
    assert.equal(videoSubmissions[0].modelId, "video-model");
    assert.equal(videoSubmissions[0].apiKey, undefined);
    const lookup = deferred();
    generationApi.getPublicModels = () => lookup.promise;
    const staleVideo = runSiteTool("workbench_video_generate", { prompt: "private A video" }, () => assert.fail("Stale video must not navigate"));
    await login("B");
    lookup.resolve(videoModels);
    await assert.rejects(staleVideo, { name: "AbortError" });
    assert.equal(videoSubmissions.length, 1);
    user.getState().clearSession();
    assert.equal(workbench.getState().imageCommand, null);
});

test("local Agent fragment survives login and required password change without leaving the site", async (t) => {
    const { imports, load, user, login } = setup(t);
    const destination = "/canvas/project?mode=new#agentUrl=http%3A%2F%2F127.0.0.1%3A17371&agentToken=test-only";
    const { authReturnPath } = load("../lib/auth-return-path.ts");
    imports["@/lib/auth-return-path"] = { authReturnPath };
    imports.react = { useEffect() {}, useState: (value) => [value, () => {}] };
    imports["react/jsx-runtime"] = require("react/jsx-runtime");
    let location = { pathname: "/canvas/project", search: "?mode=new", hash: destination.slice(destination.indexOf("#")), state: null };
    imports["react-router-dom"] = { Navigate() {}, useLocation: () => location, useNavigate: () => () => {} };
    imports.antd = { App: { useApp: () => ({ message: {} }) } };
    imports["lucide-react"] = {};
    imports["@/components/ui/animated-theme-toggler"] = {};
    imports["@/stores/use-theme-store"] = { useThemeStore: (select) => select({ theme: "light", setTheme() {} }) };
    imports["@/stores/use-user-store"] = { useUserStore: (select) => select(user.getState()) };
    user.getState().clearSession();
    const guard = load("../components/auth/auth-guard.tsx").AuthGuard;
    const loginPage = load("../pages/login/index.tsx").default;
    const passwordPage = load("../pages/change-password/index.tsx").default;
    const redirect = guard({ children: null });
    assert.equal(redirect.props.to, "/login");
    assert.equal(redirect.props.state.from, destination);
    location = { pathname: "/login", search: "", hash: "", state: redirect.props.state };
    await login("A");
    user.setState({ user: { id: "A", mustChangePassword: true } });
    const passwordRedirect = loginPage();
    assert.equal(passwordRedirect.props.to, "/change-password");
    assert.equal(passwordRedirect.props.state.from, destination);
    location = { pathname: "/change-password", search: "", hash: "", state: passwordRedirect.props.state };
    user.setState({ user: { id: "A", mustChangePassword: false } });
    assert.equal(passwordPage().props.to, destination);
    assert.equal(authReturnPath("https://other.example.test/#agentToken=test-only"), "/");
    assert.equal(new URL(authReturnPath(destination), "https://canvas.example.test").searchParams.has("agentToken"), false);
});

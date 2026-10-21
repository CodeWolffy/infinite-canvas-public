const globals = globalThis as unknown as Record<string, unknown>;
globals.__approvedPluginExecutions = Number(globals.__approvedPluginExecutions || 0) + 1;
export default { id: "security-plugin", name: "安全测试插件", version: "1.0.0", nodes: [{ type: "security-node" }] };

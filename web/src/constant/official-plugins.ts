// 随应用审查发布的官方版本：固定提交与包摘要，不信任远程分支自动替换。
const base = "https://cdn.jsdelivr.net/gh/basketikun/infinite-canvas@1438d229416fa2b44dbea05e75712b761386956c/";
export const OFFICIAL_PLUGINS = [
    { id: "markdown", name: "Markdown 节点", version: "1.1.0", icon: "📝", sha256: "eb9faee5f0c98acde76c5cbffbd16cd011f1a6c27a7f9e0a488f376cc445e03f" },
    { id: "svg", name: "SVG 节点", version: "1.1.0", icon: "🔷", sha256: "abdc7bddaaf8a8586c4b3aa148aa1af80c7a8b7f6a3cbfed2d8c7b6a5557a789" },
    { id: "html", name: "HTML 节点", version: "1.2.0", icon: "🌐", sha256: "89b0186c164242bf2472385cb614645c839d98f1f1b8cc361f12091a1a154cd2" },
    { id: "panorama", name: "3D 全景节点", version: "1.1.0", icon: "🧭", sha256: "68c6f1e9ec1abee40cd1d54ab4ad1b6a84d8c070ffd7eef7b008a2a09daf5416" },
    { id: "sticky-note", name: "便利贴节点", version: "1.1.0", icon: "📌", sha256: "c7ad7aac1eb12494135cc8252939c98005894c9d1d0dfbd4e0a06718dc91f0df" },
].map((entry) => ({ ...entry, url: `${base}${entry.id}.js` }));

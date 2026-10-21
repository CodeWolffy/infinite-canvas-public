# 官方插件来源与自托管构建

前端默认直接使用上游 [`basketikun/infinite-canvas`](https://github.com/basketikun/infinite-canvas/tree/plugins-dist) 的官方插件产物，本仓库不再通过 CI 重复构建和发布。默认列表在 `web/src/constant/official-plugins.ts` 固定上游产物提交、版本和每包 SHA-256。第三方插件由用户填写 JS URL 并确认来源及权限后安装。

本目录保留为本地开发或自托管的可选构建工具，不参与应用发版。

```
registry/
  package.json    # 构建工具依赖(esbuild + SDK)
  build.mjs       # 一次进程构建所有官方插件 → dist/(gitignore)+ 生成清单
  dist/           # 可选自托管产物(gitignore,不提交)
```

**产物不进 git**:`dist/` 与 `node_modules/` 均被 `.gitignore` 覆盖。`main` 分支只有源码与脚本。

## 默认上游来源

上游通过 `plugins-dist` 分支发布产物，当前固定来源为：

```
https://cdn.jsdelivr.net/gh/basketikun/infinite-canvas@1438d229416fa2b44dbea05e75712b761386956c/<id>.js
```

部署时保持 `VITE_PLUGIN_REGISTRY_URL` 留空即可使用默认上游版本。更新时先核对上游产物提交、插件标识、版本和每包 SHA-256，再随应用更新固定列表；不自动跟随可变分支。

## 本地构建与自托管

仅在需要发布自行修改的插件时使用本目录。新增插件需登记到 `build.mjs` 的 `OFFICIAL`，并先安装各插件声明的运行依赖；例如 Markdown 插件需要 `dompurify` 与 `marked`，集中构建工具的安装不会自动安装这些依赖。

```bash
cd plugins/canvas/markdown && npm ci
cd ../registry && npm ci && npm run build   # 产出 dist/
```

将 `dist/` 发布到自行管理的静态服务，通过 `VITE_PLUGIN_REGISTRY_URL` 指定清单，并独立配置清单原始字节的 `VITE_PLUGIN_REGISTRY_SHA256`；清单每条必须包含构建生成的 `sha256`。下载拒绝重定向，校验通过后仍需用户确认来源与页面权限，再执行同一份内容。

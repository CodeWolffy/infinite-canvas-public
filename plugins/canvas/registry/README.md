# 官方插件注册表(集中构建 + 远程发布)

本目录只放构建脚本，不放构建产物。官方插件由 CI 发布到 `plugins-dist`，前端只信任随应用固定的版本与内容摘要。第三方插件由用户填写 JS URL 并确认来源及权限后安装。

```
registry/
  package.json    # 构建依赖(esbuild + SDK)
  build.mjs       # 一次进程构建所有官方插件 → dist/(gitignore)+ 生成清单
  dist/           # 构建产物(gitignore,不提交;CI 发布到 plugins-dist 分支)
```

**产物不进 git**:`dist/` 与 `node_modules/` 均被 `.gitignore` 覆盖。`main` 分支只有源码与脚本。

## 发布流程(CI 自动)

`.github/workflows/publish-plugins.yml` 在**打版本 tag(`v*`)**或手动触发(`workflow_dispatch`)时,与 GitHub Pages 发布一起跑:

1. `npm install && npm run build` → 在 `dist/` 产出各 `<id>.js` 与 `official-plugins.json`;
2. 把 `dist/` 强推到孤儿分支 **`plugins-dist`**(仅含产物,force-push 覆盖)。

分支发布地址如下，但前端默认不信任该可变分支的实时内容：

```
https://cdn.jsdelivr.net/gh/basketikun/infinite-canvas@plugins-dist/official-plugins.json
```

默认官方列表由 `web/src/constant/official-plugins.ts` 固定发布提交、版本和每包 SHA-256。更新时需审查后随应用更新该文件。自托管通过 `VITE_PLUGIN_REGISTRY_URL` 指定清单，并独立配置清单原始字节的 `VITE_PLUGIN_REGISTRY_SHA256`；清单每条必须包含构建生成的 `sha256`。下载拒绝重定向，校验通过后仍需用户确认来源与页面权限，再执行同一份内容。

## 新增 / 更新官方插件

- 改完某官方插件源码后,在 `build.mjs` 的 `OFFICIAL` 里保持登记(新增插件在此加一条),提交到 `main`;
- 下次打版本 tag(或手动 `workflow_dispatch`)时,CI 自动重新构建并发布到 `plugins-dist`。
- 审查发布提交与包内容后更新前端固定列表，或重新计算自托管清单摘要；不要仅修改远程清单来自动建立信任。

## 本地自测官方面板

```bash
cd plugins/canvas/registry && npm install && npm run build   # 产出 dist/
# 用本机回环 HTTP 或 HTTPS 伺服 dist/，配置清单 URL 及其 SHA-256 后确认安装
```

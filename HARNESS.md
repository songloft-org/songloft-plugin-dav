# HARNESS

## 已确认命令（人工维护）

- **BuildCommand / harness:build**: `npm run build`
- **TestCommand / harness:test**: `npm test`
- **QuickCommand / harness:quick**: `npm test`
- **BugfixCommand / harness:bugfix**: `npm run build && node --test tests/release-package-contract.test.mjs`
- **FullCommand / harness:full**: `npm run build && npm test`

## Evidence

- 根目录 `package.json` 的 `build`、`test` 与 `validate` scripts。
- `tests/release-package-contract.test.mjs` 对最终 `.jsplugin.zip` 的入口与双层哈希执行产物级验证。

## MissingCommands

- 当前没有独立的端到端插件商店安装测试；最终安装兼容性仍需宿主 `internal/jsplugin` 回归覆盖。
- `songloft-plugin validate` 只校验源 `plugin.json`，无法校验构建后嵌入 ZIP 的哈希；最终包改由 `release-package-contract.test.mjs` 验证。

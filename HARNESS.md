# HARNESS — 项目构建与验证契约

本文件是项目构建、验证和执行环境的唯一事实源。
它定义可执行命令、运行条件和验证边界，不替代 `AGENTS.md` 中的行为、安全与修改约束。

## 项目类型
Songloft WebDAV plugin

## 编译启动诊断
- **WorkingDirectory**: repository root
- **RecommendedTerminal**: PowerShell（Windows）或项目兼容 shell
- **CanRunBuildHere**: unknown
- **BuildCommand**: `npm run build`
- **FailureEvidence**: 记录完整命令、工作目录、终端类型、退出码、前 50 行和最后 100 行构建日志

## 自动识别构建命令候选

- **build**: `npm run build`
- **quick**: `npm test`
- **bugfix**: `npm run build && node --test tests/release-package-contract.test.mjs`
- **full**: `npm run build && npm test`

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

## 高风险目录
- `src/`: 插件生命周期、持久化、凭据、外部网络和 HTTP 契约
- `scripts/`: 构建输出清理、ZIP 重写和仓库 manifest 写入
- `static/`: 远端元数据渲染以及宿主歌曲和歌单写操作
- `dist/`: 构建生成的最终插件包与中间产物

## 禁改区域
- dist: packaged artifacts
- node_modules: third-party installed dependencies
- .git: version control metadata

## 自动识别候选
- WebDAV integration module: `src/client.ts`
- Songloft plugin HTTP router: `src/router.ts`
- Release package normalizer: `scripts/build.mjs`
- Static configuration and library browser: `static/js/app.js`

## 需人工确认
- 真实 WebDAV 服务的 XML 方言、重定向和认证兼容性仍需集成环境验证。
- 插件商店安装端到端验证依赖 Songloft 宿主；仓库当前提供最终 ZIP 契约测试。
- 依赖安装命令没有独立的仓库内权威声明，使用前需由维护者补入 HARNESS。

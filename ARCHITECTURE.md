# 项目架构分析

## 模块依赖关系图
static UI → plugin HTTP router → config storage / WebDAV client / sync runner → persisted sync task → Songloft storage 与外部 WebDAV；`src/main.ts` 位于宿主生命周期入口。

## 核心业务流程
Songloft 调用 `onHTTPRequest` → `src/router.ts` 匹配插件路由 → `src/config.ts` 读写配置或 `src/client.ts` 发起 WebDAV 请求；同步 run/retry 由 `src/sync-runner.ts` 在后台推进 `src/sync-task.ts` 检查点，`static/js/app.js` 只轮询任务状态。

## 架构模式
全局插件生命周期钩子 + SDK Router + WebDAV client/config 模块 + 持久任务与后台运行器 + 隔离静态配置界面。

## 模块接口与通信方式
- Songloft 宿主 → `src/main.ts`: `globalThis` 生命周期与 HTTPRequest/HTTPResponse 钩子
- `src/router.ts` → `src/config.ts` / `src/client.ts`: 函数调用、storage 与 WebDAV fetch
- `src/router.ts` / `src/main.ts` → `src/sync-runner.ts` → `src/sync-task.ts`: 后台有界任务推进与恢复
- `static/js/app.js` → 插件路由与宿主 API: fetch JSON/HTTP

## 关键模块标记
- `src/client.ts`: 外部网络与凭据安全边界
- `src/sync-runner.ts` / `src/sync-task.ts`: 后台长任务与持久状态边界
- `src/router.ts`: 插件对宿主和配置 UI 的 HTTP 契约边界
- `scripts/build.mjs`: 发布包入口、哈希和 manifest 归一化边界

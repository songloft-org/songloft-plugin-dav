# 项目架构分析

## 模块依赖关系图
static UI → plugin HTTP router → config storage / WebDAV client → Songloft storage 与外部 WebDAV；`src/main.ts` 位于宿主生命周期入口；导入流程还会调用宿主 `/api/v1/songs/remote` 与 playlists API。

## 核心功能流
Songloft 调用 `onHTTPRequest` → `src/router.ts` 匹配插件路由 → `src/config.ts` 读写配置或 `src/client.ts` 发起 WebDAV 请求 → 返回 SDK `HTTPResponse`；`static/js/app.js` 通过相对插件路由和宿主 `/api/v1` 路由驱动配置、浏览与歌单导入。

## 架构模式
全局插件生命周期钩子 + SDK Router + WebDAV client/config 模块 + 隔离静态配置界面。

## 模块接口与通信方式
- Songloft 宿主 → `src/main.ts`: `globalThis` 生命周期与 HTTPRequest/HTTPResponse 钩子
- `src/router.ts` → `src/config.ts`: 函数调用与 Songloft storage
- `src/router.ts` → `src/client.ts` → WebDAV: 函数调用与 fetch/PROPFIND、GET 请求
- `static/js/app.js` → 插件路由与宿主 API: fetch JSON/HTTP

## 关键模块标记
- `src/client.ts`: 外部网络与凭据安全边界
- `src/router.ts`: 插件对宿主和配置 UI 的 HTTP 契约边界
- `scripts/build.mjs`: 发布包入口、哈希和仓库 manifest 归一化边界

# Songloft WebDAV 插件

本插件为 Songloft 提供了 WebDAV 协议的支持，允许将任何标准的 WebDAV 存储（如 AliyunDrive WebDAV、Nextcloud 等）挂载为音乐源。

## ✨ 核心特性

- **可视化配置**：提供完整的 UI 界面以添加和管理 WebDAV 服务，支持账号密码认证。
- **动态解析**：结合 Songloft 的播放核心，支持对 WebDAV 目录下的歌曲提供直链解析和播放功能。
- **播放连通性检查**：连接测试会在目录枚举后验证同源音乐文件读取，并提示不兼容的 WebDAV 302 直链策略。
- **歌单导入**：支持将 WebDAV 中的歌曲导入新歌单或添加到已有歌单。

## 📥 安装

下载最新的 [v1.1.5 发布包](https://github.com/songloft-org/songloft-plugin-dav/releases/download/v1.1.5/dav.jsplugin.zip)，然后在 Songloft 中安装。

## 编程语言
JavaScript, TypeScript

## 构建系统
npm / package.json

## 核心模块
- `src/main.ts`: Songloft 生命周期与 HTTP 请求入口
- `src/router.ts`: 配置、目录、封面、歌词、搜索与播放解析路由
- `src/client.ts`: WebDAV PROPFIND、XML 解析、认证和流请求构造
- `src/config.ts`: WebDAV 配置模型与 Songloft storage 持久化
- `static/`: 独立配置、目录浏览和歌曲/歌单导入界面
- `scripts/build.mjs`: 发布 ZIP 入口与哈希归一化
- `tests/`: 凭据边界、DOM 安全、JSC 行为、版本与发布包契约回归

## 使用说明
- 安装: Unknown
- 构建: npm run build
- 运行: npm run dev
## ⚠️ 限制说明

由于标准 WebDAV 协议不包含高效的全局递归搜索功能，为了避免给服务器造成灾难性的遍历压力，本插件在接入 Songloft 的**全局搜索**时会默认返回空结果。推荐的用法是直接浏览文件夹或将其中的特定目录添加到播放列表。

## 📄 License

Apache-2.0

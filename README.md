# Songloft WebDAV 插件

本插件为 Songloft 提供了 WebDAV 协议的支持，允许将任何标准的 WebDAV 存储（如 AliyunDrive WebDAV、Nextcloud 等）挂载为音乐源。

## ✨ 核心特性

- **可视化配置**：提供完整的 UI 界面以添加和管理 WebDAV 服务，支持账号密码认证。
- **动态解析**：结合 Songloft 的播放核心，支持对 WebDAV 目录下的歌曲提供直链解析和播放功能。
- **歌单导入**：支持将 WebDAV 中的歌曲导入新歌单或添加到已有歌单。

## 📥 安装

下载最新的 [v1.1.3 发布包](https://github.com/songloft-org/songloft-plugin-dav/releases/download/v1.1.3/dav.jsplugin.zip)，然后在 Songloft 中安装。

## 📦 开发与构建

基于 `songloft-plugin-sdk` 和 TypeScript 构建，运行在 QuickJS 沙盒中。

```bash
# 安装依赖
pnpm install

# 本地调试与开发
pnpm run dev

# 构建生产环境插件包 (产物位于 dist/dav.jsplugin.zip)
pnpm run build
```

## ⚠️ 限制说明

由于标准 WebDAV 协议不包含高效的全局递归搜索功能，为了避免给服务器造成灾难性的遍历压力，本插件在接入 Songloft 的**全局搜索**时会默认返回空结果。推荐的用法是直接浏览文件夹或将其中的特定目录添加到播放列表。

## 📄 License

MIT

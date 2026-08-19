# Songloft WebDAV 插件

本插件为 Songloft 提供了 WebDAV 协议的支持，允许将任何标准的 WebDAV 存储（如 AliyunDrive WebDAV、Nextcloud 等）挂载为音乐源。

## ✨ 核心特性

- **可视化配置**：提供完整的 UI 界面以添加和管理 WebDAV 服务，支持账号密码认证。
- **动态解析**：结合 Songloft 的播放核心，支持对 WebDAV 目录下的歌曲提供直链解析和播放功能。
- **播放连通性检查**：连接测试会在目录枚举后验证同源音乐文件读取，并提示不兼容的 WebDAV 302 直链策略。
- **歌单导入**：支持将 WebDAV 中的歌曲导入新歌单或添加到已有歌单。
- **目录音乐库同步**：递归扫描指定 WebDAV 根目录，为每个含音乐的目录创建并幂等维护歌单；新增、删除和移动文件后可手动重扫收敛。
- **后台可恢复长任务**：同步由插件后台按有界批次持续推进并保存状态和进度，支持取消、失败重试，以及插件 VM 卸载或宿主重启后的自动检查点恢复；页面关闭不会暂停任务，非原子删除局部失败会明确显示“部分应用”，重试后收敛。
- **安全成员边界**：只移除插件上次管理且本次完整扫描确认消失的歌单成员，不删除 Song 记录、用户歌单或用户手工加入的成员。

## 📥 安装

下载最新的 [v1.2.3 发布包](https://github.com/songloft-org/songloft-plugin-dav/releases/download/v1.2.3/dav.jsplugin.zip)，然后在 Songloft 中安装。正式 Release 发布前，内测用户可直接安装仓库构建出的 `dist/dav.jsplugin.zip`。

## 编程语言
JavaScript, TypeScript

## 构建系统
npm / package.json

## 核心模块
- `src/main.ts`: Songloft 生命周期与 HTTP 请求入口
- `src/router.ts`: 配置、目录、封面、歌词、搜索与播放解析路由
- `src/client.ts`: WebDAV PROPFIND、XML 解析、认证和流请求构造
- `src/config.ts`: WebDAV 配置模型与 Songloft storage 持久化
- `src/scanner.ts`: 有界递归 WebDAV 发现与严格 Multi-Status 校验
- `src/sync.ts`: 扫描根和同步快照模型
- `src/sync-task.ts`: 持久同步任务、分批应用、取消/恢复与 generation 栅栏
- `src/sync-runner.ts`: 后台同步调度、步骤去重与插件重载续跑
- `static/`: 独立配置、目录浏览、歌曲导入和音乐库同步界面
- `scripts/build.mjs`: 发布 ZIP 入口与哈希归一化
- `tests/`: 凭据边界、DOM 安全、JSC 行为、版本与发布包契约回归

## 使用说明
- 安装：在 Songloft 插件管理中上传发布 ZIP。
- 音乐库同步：打开插件的“音乐库同步”页签，选择 WebDAV 配置，填写相对挂载根的扫描目录并点击“扫描并同步”。同步期间可查看目录、歌曲和应用阶段进度。
- 恢复：页面关闭后任务仍在插件后台继续；若插件 VM 卸载或宿主重启，`onInit` 会读取最近有效 checkpoint 并自动恢复。重新进入页签只负责查看最新进度；失败或取消后点击“重试”会以新的 task ID 和 generation 运行。删除阶段开始后取消会返回“过迟”，若 bridge 在删除中途失败则保留旧成功快照、显示部分应用状态并等待重试收敛。
- 构建：`npm run build`
- 运行：`npm run dev`
## ⚠️ 限制说明

由于标准 WebDAV 协议不包含高效的全局递归搜索功能，为了避免给服务器造成灾难性的遍历压力，本插件在接入 Songloft 的**全局搜索**时会默认返回空结果。目录同步采用深度、目录数和条目数上限，并由插件后台串行执行有界步骤；页面只轮询状态，不参与推进。自动定时发起新的扫描、全局 Song 清理和自动删除失效歌单不在当前范围内。

## 📄 License

Apache-2.0

# Songloft DAV / Subsonic 当前任务详情清单

[TOC]

> [!NOTE]
> 本文档是 [Dashboard.md](Dashboard.md) 的执行层。来源包括 2026-07-29 对两个插件 `origin/main`、宿主 JS 插件路由和 Plugin SDK 契约的代码审查，以及 2026-08-12 对 Issue [#336](https://github.com/songloft-org/songloft/issues/336) 的只读分析。
>
> **当前主题**：已完成的安全与发布治理继续保持回归；当前优先交付 DAV 目录扫描与歌单同步 MVP，并把全局删除、强一致自动同步限制在宿主具备 ownership 后。

---

<a id="task-v0"></a>
## 0. 前置调研：建立可重复验证基线 (Task V0)

**优先级**：🔴 P0
**状态**：✅ 已完成
**估时**：0.5 天
**依赖**：`songloft-plugin-subsonic/HARNESS.md`、本地 Plugin SDK / builder、宿主 `songloft` 源码

**背景**：两个插件都没有自动测试脚本。Subsonic 的 npm 和 pnpm 锁文件与 `package.json` 不一致，当前只能把 build / validate 作为基础入口，无法用现有命令证明安全回归。

**目标**：
- 为 P0 建立无需真实 Songloft 服务和外部 Subsonic 客户端的最小测试接缝。
- 固定修复前失败特征和修复后通过标准。
- 记录当前构建环境缺口，不把环境缺失误报为代码通过。

**调研输出物**：
- Create: `songloft-plugin-subsonic/tests/server-cover-security.test.mjs` — 封面响应安全回归
- Modify: `songloft-plugin-subsonic/package.json` — 增加可重复的测试入口；若依赖锁定任务尚未执行，避免引入新依赖

**完成证据（2026-07-29）**：
- 已增加 `npm test`，先构建插件，再对实际构建产物执行服务端封面安全回归。
- 回归在修复前稳定 RED：歌曲和歌单封面均返回 `302`，且 `Location` 含固定 JWT 标记。
- 未新增测试依赖或修改锁文件；依赖锁漂移继续由 R1 统一处理。

**Steps:**
- **Step 1: 固定调用边界**
  - 提取或导出可注入依赖的封面处理逻辑，使用假的歌曲 API 和固定 Token。
- **Step 2: 建立失败断言**
  - 证明当前响应为 `302`，且 `Location` 包含宿主 `access_token`。
- **Step 3: 验证**
  - 测试必须能独立运行；构建和 manifest 验证分别记录结果。

---

## 1. 核心开发计划

<a id="task-v1"></a>
### Task V1: 锁定 DAV 同步身份与安全契约

**优先级**：🔴 P0（前置）
**状态**：✅ 已完成（宿主长任务生命周期验证留 D3）
**估时**：0.5–1 天
**依赖**：Issue [#336](https://github.com/songloft-org/songloft/issues/336)；宿主 songs / playlists bridge 当前契约；目标 Songloft 版本的插件执行时限与 VM 生命周期验证

**需求来源**：Issue #336 希望递归扫描指定 WebDAV 目录、按目录自动创建歌单，并在远端新增、删除、移动后通过重扫收敛。所给 event `28882990068` 仅表示指派给 Dev-Wiki，没有补充需求；评论建议优先在 DAV 插件实现。

**当前能力与缺口**：
- `src/client.ts:119` 已支持 Depth-1 PROPFIND；`static/js/app.js:385` 已支持手工导入当前目录歌曲、创建歌单和向已有歌单添加歌曲。
- 重复导入可以通过稳定 `dedup_key` 复用 Song ID，插件也已经声明 songs、playlists 和 storage 权限。
- 当前没有递归扫描器、扫描根模型、目录到歌单的稳定映射、上次成功快照、成员 reconciliation、任务状态或失败恢复。
- 配置显示名目前参与 DAV `dedup_key`；修改显示名会把同一远端曲库识别成新来源，不能沿用到自动同步。

**目标**：
- 为每个 DAV 配置引入不可随显示名变化的稳定配置 ID，并定义规范化资源身份；迁移后保持现有配置可用。
- 定义扫描根、generation、目录歌单映射、插件管理成员集合和最后一次成功快照的数据模型。
- 明确首版安全规则：同步不调用 `songs.delete`，只移除上次成功快照中由插件管理且本次确认消失的歌单成员。
- 用户手工加入管理歌单的歌曲不进入插件管理集合，因此重扫保留；目录消失时保留空歌单或标记失效，不自动删除歌单。
- 明确移动语义：文件移动按旧目录移除、新目录加入收敛；若服务端没有稳定资源 ID，目录改名不承诺保留原歌单 ID。

**Files:**
- Modify: `src/config.ts` — 稳定配置 ID、扫描根、generation、成功快照与目录歌单映射模型
- Modify: `src/client.ts` — 暴露扫描所需的规范化资源身份，继续强制 HTTP(S) 与同源凭据边界
- Create: `tests/dav-sync-model.test.mjs` — 配置改名、同名目录、快照迁移与管理成员边界回归

**Steps:**
- **Step 1: 固定身份契约**
  - 以稳定配置 ID 和规范化 DAV path / 可用资源 ID 生成歌曲及目录 key，不使用配置显示名作为身份。
- **Step 2: 固定 ownership 替代模型**
  - 在宿主没有 owner 字段时，由插件持久化 `directoryKey → playlistID` 和 managed song IDs；读取 playlist ID 后验证存在性，不按名称直接认领用户歌单。
- **Step 3: 固定提交门槛**
  - 只有完整扫描成功且 generation 未被更新任务取代时，才允许进入删除阶段并提交新快照。
- **Step 4: 验证宿主约束**
  - 在目标宿主上测量插件 HTTP 请求执行上限、后台 timer 处理和 VM 卸载/恢复；D3 使用持久 checkpoint 跨越单请求，并在 `onInit` 时恢复后台运行器。

**实现与验证证据（2026-08-19）**：
- `src/config.ts` 为旧配置一次性迁移并持久化稳定 ID、显示名别名、扫描根、generation、目录歌单映射和最后成功快照；配置表单只能白名单更新连接字段，不能覆盖同步状态。
- `src/client.ts` 以稳定配置 ID 和挂载相对的规范化同源 DAV path 生成资源、目录与歌曲去重键；新 `source_data` 使用 `configId`、显式相对 path 模式，播放、封面和歌词仍兼容旧 `configName`、旧挂载 path，以及严格命中历史受信任 endpoint 的绝对 href，配置改名或更换连接端点后旧歌曲可继续解析。
- generation 只允许完整且仍为当前代次的扫描提交快照；连接地址或凭据变化会推进 generation，旧任务不能覆盖新状态。
- `tests/dav-sync-model.test.mjs` 覆盖旧配置/快照迁移、改名与换挂载/主机后身份稳定、相对与历史绝对 href、编码 `#/?` 路径、同名目录隔离、异源拒绝、旧 generation/不完整结果拒绝提交和手工成员删除边界。
- D3 已完成真实宿主请求上限与 QuickJS VM 卸载/恢复验证；同步不依赖单个长请求，v1.2.3 由插件后台 timer 推进有界步骤并在 `onInit` 时恢复，设置页只读取状态。

<a id="task-d2"></a>
### Task D2: 手动递归扫描与目录歌单同步 MVP

**优先级**：🔴 P0
**状态**：✅ 已完成（外部 DAV 服务冒烟待上线前验收）
**估时**：2–3 天
**依赖**：V1；现有 songs / playlists bridge；WebDAV fixture（嵌套目录、空目录、同名目录、移动与部分失败）

**背景**：当前用户只能逐目录浏览、选择当前目录歌曲并导入。宿主本地扫描已有 `directory`、`top_level`、`bubble_up`、歌单 ID 复用、过期歌单清理和原子成员更新，但 `songloft/internal/database/playlist_repository.go:295` 的自动建歌单流程只读取 `TypeLocal` 并依赖 `FilePath`。DAV 歌曲是 `TypeRemote`，目录位于不透明 `source_data`，不能直接复用该流程，也不能混入全局 `auto_created` 清理域。

**目标**：
- 用户手动设置一个 WebDAV 扫描根，并手动执行扫描/重扫。
- 有界递归执行 Depth-1 PROPFIND；每个含音乐文件的目录创建或复用一个插件管理歌单。
- 首版歌单只包含该目录直接拥有的歌曲，不向父目录冒泡。
- 歌曲以稳定 `dedup_key` upsert；目录歌单通过持久化 ID 映射复用，不按名称猜测 ownership。
- 完整发现阶段成功后再做 reconciliation；先增后删，任一目录不完整、认证失败、取消或超时均跳过删除并保留旧成功快照。
- 远端文件消失时只从对应管理歌单移除插件管理成员，保留 Song 数据、用户歌单引用和已下载转本地的歌曲。

**Files:**
- Create: `src/scanner.ts` — 有界递归 PROPFIND、音频过滤、路径规范化、同源校验和扫描结果汇总
- Create: `src/sync.ts` / `src/sync-task.ts` — 扫描根视图，以及 Song、歌单与成员的可恢复幂等应用和成功快照提交
- Modify: `src/config.ts` — 扫描根、映射、generation 与快照持久化
- Modify: `src/router.ts` — 扫描根 CRUD 和手动运行入口的后端契约
- Test: `tests/dav-directory-sync.test.mjs` — 幂等、增删移动、同名目录、失败不删和凭据边界

**Steps:**
- **Step 1: 纯发现扫描**
  - 扫描器只生成规范化目录树与音频清单，不在遍历过程中修改歌曲或歌单；设置最大深度、最大条目数和取消检查点。
- **Step 2: 生成同步计划**
  - 对比最后成功快照，计算歌曲 upsert、歌单创建/复用、managed add/remove 和失效目录；用户手工成员不在 remove 集合中。
- **Step 3: 幂等应用**
  - 先 upsert Song 和添加缺失成员，再移除确认失踪的 managed 成员，最后保存新顺序、映射与快照；非原子 bridge 调用失败后，下次重跑可继续收敛。
- **Step 4: 失败保护**
  - generation 不匹配、任一必需目录失败、异源 href，以及删除门前的取消或进程中断都不进入删除阶段，也不覆盖上次成功快照；删除已经开始后的非原子局部失败由 D3 明确标记并重试收敛。
- **Step 5: 验证**
  - 连续两次同步同一快照必须 0 新增、0 删除；新增、删除和跨目录移动后成员精确收敛，歌单 ID 与确定性顺序保持稳定。

**实现与验证证据（2026-08-19）**：
- 新增 `src/scanner.ts`：使用 Depth-1 PROPFIND 做先发现后写入的有界 BFS，限制深度 32、条目 20000、目录 2000；非 207/不完整 multistatus、缺失或不可解析 status、失败 propstat、非直接子资源、挂载外路径、异源 href、任一目录失败或越界都会令整次发现失败。
- 新增 `src/sync.ts` 与 `src/sync-task.ts`：前者只维护扫描根视图，后者按插件入口、配置 ID/别名和规范化 path 领养旧手工导入，再只为尚不存在的资源批量 upsert 远程歌曲；重扫验证并复用已管理歌曲 ID，Song 被用户删除时自动重建，避免遗漏歌曲或覆盖用户/刮削后的元数据。目录歌单按持久化 `directoryKey → playlistID` 创建/复用，并使用目录身份派生的唯一名称绕开同名目录和用户同名歌单冲突。
- 所有添加完成并再次校验 generation 后才移除上次快照管理且本次消失的成员，从不调用 `songs.delete` 或删除歌单；映射在歌单创建后立即持久化，非原子 bridge 调用中断后可重跑收敛，映射歌单被用户删除时可安全重建且不按名称认领其他歌单。
- 设置页新增“音乐库同步”页签，可选择服务器、保存相对扫描根、手动执行扫描并查看管理歌单/歌曲、generation 和最近成功时间；动态远端字段继续通过 `textContent` 渲染，并补充键盘焦点、live region、窄屏布局和 reduced-motion 支持。
- `tests/dav-directory-sync.test.mjs` 覆盖旧手工导入领养、嵌套与同名目录首次同步、用户同名歌单隔离、连续幂等重扫、元数据保留、文件新增/删除/跨目录移动、用户手工成员保留、Song 与歌单缺失重建、确定性顺序，以及 200 HTML、截断 XML、207 缺失/异常 status、子资源 403、子目录 503 与异源 href 失败不写入/不删/不覆盖成功快照。
- Fresh verification：`npm run build && npm test` 通过，9 个测试文件全部通过；最终 ZIP 入口、JSC 行为与哈希契约回归通过。

<a id="task-d3"></a>
### Task D3: 同步任务状态、进度、取消与恢复

**优先级**：🟡 P1
**状态**：✅ 已完成
**估时**：1–2 天
**依赖**：V1、D2；目标宿主的插件任务生命周期验证

**背景**：大型曲库不能在一个插件 HTTP 请求内完成递归扫描和多轮 bridge 写入。同步状态机以持久 checkpoint 拆分有界步骤；v1.2.3 将步骤推进从设置页迁移到插件后台 timer，并在 VM 重载后的 `onInit` 中恢复 active task，页面关闭不再暂停任务。

**目标**：
- 运行接口立即返回 task ID，扫描和同步通过可恢复任务状态推进。
- 设置页展示扫描阶段、已扫描目录/歌曲数、写入进度、最近成功时间和失败原因。
- 支持取消与重试；删除前取消不覆盖成功快照，删除开始后明确返回 too-late。非原子删除若局部成功后失败，返回 `failed_partial`，保留旧成功快照并由重试收敛。
- 同一扫描根只允许一个有效 generation；旧任务完成时不能覆盖新任务状态。

**Files:**
- Create: `src/sync-task.ts` — 双槽持久 checkpoint、状态机、游标、进度、写前意图、取消/重试与 task/generation 栅栏
- Create: `src/sync-runner.ts` — 后台步骤调度、同任务去重、跨配置串行与 VM 重载续跑
- Modify: `src/main.ts` — 插件初始化恢复 active task，卸载时停止运行器
- Modify: `src/router.ts` — `run/status/advance/cancel/retry` 路由与配置删除时 checkpoint 清理
- Modify: `src/config.ts` — generation、临时 managed ownership、歌单创建意图和最近成功快照
- Modify: `static/js/app.js` — “设为扫描根目录”“扫描/重扫”“取消/重试”和进度显示
- Modify: `static/index.html` / `static/css/style.css` — 同步根与任务状态界面
- Test: `tests/dav-sync-task.test.mjs` — 立即返回、状态迁移、取消、旧 generation 隔离与失败恢复

**Steps:**
- **Step 1: 定义状态机**
  - 使用 `queued → scanning → applying → succeeded/failed/failed_partial/cancelled`；每次状态写入携带 config ID、root、task ID 与 generation。
- **Step 2: 拆分可恢复批次**
  - 每次扫描最多执行一个 15 秒 PROPFIND；Song 每批 100、成员 add/remove 每批 200。目录游标、稳定 ID 分页锚点、应用计划和累计结果写入交替双槽 checkpoint，恢复前校验 config、task 与 generation。
- **Step 3: 接入后台运行器与设置页**
  - 后台运行器持续推进有界步骤；设置页只轮询并显示扫描/应用阶段、进度、错误与最近成功时间。删除门前取消只设置意图，下一检查点退出。
- **Step 4: 宿主集成验证**
  - 用最终 `dav.jsplugin.zip` 在目标宿主以 JSC 字节码安装：`run` 在首次 PROPFIND 前返回 202；卸载 VM 后 `status` 能重新加载并恢复相同 task/checkpoint；随后通过真实 songs/playlists bridge 和本地 WebDAV fixture 完成同步。

**实现与验证证据（2026-08-19）**：
- `POST /sync-roots/:id/run` 立即返回 `{taskId,generation,status:'queued'}` 并启动后台运行器；`GET status`、`DELETE run` 和 `POST retry` 提供可观察、可取消、可恢复的任务契约，兼容的 `POST advance` 仍保留但设置页不再调用。同 generation 重复 run 复用 active task，新 run/配置连接变化以 task ID + generation 双栅栏隔离旧写入。
- 任务 checkpoint 不存凭据，只存 config ID、扫描/应用游标和规范化远端路径；两个 storage 槽按单调 checkpoint 号交替写入，损坏或中断时读取较新的有效槽。删除配置同步清理两个槽。
- Song 与歌单创建先持久化 write-ahead intent：Song 副作用后 checkpoint 丢失时先按稳定 ID 分页重新领养，不重复 upsert 覆盖用户元数据；歌单以任务专属 opaque intent marker 恢复插件刚创建的精确对象，不按普通名称认领。成员添加前持久化 provisional-managed journal，取消/失败后的新任务仍能安全清理插件已添加但尚未进入成功快照的成员。
- 完整发现和全部添加通过后才进入删除；add/remove 分块且可重入。删除阶段已经开始时取消明确返回 409 too-late；非原子局部失败标记 `failed_partial`，不伪称回滚，重试按旧成功快照与临时 ownership 收敛。强事务 replace 仍属 H1。
- `tests/dav-sync-task.test.mjs` 覆盖 202 立即返回、单次一个 PROPFIND、单调进度、VM context 重建、后台完成、`onInit` 续跑、后台取消、成功终态、实际 partial add 后取消及远端删除、故障持久化与 retry、apply 阶段栅栏、Song/歌单 mutation→checkpoint 注错、无重复/元数据保留、200 成员分块、稳定 ID 分页漂移、过迟取消、partial remove 和配置删除清理；全量 12 个测试文件通过。
- 旧版 UI 推进执行器已使用发布 ZIP、QuickJS JSC 模式、实际数据库及 songs/playlists bridge、本地严格 WebDAV fixture 完成真实宿主集成。v1.2.3 后台执行器已有构建产物、行为测试和宿主 timer 源码证据，关闭页面及宿主重启场景仍需上线前冒烟；宿主定时发起新扫描、原子 replace、Song GC 和自动删歌单仍留给 H1。

**MVP 非目标**：自动定时轮询、WebDAV change feed、父目录 bubble-up、全局 Song 删除、自动删除失效歌单，以及多个客户端同时编辑同一管理歌单的强事务一致性。

<a id="task-s0"></a>
### Task S0: 阻断 Subsonic 封面接口永久 JWT 泄露

**优先级**：🔴 P0
**状态**：✅ 已完成
**估时**：0.5 天
**依赖**：V0；宿主支持的 `serveFile` / 内部代理响应能力

**背景**：`src/server/index.ts` 的 `getCoverArt` 获取 100 年有效期的插件 JWT，再通过 `302 Location` 暴露给外部 Subsonic 客户端。该 Token 可通过 Songloft JWT 中间件访问宿主 API，且不在数据库中，不能单独撤销。

**目标**：
- 响应头、响应体和外部可见 URL 中不出现宿主 Token。
- 本地歌曲、远程歌曲及歌单封面仍通过宿主原有权限和缓存链路提供。
- 非法 ID、缺失歌曲或缺失封面不降级为 Token 重定向。

**Files:**
- Modify: `songloft-plugin-subsonic/src/server/index.ts` — 取消带 Token 的外部重定向，改用安全的服务端响应链路
- Create: `songloft-plugin-subsonic/tests/server-cover-security.test.mjs` — Token 不泄露及封面返回回归
- Modify: `songloft-plugin-subsonic/package.json` — 注册测试命令

**Steps:**
- **Step 1: Regression RED**
  - 使用固定敏感标记作为插件 Token，断言当前 `Location` 可以观察到该标记。
- **Step 2: 最小安全实现**
  - 首选不向客户端暴露内部 URL 的代理或受控 `serveFile`；不得将 Token 改放到 Cookie、自定义头或响应体。
- **Step 3: Regression GREEN**
  - 断言所有可见响应字段不含敏感标记；验证封面成功与错误分支。
- **Step 4: 部署处置**
  - 对曾启用服务端模式的实例记录 JWT secret 轮换要求；仅重启不足以撤销旧 Token。

**实现与验证证据（2026-07-29）**：
- 根因：`getCoverArt` 把宿主插件 JWT 放进客户端可见的 `302 Location`；宿主路由会原样转发该响应头。
- 实现：歌曲和歌单封面均改为插件运行时向宿主发起内部请求，再把图片字节、安全响应头和上游状态返回给客户端；非法 ID 在读取 Token 前返回 `404`，内部请求异常返回 `502`。
- Regression GREEN：5/5 场景通过，覆盖歌曲、歌单、非法 ID、宿主 `404` 和内部请求异常，所有客户端可见字段均不含 JWT。
- Fresh verification：`npm test`、`tsc --noEmit`、`npm run validate`、`git diff --check` 全部通过。
- ReviewDiffHash：`3ea4c2470ce7c3c86acf54ec5545ec82abf153b24d6248486d6827ed70391c39`，最终验证哈希一致。
- 运维边界：已部署且曾暴露此接口的实例仍需轮换 Songloft JWT secret；代码修复不能撤销已经泄露的长期 Token。

<a id="task-w1"></a>
### Task W1: 消除 DAV / Subsonic 前端 DOM XSS

**优先级**：🟡 P1
**状态**：✅ 已完成
**估时**：1 天
**依赖**：S0

**背景**：服务器名称、URL、DAV 文件名、Subsonic 歌名/歌手/专辑和歌曲 ID 被拼入 `innerHTML` 或内联 `onclick`。远端音乐服务可借此在携带 Songloft Token 的插件页面执行脚本。

**目标**：
- 所有远端文本通过 `textContent` 或安全属性赋值渲染。
- 所有交互通过 `addEventListener` 绑定，不把远端 ID 拼进 JavaScript 源码。
- 错误信息不通过 HTML 模板直接渲染。

**Files:**
- Modify: `songloft-plugin-dav/static/js/app.js` — 安全渲染服务器和目录项
- Modify: `songloft-plugin-subsonic/static/js/app.js` — 安全渲染服务器和媒体元数据
- Test: 两插件前端安全回归 — 覆盖标签、事件属性、引号和脚本协议载荷

**Steps:**
- **Step 1: 枚举注入点**
  - 搜索 `innerHTML`、内联事件和字符串模板中的远端字段。
- **Step 2: 结构化渲染**
  - 用 DOM API 创建节点；静态模板与动态文本分离。
- **Step 3: 验证**
  - 恶意名称只能显示为文本，不能创建额外元素或触发函数。

**实现与验证证据（2026-07-29）**：
- 根因：服务器名称/URL、DAV 文件名、Subsonic 歌曲/歌手/专辑和歌曲 ID 被拼入 `innerHTML` 或内联 `onclick`；远端返回值因此可成为 HTML 或 JavaScript 源码。
- 实现：动态列表改为 `createElement` 构造，远端标签统一使用 `textContent`；导入、选择、编辑和删除按钮使用 `addEventListener` 与闭包传参；远端错误信息也改为纯文本状态节点。
- Regression RED/GREEN：DAV 与 Subsonic 各 3/3 场景从失败转为通过，覆盖动态 HTML 模板、内联事件和文本赋值约束。
- Subsonic：语法检查、W1 回归、既有 P0 回归、build、validate 与差异检查全部通过；ReviewDiffHash `8ce877257ed6b5d429e445ab67c2b20c595fbbb0673219cca9517a3982938978`。
- DAV：语法检查、W1 回归、build 与差异检查通过；ReviewDiffHash `d1d0e457f972af6c74b53cc9129f50d35a4fbfcb7c09d9c2059eed152cc15eb0`。
- 已知边界：未连接真实 Songloft WebView 做视觉交互复核；DAV 发布物现由 R1 的最终 ZIP 契约验证入口与双层哈希。

<a id="task-d1"></a>
### Task D1: 阻断 DAV 跨主机凭据外送

**优先级**：🟡 P1
**状态**：✅ 已完成（宿主音频重定向仍有契约边界）
**估时**：0.5 天
**依赖**：S0

**背景**：DAV `buildStreamUrl` 信任远端返回的绝对 `href`，随后把当前 DAV 用户名和密码注入该 URL，即使目标主机与配置主机不同。

**目标**：
- 只允许配置 origin 下的 DAV 资源。
- 认证通过 SDK `{ url, headers }` 契约传递，不把用户名密码写入 URL。
- 重定向和绝对 `href` 均不得跨 origin 携带认证。

**Files:**
- Modify: `songloft-plugin-dav/src/client.ts` — URL 解析、origin 校验和认证头生成
- Modify: `songloft-plugin-dav/src/router.ts` — 播放解析返回安全 headers
- Test: DAV URL 安全回归 — 相对路径、同源绝对 URL、异源绝对 URL

**Steps:**
- **Step 1: 固定泄露复现**
  - 构造异源 `href`，证明当前结果包含 DAV 用户信息。
- **Step 2: 使用标准 URL 与 header 契约**
  - 拒绝异源资源；同源资源返回不含 userinfo 的 URL。
- **Step 3: 验证**
  - 覆盖 Unicode 用户名密码、路径编码及挂载前缀去重。

**实现与验证证据（2026-07-29）**：
- 根因：`buildStreamUrl` 信任绝对 `href`，随后无条件把当前 DAV 用户名和密码写入任意 HTTP(S) URL 的 userinfo；封面和歌词代理复用了同一路径。
- 实现：新增同源 `buildStreamRequest`，只允许 HTTP(S) 且要求目标 origin 与配置 origin 完全一致；URL 永不包含 userinfo，UTF-8 Basic Auth 通过 `{ url, headers }` 契约传递。
- 目录、封面、歌词与播放解析统一使用该边界；异源文件项从目录结果丢弃，PROPFIND / 封面 / 歌词请求使用宿主 `X-Fetch-No-Redirect` 控制头拒绝自动重定向。
- Regression RED：修复前 5/5 场景失败，表现为异源地址被接受、凭据进入 URL、封面请求到达攻击者 origin。
- Regression GREEN：最终 8/8 构建产物场景通过，新增覆盖目录异源项过滤及 PROPFIND/封面重定向。
- Fresh verification：`npm run build`、`npm test`、专用 D1 回归和 `git diff --check` 通过；ReviewDiffHash `bdcf089619b89282153e3d9723940407661ab74680c188eca04f1c5e9bac21f4`，最终哈希一致。
- 已知边界：宿主 SourceFetcher 消费 SDK headers 后的音频下载重定向由 Go HTTP client 控制；若要求对同域子域等场景也执行严格 origin 绑定，需要扩展宿主下载契约。

<a id="task-s1"></a>
### Task S1: 修复 Subsonic 搜索分页与聚合截断

**优先级**：🟡 P1
**状态**：✅ 已完成（宿主 Go 测试待 CI 补跑）
**估时**：1 天
**依赖**：V0；可能需要同步修改宿主与 Plugin SDK

**背景**：服务端读取 `songOffset/songCount`，但宿主 `songloft.songs.search(query)` 固定只返回前 20 条，后续 `slice` 不能实现分页。

**目标**：
- `search2/search3` 按请求 offset 和 count 返回稳定分页。
- 歌手与专辑聚合不被首 20 条搜索结果截断。
- 明确跨仓库 SDK 和宿主版本兼容边界。

**Files:**
- Modify: `plugin-toolchain/packages/plugin-sdk/src/global.d.ts` — 搜索 options 类型
- Modify: `songloft/internal/jsplugin/api_bridge.go` — 把 limit / offset 传到数据库桥接
- Modify: `songloft-plugin-subsonic/src/server/index.ts` — 使用真实分页能力
- Test: 宿主桥接测试和 Subsonic `search3` 多页回归

**Steps:**
- **Step 1: 锁定跨仓库接口**
  - 保持旧的单参数调用兼容，新增可选分页参数。
- **Step 2: 实现端到端分页**
  - SDK、桥接和插件共同传递 limit / offset。
- **Step 3: 验证**
  - 使用至少 45 条匹配歌曲验证第 1、2、3 页无重复、无漏项。

**实现与验证证据（2026-07-30）**：
- 根因：宿主注入的 `songloft.songs.search` 包装器只序列化 `query`，虽然 Go bridge 已解析 `limit/offset`，但缺参时固定回退为 20；SDK 类型也不允许插件传分页 options。
- 实现：宿主包装器和 SDK 增加可选 `{ limit, offset }`，保持旧单参数调用兼容；Subsonic `search2/search3` 对查询结果请求完整匹配集合，再分别执行歌曲、艺人和专辑分页。
- Regression RED：构建产物观察到 `search` 的 options 为 `undefined`，`songOffset=20` 无法得到下一页。
- Regression GREEN：45 条匹配歌曲按 20/20/5 分为三页，合并后 ID 1–45 无重复、无漏项；艺人和专辑聚合覆盖完整集合。
- Fresh verification：Subsonic `npm test`、`tsc --noEmit`、`validate` 与差异检查通过；Plugin SDK typecheck、build 与差异检查通过。
- 验证边界：当前环境没有 Go 工具链，宿主新增的 bridge 契约测试未能执行；源码契约检查已通过，仍需 CI 运行 `go test ./internal/jsplugin`。

<a id="task-s2"></a>
### Task S2: 修复 Subsonic → MIoT 搜索结果入库契约

**优先级**：🟡 P1
**状态**：✅ 已完成
**估时**：0.5 天
**依赖**：S0；MIoT 外部搜索结果契约

**背景**：`/api/search/topone` 返回带 `u/t/s` 的直接播放 URL 和 `source_data`，但缺少 `plugin_entry_path`、稳定去重键和歌词字段。MIoT 因此按普通外链入库，持久化鉴权 URL。

**目标**：
- 返回 `plugin_entry_path: "subsonic"` 和稳定 `dedup_key`。
- 通过 `source_data` 延迟解析播放，不持久化鉴权直链。
- 将歌词代理字段带进入库链路；质量与时长参与候选排序或明确移除无效参数。

**Files:**
- Modify: `songloft-plugin-subsonic/src/router.ts` — topone 响应和匹配策略
- Test: topone → MIoT RemoteSongItem 契约回归

**Steps:**
- **Step 1: 固定现有错误映射**
  - 证明 MIoT 会把当前结果作为纯外链导入。
- **Step 2: 改为解析型结果**
  - 返回插件入口、源数据、去重键和歌词信息。
- **Step 3: 验证**
  - 修改 Subsonic 密码后，已入库歌曲仍通过插件重新解析，而非使用旧 URL。

**实现与验证证据（2026-07-30）**：
- 根因：`/api/search/topone` 返回带 Subsonic 鉴权参数的播放和封面 URL，却没有 `plugin_entry_path` 与 `dedup_key`；MIoT 因而按普通外链入库。
- 实现：返回 `plugin_entry_path: "subsonic"`、稳定 `dedup_key` 和 `{ configName, songId }` 源数据，音频 `url` 留空并通过插件播放解析链路获取；歌词使用插件内部代理 URL，鉴权封面 URL 不再进入响应。
- Regression RED：构建产物返回含鉴权参数的 `stream` URL，且缺少解析型音源字段。
- Regression GREEN：响应不含固定密码标记，URL 为空，源数据、去重键和歌词代理字段完整。
- Fresh verification：Subsonic 4/4 构建产物回归、`tsc --noEmit`、build、validate 与差异检查全部通过。

<a id="task-r1"></a>
### Task R1: 恢复依赖锁定与发布可复现性

**优先级**：🟡 P1
**状态**：✅ 已完成
**估时**：0.5 天
**依赖**：确定 npm 或 pnpm 为唯一包管理器

**背景**：Subsonic `package.json` 使用 SDK `^2.9.0`，npm 锁仍为 `2.4.3`，pnpm 锁仍为 alpha 版本；项目版本和发布清单也没有覆盖最新主分支改动。DAV build 成功但 validate 因源 manifest 哈希为空失败。

**目标**：
- 选择并记录唯一锁文件来源。
- 干净环境可重复执行 install、test、build、validate。
- 发布版本、下载 URL、entryHash 和 zipHash 与产物一致。

**Files:**
- Modify: `songloft-plugin-subsonic/package-lock.json` 或 `pnpm-lock.yaml` — 保留选定工具的最新锁
- Modify: `songloft-plugin-subsonic/package.json` — 版本与验证脚本
- Modify: 两插件 `plugin.json` — 发布时由同一构建流程生成一致哈希
- Modify: CI 配置 — 冻结安装与验证

**Steps:**
- **Step 1: 决定包管理器**
  - 结合现有 CI 和团队发布命令选择 npm 或 pnpm，移除双锁漂移来源。
- **Step 2: 重建锁与验证链**
  - 从空 `node_modules` 执行冻结安装。
- **Step 3: 验证**
  - 构建两次并比较规范化产物哈希。

**阶段证据（2026-07-30，DAV v1.1.2 事故）**：
- 已确认 v1.1.2 Release 的 `plugin.json.main` 为 `main.js`，且 `entryHash` 与 `main.js` 完全一致；错误来自宿主校验时优先读取同包内残留的 `main.jsc`。
- 宿主改为严格按 `plugin.json.main` 读取、校验和执行入口，避免 manifest 与实际执行文件分叉。
- Plugin Builder 在每次构建前清空 `_build`，JSC 失败回退时删除可能已写出的 `main.jsc` 半成品。
- DAV v1.1.3 新增兼容构建层：先清理 `_build`，再对旧 Builder 产物移除未声明的同名入口并重算规范化 `zipHash`，因此不依赖 Builder 补丁先发布。
- DAV 新增最终 ZIP 契约测试，校验 manifest 精确入口、单一入口文件、`entryHash` 与规范化 `zipHash`；Release workflow 在上传资产前执行该门禁。
- 实际 v1.1.2 Release 在新门禁下稳定 RED（残留 `main.jsc`）；使用修复后 Builder 重建的 DAV 包稳定 GREEN，ZIP 仅含 `main.js`。
- Subsonic 选择 CI 已使用的 npm 作为唯一包管理器并删除漂移的 `pnpm-lock.yaml`；重建的 npm 锁将 SDK / Builder 固定到 `2.13.0`，版本统一为 v2.2.3。
- Subsonic 构建会清理 `_build`、移除未声明 sibling、重算规范化 `zipHash`，并同步仓库 manifest 与 ZIP 内 `main/entryHash/zipHash`。
- Regression GREEN：干净 `npm ci`、6/6 构建产物测试、TypeScript、build、validate 全部通过；最终 ZIP 仅含 `main.js`。
- DAV 与 Subsonic Release workflow 均禁止覆写既有版本，并在创建 Release 前执行最终包门禁。R1 完成。

---

## 2. 远期任务

<a id="task-c1"></a>
### Task C1: 协议兼容性与韧性收敛

**优先级**：🟢 P2
**状态**：📋 远期
**估时**：分拆后排期
**依赖**：P0 / P1 安全缺陷关闭；OpenSubsonic XML fixture；多种 DAV 服务 fixture

**目标**：
- 修正 XML 文本节点序列化，并实现 `getOpenSubsonicExtensions` 能力声明。
- 使用稳定专辑身份，避免不同歌手同名专辑串歌。
- 用结构化 endpoint builder 取代 `.replace("stream", "getCoverArt")`。
- 支持非 ASCII DAV Basic Auth 和 Subsonic `enc:` 密码。
- 加固 DAV XML `propstat/status`、非法百分号和 Unicode 实体处理。
- 为外部请求增加逐源超时、取消和 `allSettled` 隔离。

**备注**：这些问题相互独立，实施时拆成协议序列化、身份模型、认证编码、DAV 解析和网络韧性五个可单独回归的任务。

<a id="task-h1"></a>
### Task H1: 宿主管理资源身份、原子同步与调度扩展

**优先级**：🟢 P2
**状态**：📋 远期
**估时**：暂不排期
**依赖**：D2 / D3 MVP 运行数据；Songloft 主仓库的数据模型、迁移、JS bridge 权限与 scheduler 设计

**目标**：
- 为受管理歌单增加 `owner_plugin_entry_path + external_key` 唯一身份，插件 A 无权修改插件 B 的受管理资源。
- 提供按插件来源与 dedup 前缀查询歌曲，以及事务化 `upsertManagedPlaylistAndReplaceSongs`，确保成员替换全成或全败。
- 提供严格限定的孤儿清理：仅当前插件拥有、仍为 remote、且不属于用户/非管理歌单的歌曲可删除；已下载转 local 的歌曲永不删除。
- 提供宿主 scheduler 定时发起新扫描；已发起任务的推进与 VM 恢复继续由插件持久 checkpoint 和后台运行器负责。

**建议实现范围**：
- Modify: `songloft/internal/database` — managed playlist identity、事务替换、来源过滤和安全 orphan GC
- Modify: `songloft/internal/jsplugin/api_bridge.go` — ownership 校验、受管理歌单同步与任务 API
- Modify: `songloft/internal/services` — provider-scoped scheduler 和取消/恢复语义
- Test: 宿主 repository / service / bridge — 多插件隔离、事务回滚、用户引用保护、local 转换保护与定时恢复

**备注**：宿主本地 auto-created playlist 的事务和测试可作为算法模板，但 DAV remote 不能加入同一个清理域。H1 完成前，插件 MVP 不执行全局 Song 删除、不承诺原子 replace，也不会定时自动发起新的扫描；用户手动发起的任务可在插件后台完成。

---

## 3. 验证基线

### 3.1 开发期验证

```bash
cd songloft-plugin-subsonic
npm test
npm run build
npm run validate

cd ../songloft-plugin-dav
npm test
npm run build
npm run validate
```

两个项目现均提供 `npm test` 和最终 ZIP 契约验证；Subsonic 使用 npm 作为唯一锁来源。DAV 的发布物校验使用 `npm run build && npm test`，因为 Builder 的 `validate` 只检查源 manifest 字段格式，不读取最终 ZIP。

### 3.2 模块验收

- V0：安全回归能独立运行并稳定区分修复前后。
- S0：外部 Subsonic 响应中不存在 Songloft Token，封面仍可访问。
- W1：恶意远端元数据只能显示为文本。
- D1：异源 DAV `href` 被拒绝，任何 URL 都不包含 DAV userinfo。
- V1：修改 DAV 配置显示名不改变歌曲身份；两个配置中的同名目录 key 和歌单映射互不覆盖。
- D2：相同快照连续同步两次为 0 新增、0 删除；新增、删除、移动后管理成员精确收敛；失败快照不触发删除。
- D3：大目录运行立即返回 task ID，状态与进度可观察，可取消和重试，VM 重载后从有效 checkpoint 恢复，旧 task/generation 不能覆盖新任务；删除局部失败如实标记并可重试收敛。
- S1：至少三页搜索结果无重复、无截断。
- S2：MIoT 导入结果使用 Subsonic 插件解析链路。
- R1：干净环境冻结安装和发布验证通过。

### 3.3 上线前验收

- 对曾启用旧 Subsonic 服务端模式的实例轮换 Songloft JWT secret。
- 使用至少一个 JSON 客户端和一个 XML 客户端完成 Subsonic 冒烟。
- 使用包含 Unicode、空格、百分号和异源绝对 `href` 的 DAV fixture 完成冒烟。
- 使用至少两个 DAV 配置和嵌套目录完成扫描/重扫冒烟，确认同名目录隔离、用户手工成员保留、部分失败不删。
- 在目标 Songloft 版本验证大型扫描立即返回、关闭页面后后台推进、取消与 VM/宿主重启恢复。
- 发布包内 manifest 哈希与实际入口和规范化 zip 内容一致。

---

## 4. 风险与维护规则

- **永久 Token 处置**：S0 代码修复不会撤销此前已经泄露的 Token，部署说明必须包含 secret 轮换。
- **跨仓库接口**：S1 涉及 Plugin SDK、宿主和插件三个仓库，必须保持旧插件调用兼容。
- **外部数据不可信**：DAV XML、Subsonic JSON/XML、歌曲元数据、错误响应均按不可信输入处理。
- **同步删除边界**：D2 / D3 不调用 `songs.delete`；只从插件管理歌单移除上次成功快照拥有且本次完整扫描确认失踪的成员。用户手工成员、普通歌单引用和 local 歌曲必须保留。
- **非原子 bridge**：当前 add/remove 是多次调用，失败可能部分应用；实现必须先增后删、以 generation 和成功快照保证重试收敛，强事务语义留给 H1。
- **歌单 ownership**：宿主没有 owner 字段时只信任插件持久化的 playlist ID 映射，不按名称认领或删除歌单。
- **长任务生命周期**：同步依赖持久 checkpoint 和插件后台 timer 推进有界步骤，`onInit` 恢复 active task；设置页只轮询状态。宿主 scheduler 仅用于未来定时发起新的扫描。
- **发布确定性**：锁文件、版本和哈希不得手工分散维护，应由单一发布命令生成并校验。
- **进度同步**：任务状态变化后，同步更新 [Dashboard.md](Dashboard.md) 的索引状态和本文件验证证据。

---

*最后更新: 2026-08-19（D3 已支持手动发起后由插件后台完成；H1 强事务与定时自动发起扫描仍为远期）*

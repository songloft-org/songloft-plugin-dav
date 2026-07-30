# Songloft DAV / Subsonic 当前任务详情清单

[TOC]

> [!NOTE]
> 本文档是 [Dashboard.md](Dashboard.md) 的执行层。来源为 2026-07-29 对两个插件 `origin/main`、宿主 JS 插件路由和 Plugin SDK 契约的代码审查。
>
> **当前主题**：优先消除凭据泄露和远端内容注入，再恢复搜索、入库、协议与发布链路的确定性。

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
**状态**：✅ 已完成（DAV validate 存在既有 R1 缺口）
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
- 已知边界：未连接真实 Songloft WebView 做视觉交互复核；DAV `validate` 仍因源 `plugin.json` 的 `entryHash` / `zipHash` 为空而失败，该问题不由 W1 引入，继续由 R1 处理。

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
- 已知边界：宿主 SourceFetcher 消费 SDK headers 后的音频下载重定向由 Go HTTP client 控制；若要求对同域子域等场景也执行严格 origin 绑定，需要扩展宿主下载契约。DAV 既有 typecheck 与 manifest validate 失败继续由 R1 处理。

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
**状态**：🚧 进行中
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
- 待完成：分别提交并发布宿主、Plugin Builder 与 DAV v1.1.3；不得覆写既有 v1.1.2 资产。Subsonic 的双锁漂移仍作为 R1 剩余项处理。

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

目前两个项目尚未都提供 `npm test`，Subsonic 锁文件也未同步；V0 和 R1 负责让上述命令成为可信入口。

### 3.2 模块验收

- V0：安全回归能独立运行并稳定区分修复前后。
- S0：外部 Subsonic 响应中不存在 Songloft Token，封面仍可访问。
- W1：恶意远端元数据只能显示为文本。
- D1：异源 DAV `href` 被拒绝，任何 URL 都不包含 DAV userinfo。
- S1：至少三页搜索结果无重复、无截断。
- S2：MIoT 导入结果使用 Subsonic 插件解析链路。
- R1：干净环境冻结安装和发布验证通过。

### 3.3 上线前验收

- 对曾启用旧 Subsonic 服务端模式的实例轮换 Songloft JWT secret。
- 使用至少一个 JSON 客户端和一个 XML 客户端完成 Subsonic 冒烟。
- 使用包含 Unicode、空格、百分号和异源绝对 `href` 的 DAV fixture 完成冒烟。
- 发布包内 manifest 哈希与实际入口和规范化 zip 内容一致。

---

## 4. 风险与维护规则

- **永久 Token 处置**：S0 代码修复不会撤销此前已经泄露的 Token，部署说明必须包含 secret 轮换。
- **跨仓库接口**：S1 涉及 Plugin SDK、宿主和插件三个仓库，必须保持旧插件调用兼容。
- **外部数据不可信**：DAV XML、Subsonic JSON/XML、歌曲元数据、错误响应均按不可信输入处理。
- **发布确定性**：锁文件、版本和哈希不得手工分散维护，应由单一发布命令生成并校验。
- **进度同步**：任务状态变化后，同步更新 [Dashboard.md](Dashboard.md) 的索引状态和本文件验证证据。

---

*最后更新: 2026-07-30（S2 入库契约已完成；下一任务 R1）*

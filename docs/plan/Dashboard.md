# Songloft DAV / Subsonic 安全与兼容性看板

[TOC]

> [!IMPORTANT]
> **本文档是两个音源插件风险治理计划的索引层**。
> 规则：这里只维护优先级、状态、覆盖关系和验收范围；实现细节统一维护在 [TaskDetails.md](TaskDetails.md)。
>
> 开始新任务前，先确认本看板状态，再进入对应任务详情执行。

---

## 1. 进度快照

- **核心阶段**：高优先级安全边界已收敛，正在治理 P1 发布可复现性
- **当前瓶颈**：DAV 已具备兼容旧 Builder 的发布归一化与门禁；Plugin Builder 补丁、宿主修复及 Subsonic 锁文件仍需分别发布收尾
- **首版目标**：安全边界、Subsonic 搜索分页及 MIoT 入库契约已修复；下一步恢复发布可复现性
- **需求状态**：来源为 2026-07-29 对 `origin/main` 的代码审查；没有独立 PRD、交互原型或正式协议验收矩阵

---

## 2. 当前产品目标

保证 WebDAV 与 Subsonic 插件在接入不完全可信的远端音乐服务、外部播放器和 MIoT 插件时，不泄露 Songloft 或媒体源凭据，不允许远端元数据在宿主页面执行脚本，并保持搜索、导入、歌词、专辑与构建发布链路的数据一致性。

**本次聚焦**：修复已由代码证据确认的安全和功能缺陷。新增协议能力、大规模架构重写及性能专项暂缓到 P2。

---

## 3. 需求索引表

| 需求项 | 优先级 | 状态 | 专题层 / 详情 |
|------|--------|------|-------------|
| **V0 — 建立可重复验证基线** | 🔴 P0 | ✅ 已完成 | [TaskDetails.md](TaskDetails.md#task-v0) |
| **S0 — 阻断 Subsonic 封面接口永久 JWT 泄露** | 🔴 P0 | ✅ 已完成 | [TaskDetails.md](TaskDetails.md#task-s0) |
| **W1 — 消除 DAV / Subsonic 前端 DOM XSS** | 🟡 P1 | ✅ 已完成* | [TaskDetails.md](TaskDetails.md#task-w1) |
| **D1 — 阻断 DAV 跨主机凭据外送** | 🟡 P1 | ✅ 已完成* | [TaskDetails.md](TaskDetails.md#task-d1) |
| **S1 — 修复 Subsonic 搜索分页与聚合截断** | 🟡 P1 | ✅ 已完成* | [TaskDetails.md](TaskDetails.md#task-s1) |
| **S2 — 修复 Subsonic → MIoT 搜索结果入库契约** | 🟡 P1 | ✅ 已完成 | [TaskDetails.md](TaskDetails.md#task-s2) |
| **R1 — 恢复依赖锁定与发布可复现性** | 🟡 P1 | 🚧 进行中 | [TaskDetails.md](TaskDetails.md#task-r1) |
| **C1 — 协议兼容性与韧性收敛** | 🟢 P2 | 📋 远期 | [TaskDetails.md](TaskDetails.md#task-c1) |

---

## 4. 需求覆盖矩阵

| 来源能力 | 需求描述 | 首版覆盖 | 说明 |
|---------|---------|---------|------|
| Subsonic 服务端封面 | 外部客户端不能获得 Songloft 插件 JWT | ✅ | S0 |
| 两插件管理与浏览页 | 远端名称、URL、歌曲元数据不得执行 HTML/JS | ✅ | W1 |
| DAV 播放解析 | 远端绝对 `href` 不得把 DAV 凭据带到其他主机 | ✅ | D1 |
| Subsonic `search3` | 分页结果不能被宿主默认 20 条上限截断 | ✅ | S1 |
| MIoT 外部搜索 | 结果应作为插件解析型音源入库，不持久化鉴权直链 | ✅ | S2 |
| 构建与发布 | npm / pnpm 锁文件、版本、哈希和验证命令保持一致 | ✅ | R1 |
| XML、专辑、认证、超时 | 修复已知兼容性与稳定性缺口 | ⏭️ | C1，P2 分批实施 |

---

## 5. 当前缺口与起手任务

1. **V0 — 建立可重复验证基线**（✅ 完成）：已增加构建产物级安全回归和 `npm test` 入口；锁文件漂移留在 R1 处理。
2. **S0 — 阻断永久 JWT 泄露**（✅ 完成）：封面改为插件服务端内部代理，客户端不再收到含 Token 的重定向。
3. **W1 — 消除 DOM XSS**（✅ 完成*）：两插件远端元数据已迁移到 `textContent` 和结构化 DOM，动态按钮改用闭包事件。
4. **D1 — 阻断 DAV 跨主机凭据外送**（✅ 完成*）：异源绝对 `href` 被拒绝，认证从 URL userinfo 迁移到 SDK header 契约，插件内代理禁止自动重定向。
5. **S1 — 修复 Subsonic 搜索分页**（✅ 完成*）：SDK、宿主 bridge 和插件已传递真实 limit/offset，45 条匹配数据的三页回归无重复、无漏项。
6. **S2 — 修复 Subsonic → MIoT 入库契约**（✅ 完成）：`topone` 改为插件解析型结果，不再返回或持久化 Subsonic 鉴权直链，并携带稳定去重键与歌词代理字段。
7. **R1 — 修复 DAV 1.1.2 发布哈希不匹配**（🚧 进行中）：宿主严格读取 manifest 入口，Builder 清理脏目录和失败 JSC 半成品；DAV v1.1.3 构建会归一化旧 Builder 产物，并在上传前验证最终 ZIP。

> 当前顺序：R1；C1 按兼容性收益分批进入。
> \* W1 安全回归和构建已通过；DAV 源 manifest 的空哈希仍导致 `validate` 失败，属于既有 R1 发布基线缺口。
> \* D1 插件边界已修复；宿主 SourceFetcher 对音频下载重定向的严格 origin 绑定仍需宿主级契约支持。
> \* S1 的 Subsonic 构建产物回归、SDK typecheck/build 已通过；当前环境缺少 Go 工具链，宿主 Go 回归待 CI 补跑。

---

## 6. 验收口径

- 任意已认证 Subsonic 客户端调用 `getCoverArt`，响应头和可见 URL 中均不出现 Songloft `access_token`。
- 修复后的封面接口仍支持真实封面返回、缺失封面和非法歌曲 ID。
- 回归测试在修复前稳定失败、修复后稳定通过，并覆盖 Token 不泄露断言。
- S0 当前证据：5 个安全场景通过，TypeScript、build、validate 与差异检查均通过；最终差异哈希与审查哈希一致。
- W1 当前证据：DAV / Subsonic 各 3 个静态安全场景均由 RED 转 GREEN；两边构建通过，Subsonic validate 通过。
- D1 当前证据：8 个构建产物级凭据边界场景通过，覆盖异源 href、URL userinfo、Unicode Basic Auth、目录过滤及 PROPFIND/封面重定向。
- 两插件后续 P1 任务均有独立回归，且构建、验证命令可从干净依赖环境重复执行。
- 每完成一个任务，同步更新本看板和任务详情的状态及验证证据。

---

*最后更新: 2026-07-30（DAV 1.1.2 哈希事故已完成代码修复与产物门禁；R1 待发布链收尾）*

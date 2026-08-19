# Songloft DAV / Subsonic 安全、兼容性与音乐库自动化看板

[TOC]

> [!IMPORTANT]
> **本文档是两个音源插件风险治理与 DAV 音乐库自动化计划的索引层**。
> 规则：这里只维护优先级、状态、覆盖关系和验收范围；实现细节统一维护在 [TaskDetails.md](TaskDetails.md)。
>
> 开始新任务前，先确认本看板状态，再进入对应任务详情执行。

---

## 1. 进度快照

- **核心阶段**：Issue [#336](https://github.com/songloft-org/songloft/issues/336) 的 V1 身份、D2 目录同步和 D3 可恢复任务已完成
- **当前瓶颈**：宿主尚无插件资源 ownership、原子替换、孤儿 GC 与无人值守 scheduler；这些强语义留在 H1
- **首版目标**：用户设置 DAV 扫描根并手动重扫，按目录幂等维护插件管理歌单；发现不完整时不写入，非原子应用失败时保留旧成功快照并可重试收敛（已完成）
- **需求状态**：Issue #336 仍为开放状态；设置页、可恢复任务、真实宿主 QuickJS/JSC 与本地 WebDAV fixture 集成均已验证，外部 DAV 服务冒烟留上线前执行

---

## 2. 当前产品目标

保证 WebDAV 与 Subsonic 插件在接入不完全可信的远端音乐服务、外部播放器和 MIoT 插件时，不泄露 Songloft 或媒体源凭据，不允许远端元数据在宿主页面执行脚本，并保持搜索、导入、歌词、专辑与构建发布链路的数据一致性。DAV 插件进一步提供可恢复、可重复执行的目录扫描与歌单同步，替代逐目录、逐文件手工导入。

**本次聚焦**：先交付手动扫描/重扫的插件 MVP，只维护插件拥有的同步快照和歌单成员，不全局删除歌曲，也不自动删除可能被用户编辑的歌单。宿主 ownership、事务化替换、安全孤儿清理和 scheduler 暂列 P2。

---

## 3. 需求索引表

| 需求项 | 优先级 | 状态 | 专题层 / 详情 |
|------|--------|------|-------------|
| **V0 — 建立可重复验证基线** | 🔴 P0 | ✅ 已完成 | [TaskDetails.md](TaskDetails.md#task-v0) |
| **V1 — 锁定 DAV 同步身份与安全契约** | 🔴 P0 | ✅ 已完成* | [TaskDetails.md](TaskDetails.md#task-v1) |
| **D2 — 手动递归扫描与目录歌单同步 MVP** | 🔴 P0 | ✅ 已完成* | [TaskDetails.md](TaskDetails.md#task-d2) |
| **D3 — 同步任务状态、进度、取消与恢复** | 🟡 P1 | ✅ 已完成* | [TaskDetails.md](TaskDetails.md#task-d3) |
| **S0 — 阻断 Subsonic 封面接口永久 JWT 泄露** | 🔴 P0 | ✅ 已完成 | [TaskDetails.md](TaskDetails.md#task-s0) |
| **W1 — 消除 DAV / Subsonic 前端 DOM XSS** | 🟡 P1 | ✅ 已完成* | [TaskDetails.md](TaskDetails.md#task-w1) |
| **D1 — 阻断 DAV 跨主机凭据外送** | 🟡 P1 | ✅ 已完成* | [TaskDetails.md](TaskDetails.md#task-d1) |
| **S1 — 修复 Subsonic 搜索分页与聚合截断** | 🟡 P1 | ✅ 已完成* | [TaskDetails.md](TaskDetails.md#task-s1) |
| **S2 — 修复 Subsonic → MIoT 搜索结果入库契约** | 🟡 P1 | ✅ 已完成 | [TaskDetails.md](TaskDetails.md#task-s2) |
| **R1 — 恢复依赖锁定与发布可复现性** | 🟡 P1 | ✅ 已完成 | [TaskDetails.md](TaskDetails.md#task-r1) |
| **C1 — 协议兼容性与韧性收敛** | 🟢 P2 | 📋 远期 | [TaskDetails.md](TaskDetails.md#task-c1) |
| **H1 — 宿主管理资源身份、原子同步与调度扩展** | 🟢 P2 | 📋 远期 | [TaskDetails.md](TaskDetails.md#task-h1) |

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
| DAV 目录扫描 | 递归扫描指定根目录并过滤可导入音频 | ✅ MVP | V1、D2 |
| 目录自动建歌单 | 每个含音乐文件的目录映射到稳定的插件管理歌单 | ✅ MVP | D2；首版不向父目录冒泡 |
| DAV 重扫同步 | 新增、删除、移动后成员精确收敛，失败不误删 | ✅ MVP | D2、D3；仅变更插件管理成员 |
| 长任务体验 | 立即返回任务 ID，并支持状态、进度、取消、重试 | ✅ | D3；设置页显式推进，非无人值守 scheduler |
| 安全孤儿清理 | 只删除当前插件拥有且未被用户引用的远程孤儿 | ⏭️ | H1，依赖宿主 ownership 与事务能力 |
| XML、专辑、认证、超时 | 修复已知兼容性与稳定性缺口 | ⏭️ | C1，P2 分批实施 |

---

## 5. 当前缺口与起手任务

1. **H1 — 宿主强语义扩展**（🟢 P2）：补足 ownership、事务化 replace、安全 orphan GC 和 scheduler，再考虑自动轮询与全局清理。
2. **C1 — 协议兼容性与韧性**（🟢 P2）：与目录同步解耦，继续按 XML、身份、认证和网络 fixture 分批实施。

> 起手顺序：V1 → D2 → D3。H1 与 C1 不阻塞插件 MVP，但 H1 阻塞自动安全清理和强一致自动同步。

---

## 6. 验收口径

- 任意已认证 Subsonic 客户端调用 `getCoverArt`，响应头和可见 URL 中均不出现 Songloft `access_token`。
- 修复后的封面接口仍支持真实封面返回、缺失封面和非法歌曲 ID。
- 回归测试在修复前稳定失败、修复后稳定通过，并覆盖 Token 不泄露断言。
- S0 当前证据：5 个安全场景通过，TypeScript、build、validate 与差异检查均通过；最终差异哈希与审查哈希一致。
- W1 当前证据：DAV / Subsonic 各 3 个静态安全场景均由 RED 转 GREEN；两边构建通过，Subsonic validate 通过。
- D1 当前证据：8 个构建产物级凭据边界场景通过，覆盖异源 href、URL userinfo、Unicode Basic Auth、目录过滤及 PROPFIND/封面重定向。
- 同一 DAV 快照连续同步两次时，0 新增、0 删除，歌单 ID、成员和顺序保持不变。
- DAV 新增、删除或移动文件后，插件管理成员精确收敛；目录发现、Song 写入或添加阶段失败时不进入删除，删除阶段的非原子局部失败明确标记 `failed_partial` 并可重试收敛。
- 两个配置中的同名目录互不覆盖，修改配置显示名不会把整库识别为新歌曲。
- 异源 DAV `href` 不发送凭据；用户普通歌单仍引用或已下载转成本地的歌曲不得被同步删除。
- 大目录同步可观察进度，可取消、重试；中断后最后一次成功快照仍有效。
- 两插件后续 P1 任务均有独立回归，且构建、验证命令可从干净依赖环境重复执行。
- 每完成一个任务，同步更新本看板和任务详情的状态及验证证据。
- V1 / D2 / D3 当前证据：稳定 ID 与旧导入迁移、同名目录隔离、嵌套扫描、增删移动、严格 207/同源边界、任务立即返回、双槽 checkpoint、VM 重载恢复、generation/task 双栅栏、取消/过迟取消、写前意图、临时 ownership、故障后无重复歌单或元数据覆盖、部分删除重试收敛和有界批次等回归通过；`npm run build && npm test` 共 9 个测试文件通过，并已用发布 ZIP 在真实宿主 QuickJS/JSC、实际 songs/playlists bridge 和本地 WebDAV fixture 上集成验证。

---

*最后更新: 2026-08-19（完成 Issue #336 的 V1、D2 与 D3 手动可恢复同步；H1 强事务与无人值守调度仍为远期）*

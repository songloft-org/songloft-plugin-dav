# Changelog

## [1.1.3] - 2026-07-30
### Fixed
- 修复发布包可能同时残留 `main.js` / `main.jsc` 并导致 `entryHash`、`zipHash` 校验失败的问题；构建前清理中间目录，并增加最终 ZIP 契约校验。
- 恢复 npm 单锁文件的可复现安装，发布流程禁止覆写已存在的版本。

### Security
- 阻止异源 WebDAV `href`、封面地址和重定向携带认证信息，避免凭据跨主机外送。
- 修复配置页动态内容直接写入 HTML 和内联事件处理器导致的 DOM XSS 风险。

## [1.1.2] - 2026-07-28
### Added
- 支持将 WebDAV 音乐导入已有歌单。

## [1.1.1] - 2026-06-24
### Fixed
- 恢复 `package-lock.json`，确保 CI 中的 `npm ci` 可以正常执行。

## [1.1.0] - 2026-06-24
### Fixed
- 修复 XML 实体解码、PROPFIND URL 编码和浮动操作按钮样式问题。

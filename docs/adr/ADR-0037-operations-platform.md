# ADR-0037：Backup、Export/Import、JSON-RPC 与平台基线

- 状态：Accepted
- 日期：2026-08-22
- 上位契约：[实施规格 §18～20](../spec/implementation-v0.2.md#18-backupexportimport-与-restore)

## 决策

平台固定 ESM、pnpm 11.7.0、Node `^22.19.0 || >=24.0.0` 和 `node:sqlite`。Windows 11 x64 为主要平台，Linux x64 为阻塞平台，macOS 尽力兼容。JSON-RPC 只允许 stdio、本机 Pipe/Socket 或 127.0.0.1。Backup 是 SQLite 一致副本，Export 是不含 Secret 的逻辑包。

## 结果

Phase 0 固定工具链、SQLite 配置和 Windows/Linux × Node 22.19/24 CI；不实现 Backup、Import、Restore 或 JSON-RPC。数据库只允许本地磁盘，不支持 SMB、NFS 或同步盘目录。

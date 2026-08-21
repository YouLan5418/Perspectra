# ADR-0037：Backup、Export/Import、JSON-RPC 与平台基线

- 状态：Accepted
- 日期：2026-08-22
- 上位契约：[实施规格 §18～20](../spec/implementation-v0.2.md#18-backupexportimport-与-restore)

## 决策

平台固定 ESM、pnpm 11.7.0、Node `^22.19.0 || >=24.0.0` 和 `node:sqlite`。Windows 11 x64 为主要平台，Linux x64 为阻塞平台，macOS 尽力兼容。JSON-RPC 只允许 stdio、本机 Pipe/Socket 或 127.0.0.1。Backup 是 SQLite 一致副本，Export 是不含 Secret 的逻辑包。

## 结果

Phase 5 已实现 SQLite 一致 World Backup/Restore、Canonical authority-only `.dshworld` 逻辑 Export/Import，以及无网络监听的进程内 JSON-RPC 与 stdio CLI。所有目标采用“已存在即拒绝”，恢复和导入验证 Hash、Schema、quick_check 与 Event Envelope。数据库仍只允许本地磁盘；远程监听、SMB、NFS 和同步盘目录不在 V0 范围。

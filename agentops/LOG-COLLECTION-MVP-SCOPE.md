# AgentOps 日志采集最小落地范围

| 项目 | 内容 |
|---|---|
| 日期 | 2026-11-13 |
| 目标 | 停止扩张设计范围，按可交付切片开始实现 |
| 当前版本 | M4 bundle 接线完成 |
| 完整设计参考 | `LOG-COLLECTION-MIGRATION-DESIGN-v9.md` |

## 已完成

M1 task registry：

- `tenant_key + task_id` 唯一；
- 任务引用既有 SSH 实例 ID，不保存 host、账号、密码；
- 远端路径仅允许绝对 POSIX 路径；
- 本地目录固定为 `<root>/<tenant>/<task-id>`；
- 任务 ACL 必须显式授权；
- revision 乐观锁；
- 软删除且 task id 不复用。

M2 pull path：

- 先校验任务 ACL；
- 先验证 host-key pin；
- host-key 成功后才读取 credential；
- 只使用 SFTP，不执行远端 shell；
- 本地临时文件 `fsync` 后 rename。

M3 capability + tool：

- SSH capability schema 增加 `host_key_sha256`；
- capability instance view 增加 `credentialGeneration`；
- `CapabilitySshResolver` 分离 config 与 credential；
- `pull_logs` 只接受 `log_task_id`。

M4 bundle 接线：

- `@agentops/dsh-log-collection` 已加入 AgentOps root bundle；
- `@agentops/dsh-log-collection/tools` 已挂到 `log_puller` preset；
- `log_puller` 工具白名单由生成器写入 `only: ["pull_logs"]`；
- workflow/Agent 输入从 `pull_source_id` 改为 `log_task_id`；
- tool-map 已把 `pull_logs` 映射到新插件。

## 尚未完成

- 实际 capability DB 中 MaxKB 实例写入 `host_key_sha256`；
- 创建真实日志采集任务和 ACL；
- MaxKB 专用只读账号；
- 一次真实受控 E2E；
- run/lease/snapshot/receipt；
- UI、迁移、通知；
- Workflow Manager 扩展。

## 下一步

M5 只做受控 E2E：

1. 在 MaxKB SSH 实例配置写入正确 host-key pin；
2. 创建 `oa_approval` 任务与 `log_puller` ACL；
3. 用真实只读账号执行 `pull_logs({log_task_id:"oa_approval"})`；
4. 核对本地文件、大小和失败路径；
5. E2E 通过后再讨论 run/receipt 持久化。
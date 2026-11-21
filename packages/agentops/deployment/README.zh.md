---
description: "AgentOps 发布能力：本地构建清单、SSH 生产更新、带时间戳镜像备份、持久发布 journal、健康检查与回滚。"
kind: "package-reference"
---

# @agentops/dsh-deployment

[English](README.md) | 中文

## 概述

本包把产物生产与生产发布分开。`artifact_build` 在已授权的本地构建实例中写 release manifest；deployment tools 校验引用的 SSH instance，记录当前 image id，创建带时间戳的 backup tag，上传并校验 artifact，执行配置的 release command，并持久化到 `deployment.db`。

## 目录

- [使用方式](#use-this-package)
- [配置](#configuration)
- [Model Experience](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>

## 使用方式

根插件挂载一次，`/tools` 插件挂在 `deploy_operator` 与 `build_operator` preset 中。Deployment tools 要求同一 preset 同时绑定 deployment 与 SSH；build tools 只解析 artifact-build instance，不持有生产 SSH 凭证。

Default release journal：`$DSH_HOME/agentops/deployment.db`。如果组合了 `ctx.jobs`，它只能显示实时进度，不是持久 release record。

参考入口位于 `scripts/`：`build-image.ps1` 在 Windows 上同步项目构建上下文、构建镜像并导出归档；`deploy-image.sh` 执行带锁的远端镜像备份、迁移、仅重建应用、健康检查与回滚。artifact-build instance 与 deployment instance 必须使用兼容的 artifact 根，确保 manifest 路径完全一致。

<a id="configuration"></a>

## 配置

Deployment instance 携带 `tenantKey`、`ownerDomain`、`sshInstanceId`、preset/operation 授权、本地 artifact 文件、env 文件引用、远端路径、argv commands、migration policy 与 health checks。

命令作者是 capability instance，模型不能提供。实例必须提供通用部署脚本路径、版本与 SHA-256；`deployment_plan`、`deployment_release` 与 `deployment_rollback` 通过非交互 sudo 读取脚本摘要，不一致时在申请发布租约或上传产物之前 fail closed。Release 先解析当前容器 image id，打 `app:backup-YYYYMMDD-HHMMSS-<shortImageId>`，再上传并校验新 artifact，最后调用 release command。运行 tag 继续使用 `app:latest`；回滚身份是 journal 记录的完整 image id 加 backup tag。

## Model Experience

### Model-visible tools and results

#### What the model sees

Preset 挂载本插件后，模型看到五个 tool 名称、描述、参数 schema 与调用结果。`deployment_release` 与 `deployment_rollback` 在执行前还要求一次审批。失败结果返回稳定 error code、可读摘要与 safe next action；绝不返回 secrets 或 command bodies。

#### Token effect

Tools 可见时 schema 带来固定 request-prefix 成本。Tool calls 与 results 会留在对话历史中，可能大到触发 compaction；`unknown_hold` 后应优先使用有界读取路径 `deployment_status`。

#### KV Cache effect

插件挂载期间 tool schemas 稳定。Activation 或 disposal 可能改变 request prefix；tool-call history 只追加。

<a id="known-limitations-and-deferred-work"></a>

## 已知限制与后续工作

- `migration.mode` 当前只支持 `always` 发布路径；其他模式 fail closed，待显式 command contract 补齐。
- First install 需要 deployment instance 声明的全部文件与完整 manifest。`firstInstallSecretRef` 已进入配置校验，但 staged env-file 交付不属于本 slice，操作员必须提供目标 env source。
- Release 执行依赖配置的目标脚本；本包不生成未文档化的远端命令序列。固定的摘要能发现内容漂移，但不能建立脚本的 source revision 或 builder identity，也不能阻止 root 操作者同时改写脚本与实例摘要。
- 数据库恢复刻意不属于 `deployment_rollback`。
- Release journal 跨进程持久，但目标主机锁行为仍需部署 preflight 证据。
- Windows 构建入口要求 Docker daemon 与 PowerShell 7 可用；任一依赖缺失时构建实例仍会 fail closed。

<a id="dev-note"></a>

### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

第一版支持 update release 与 manifest/artifact 校验。First-install env staging、`unknown_hold` recovery 和固定 DAG 编排要等目标主机证据后再做。

</details>

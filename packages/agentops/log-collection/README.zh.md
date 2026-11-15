---
description: "存储 SSH 日志采集任务、任务 ACL、安全租户目录键与带 revision 的任务生命周期。"
kind: "package-reference"
---

# @agentops/dsh-log-collection

[English](README.md) | 中文

## 概述

本包实现日志采集迁移的第一个切片：基于 SSH 实例引用的任务注册表、显式任务 ACL 与确定的租户目录键。任务只保存不透明 SSH 实例 ID 和绝对 POSIX 远端路径，不保存凭证或连接字段。更新使用 revision；删除采用软删除，task id 永久保留。

## 目录

- [使用本包](#use-this-package)
- [实现说明](#understand-the-implementation)
- [进一步阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

使用打开的 SQLite 数据库与绝对 local root 构造 `LogCollectionStore`。tenant 与 owner domain 必须来自认证上下文。远端路径必须是绝对 POSIX 文件路径；`.`、`..`、重复值与尾斜杠会被拒绝。

-----

<a id="understand-the-implementation"></a>
## 实现说明

`src/schema.ts` 创建版本化 task 与 ACL 表。`src/store.ts` 负责创建、查询、带 revision 的更新、软删除、ACL 授权与鉴权。本地目录固定为 `<root>/<tenant>/<task-id>`，并执行 containment 校验。

-----

<a id="further-exploration"></a>
## 进一步阅读

- 完整迁移设计见 `agentops/LOG-COLLECTION-MIGRATION-DESIGN-v9.md`。
- 最小实施范围见 `agentops/LOG-COLLECTION-MVP-SCOPE.md`。

-----

<a id="model-experience"></a>
## 模型体验

### 任务注册表

#### 模型可见内容

没有模型工具或消息。本包只存储任务与 ACL 行。

#### Token 影响

无直接 token 贡献。

#### KV Cache 影响

无。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与后续工作

- root plugin、控制面 RPC、浏览器桥和能力中心「日志采集」页已挂载；MaxKB 真实 SFTP 采集已验证。
- 创建/更新任务前会通过能力中心校验 SSH 实例：存在、已启用、凭证已配置、Host Key 已固定。
- 每次手工采集都会追加一条运行记录（文件数、字节数、耗时、错误），页面可查。
- 仍未实现：增量位点、保留期清理、并发拉取的 lease/回执、旧 AgentOps 任务迁移。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

M1 刻意停在任务注册表，下一步的传输与执行链路单独审查和测试。

</details>
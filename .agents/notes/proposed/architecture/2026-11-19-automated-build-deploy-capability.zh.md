# Agent Note: 自动化构建与部署能力

Status: proposed

[English](2026-11-19-automated-build-deploy-capability.md) | 中文

Review status: 2026-11-19 已完成 R1 对抗审查。本版本处理已采纳的阻断项。

## 问题

目标部署环境已有生产 SSH capability instance。Enterprise Service Hub Platform 在自己的仓库里也已具备 Docker bundle，但仓库还没有围绕它的安全 AgentOps 发布 capability。静态仓库证据不能证明生产 binding 或目标主机状态；这些是 capability 必须在运行时解析和验证的部署输入。

只做 skill 不够。skill 是可选指令，不持有部署实例、持久发布记录、并发锁、远端命令契约、迁移策略、回滚指针或健康证据。只做固定 DAG 也不够：当前 AgentOps DAG 执行 agent 节点，而部署授权、SSH 绑定、产物完整性、发布状态和回滚证据必须留在模型推理之外的确定性层。

当前外部 bundle 也缺少本设计要求：

- `docker/build/build.sh` 导出 `eshp.tar`，但不写 release manifest。
- `docker/image/manifest.json` 记录导出文件 hash，但部署脚本不消费它。
- `deploy.sh` 需要 `eshp.tar`、`mysql.tar`、`redis.tar`、Compose、`deploy.sh` 和 env 文件；示例实例只写了 `eshp.tar`。
- `update.sh` 不做备份就迁移，并在替换 `eshp:latest` 前没有记录带日期的 backup tag 或当前 image id。
- `rollback.sh` 不存在。
- 两个部署脚本都没有远端锁。
- 通用 SSH provider 不引入 SSH-specific model tool，`ssh_exec` 也没有映射给模型。

## 方案

用两个信任域实现 AgentOps release capability，然后增加 operator skill 和受约束 preset。固定 DAG 仍是后续编排选项，不是第一版必需。

### 分离产物生产与生产部署

产物生产和生产发布有不同的信任与权限需求。

- `artifact_build` 在配置的本地项目根执行构建入口，收集精确输出文件并写 release manifest。它不持有生产 SSH 凭证。
- `deployment_*` 工具只消费已校验的 release manifest 与 artifact set。它们从不构建源码，也从不接受模型传入的任意命令。
- `build_operator` 在本地 workspace 持有 build toolset。
- `deploy_operator` 只持有 deployment tools，没有 generic shell、write/edit、capability-center 管理或 generic SSH execution。

如果操作员要一条端到端自动化，父 Agent 或后续 workflow 调用两个角色，不合并它们的生产权限。

### Capability 实例与访问

`deployment` capability instance 保存非密钥发布数据和 opaque SSH instance id。它还记录 tenant、owner domain、允许的 preset 与允许的操作。

`deploy_operator` preset 必须同时绑定：

1. deployment instance；
2. 引用的 SSH instance。

运行时解析要求两个 binding，并在任何远端 mutation 前校验 SSH host-key pin 与 credential generation。未来若要增加跨 capability reference grant，必须是独立审计功能；第一版不增加 owner bypass。

Release 与 rollback 必须调用 `ctx.approval.request()`。只有 `allowed-once` 继续。`rejected`、`cancelled` 与 `unavailable` fail closed。Journal 记录 approval outcome，不记录 secrets。

### 持久化

Capability store 继续作为 definitions、instances、bindings 与 credentials 的权威。Release execution 使用 Harness home 下独立的 `deployment.db`，因为 capability 写的是短 control-plane transaction，而 release state 必须跨进程死亡与 SSH 歧义存活。

`deployment.db` 有单调递增 `SCHEMA_VERSION`，存储：

- deployment releases；
- artifact manifests；
- leases 与 fencing tokens；
- health checks；
- rollback points；
- approval receipts；
- terminal run evidence。

组合了 `ctx.jobs` 时，它只是 live progress view，绝不是权威 release record。

### 工具面

第一版暴露五个 model-facing tools：

| 工具 | 作用 |
|---|---|
| `artifact_build` | 在配置的本地根构建、校验输出并写 release manifest。无 SSH。 |
| `deployment_plan` | 只读计划：校验两个 binding、artifact manifest hash、SSH host key、远端锁、目标目录、env source、备份容量、当前 release 与迁移策略。 |
| `deployment_release` | 要求审批，申请 release lease，上传已校验 artifacts，调用配置的 release entrypoint，并持久化每一步。 |
| `deployment_status` | 读取当前与上一个健康 release、journal state、image id、migration revision 和最近健康证据。 |
| `deployment_rollback` | 要求审批，并调用配置的 rollback entrypoint 回到已记录健康 release。数据库恢复不属于本工具。 |

列出实例是 `deployment_plan` 未选择实例时的行为；第一版不需要单独 list tool。

### Versioned instance contract

命令是配置的 argv array 与显式 remote exec policy，不是模型参数。

```json
{
  "schemaVersion": 1,
  "instanceId": "eshp-production",
  "tenantKey": "gsafety",
  "ownerDomain": "smart_ops",
  "sshInstanceId": "int_fb7f38478f7a44e0af7d84acbacb7ba8",
  "access": {
    "presets": ["deploy_operator"],
    "operations": ["plan", "release", "status", "rollback"]
  },
  "artifact": {
    "updateFiles": ["image/eshp.tar"],
    "firstInstallFiles": [
      "image/eshp.tar",
      "image/mysql.tar",
      "image/redis.tar",
      "docker-compose.yml",
      "deploy.sh",
      "deploy.env.template"
    ],
    "manifest": "image/release-manifest.json",
    "manifestDigestFile": "image/release-manifest.sha256",
    "bundleRoot": "docker"
  },
  "environment": {
    "installedEnvFile": "/opt/eshp/.env",
    "firstInstallSecretRef": "capability-secret:eshp-prod-env",
    "firstInstallEnvFile": "/tmp/eshp-release/{releaseId}/prod.env",
    "remotePermissions": "0600",
    "cleanup": "always"
  },
  "remote": {
    "workRoot": "/tmp/eshp-release",
    "targetPath": "/opt/eshp",
    "lockPath": "/run/lock/eshp-release.lock",
    "commandTimeoutMs": 1800000,
    "sudoMode": "non-interactive",
    "firstInstallCommand": [
      "sudo", "{workDir}/docker/deploy.sh",
      "--bundle", "{workDir}/docker",
      "--env-file", "{firstInstallEnvFile}",
      "--base-dir", "{targetPath}"
    ],
    "updateCommand": [
      "sudo", "{workDir}/docker/update.sh",
      "--image", "{workDir}/docker/image/eshp.tar",
      "--release-id", "{releaseId}",
      "--backup-dir", "{targetPath}/backups/mysql",
      "--base-dir", "{targetPath}",
      "--env-file", "{targetPath}/.env"
    ],
    "rollbackCommand": [
      "sudo", "{workDir}/docker/rollback.sh",
      "--release-id", "{rollbackReleaseId}",
      "--base-dir", "{targetPath}",
      "--env-file", "{targetPath}/.env"
    ]
  },
  "migration": {
    "mode": "always",
    "backupBeforeMigrate": true,
    "backupRetentionDays": 7
  },
  "health": {
    "timeoutMs": 180000,
    "checks": [
      ["curl", "-fsS", "http://127.0.0.1:8000/version"],
      ["curl", "-fsS", "http://127.0.0.1:8000/health/live"],
      ["curl", "-fsS", "http://127.0.0.1:8000/health/ready"]
    ]
  }
}
```

Deployment instance 不保存 secret value。`firstInstallSecretRef` 只在 release 操作中通过 credential provider 解析；staged env 文件权限 `0600`，绝不回显，并在所有完成路径删除。

### 远端执行

Remote executor 使用 argv array 与封闭 placeholder 集合。Placeholder 只来自可信实例状态和生成的 release state：

- `workDir`
- `targetPath`
- `releaseId`
- `rollbackReleaseId`
- `firstInstallEnvFile`

Executor 拒绝未知 placeholder、控制字符、空参数、非绝对远端路径和命令族之外的参数。如果底层 SSH transport 只暴露 `exec(command: string)`，adapter 必须对每个 argv 元素做 POSIX 参数 quoting，并测试敌对 path 与 release-id 输入。可用时优先使用具有 `execFile` 语义的 deployment helper。

Remote script 必须使用非交互 sudo。Deployment instance 必须固定脚本绝对路径、版本与非空 SHA-256；`deployment_plan`、`deployment_release` 与 `deployment_rollback` 在任何 lease、上传或远端 mutation 前通过 `sudo -n sha256sum` 复核。摘要漂移 fail closed，操作员必须同时更新脚本版本与实例摘要。Preflight 还检查 `sudo -n true`、Docker、Compose v2、curl、锁目录可写性、磁盘容量和目标 env 文件。

### Release script ownership

Remote release script 持有有序远端步骤；capability 不重复实现它们。脚本必须：

1. 在 timeout 内获取配置的远端锁；
2. 再次校验 release manifest 与每个 artifact hash；
3. 当策略要求时，在迁移前创建并验证 MySQL backup；
4. 按策略执行迁移或显式跳过；
5. 记录当前运行 image id，给该 image id 打 timestamped backup tag，然后导入新的 `latest` image；
6. 只重建 ESHP；
7. 输出 structured JSON-line progress 并返回 terminal exit code。

Deployment service 调用该脚本，把 progress records 解析进 journal，并按保留策略记录 stdout/stderr。它不独立重跑迁移或 recreation。

### 发布标识与完整性

`artifact_build` 在所有输出存在后写 release manifest。Manifest 包含：

- `releaseId`；
- `gitSha`；
- `dirty`；
- `builtAt`；
- `builder`；
- `imageName`；
- `imageId`；
- `artifactFiles[]`，含 `path`、`bytes` 与 `sha256`。

Manifest digest 存在独立 `release-manifest.sha256` 文件。没有 self-hash 字段。本地与远端对同一 manifest 文件字节做相同校验，然后在导入前校验每个 artifact。

### Latest runtime tag 与 image-id rollback

Compose 可以继续运行 `eshp:latest`。在 `docker load` 替换该 tag 前，release script 解析当前运行容器 image id，并创建类似 `eshp:backup-20261119-153045-ab12cd34` 的 backup tag。tag 使用 timestamp 与 short image id，而不是只有日期，避免同一天两次发布冲突。

Release journal 记录 backup tag、完整 image id、已知当前 release id，以及发布前健康检查是否通过。Backup tag 只是便利指针；image id 才是 rollback identity。`rollback.sh` 把已记录健康 backup 解析成 image id，获取同一远端锁，把该 image id 重新 tag 为 `eshp:latest`，再 recreation ESHP。它绝不恢复 MySQL。数据库恢复是另一个显式操作，有自己的审批与 backup 选择。

### 迁移、备份与 unknown outcomes

ESHP 从 `migration.mode = always` 与 `backupBeforeMigrate = true` 开始。改变 schema 的 release 只有在 backup 成功且产出非空、可校验 checksum 的 artifact 后才能报告成功。

如果 SSH 在 mutating step 后断开，journal 进入 `unknown_hold`。Service 不释放 lease、不重试命令、不报告成功。Recovery 前必须使用 `deployment_status`。脚本仍存活时，远端锁是安全网。

### 健康证据

Release 只有在以下条件全部满足时才 healthy：

- 配置的 health checks 成功；
- `/version` 报告预期 `releaseId`；
- `docker inspect` 报告 `eshp` 的预期 image id；
- migration revision 与 release journal 一致。

仅有容器 `.State.Health.Status` 不够。

### Skill 与 presets

`production-deployment` 记录何时调用 release tools、审批要求、备份预期、`unknown_hold` 后 status-first recovery 和发布报告。它不包含生产路径、凭证或 command bodies。

生成的 `deploy_operator` preset 必须有负向测试：不得暴露 `bash`、`pwsh`、write/edit、generic SSH、capability administration 或任意 instance switching。

### Workflow 进入条件

固定 DAG 推迟到 capability 具备 persistent release journal、remote lock、backup/restore、rollback、真实 composition tests 和至少一个非交互 approval path 之后。引入时，其 release 节点调用 `deployment_release`，不嵌入 SSH commands 或 deployment paths。

## Alternatives considered

**只做 deployment skill。** 否决理由：skill 无法强制 instance authorization、artifact hashes、migration backup、concurrency locks、approval 或 rollback evidence。

**先做固定 DAG release。** 否决理由：当前 DAG command nodes 未实现，model-authored nodes 不能持有 deployment authority、SSH paths、migration policy 与 rollback state。

**一个 Agent preset 同时持有 build 与 production release authority。** 否决理由：build scripts 会删除并重写 build dirs，且需要 local workspace writes；production release 需要 SSH credential。合并两者违反 least privilege。

**实例保存自由 shell command。** 否决理由：placeholder injection 与 shell parsing 产生 command-injection 和 drift path。实例保存 argv arrays 与封闭 placeholder set。

**让模型提供 host、target path 或 credential。** 否决理由：deployment authority 属于 capability instance 与 preset bindings，不属于 model input。

**把 scripts 只放在 `docker/README.md`。** 否决理由：prose 不是可执行权威。README 解释 recovery 与 design；instance 与 scripts 定义 executable contract。

**把 generic SSH capability 作为 deployment tool。** 否决理由：arbitrary SSH execution 绕开 release identity、artifact verification、migration policy 与 rollback state。当前仓库也不向模型暴露 `ssh_exec`。

**把 `ctx.jobs` 当作 release record。** 否决理由：in-process job registry 在 process death 时可能丢失 settlement。Jobs 可以显示 live progress，但 `deployment.db` 持有 durable state。

**只用日期或 mutable `previous` tag 作为 rollback pointer。** 否决理由：date-only tag 会冲突，`previous` 会被失败重试覆盖。Rollback 选择已记录健康 backup tag 加完整 image id；`latest` 仍是 runtime tag。

## Acceptance criteria

- Schema validation 拒绝不完整 first-install artifact set、相对或非绝对远端路径、未知 placeholders、空 argv entries、未知字段、缺少 lock path、非法 env permissions 和不支持的 sudo mode。
- Tests 证明 release 与 rollback 要求 `deploy_operator` 同时持有 deployment 与 referenced SSH bindings；缺少 SSH binding 在远端连接前失败。
- Tests 证明 release 与 rollback 调用 `ctx.approval.request()`，并拒绝除 `allowed-once` 外的所有 outcomes，包括 `unavailable`。
- Tests 证明 SSH host-key pin 与 credential generation 在 mutation 前检查；rotation 或 fingerprint change fail closed。
- Build tests 证明 release manifest 创建、独立 manifest digest 校验、dirty/source revision 记录与 output containment 在配置的 local root 内。
- Artifact tests 证明 first install 缺 `eshp.tar`、`mysql.tar` 或 `redis.tar` 时拒绝，installed env 来自配置 secret reference、权限 `0600`，并在 success/failure/cancellation 清理。
- Remote release tests 证明 configured remote lock 拒绝第二个 process，deployment journal 在 SSH loss 时记录 `unknown_hold` 且不重试。
- Migration tests 证明 backup failure 阻止 migration，migration failure 阻止 image import/recreate，policy 而非 model input 控制 `--skip-migrate`。
- Health tests 证明 `/version`、image id、migration revision 与每个配置检查都匹配后才 `healthy`。
- Rollback tests 证明替换 `latest` 前已给运行 image id 打 tag，date collision 被 timestamp-plus-image-id tag 取代，database restore 保持独立审批路径。
- `deployment_status` 在 process restart 后报告 current release、previous healthy backup tag、完整 image id、migration revision、journal state 与 last confirmed step。
- 生成的 `deploy_operator` preset snapshot 证明没有 generic shell、write/edit、capability administration 或 generic SSH tools。
- Deployment skill 经 `packages/agentops/skills` 打包，复制到 runtime skill directory，并由 preset generation tests 覆盖。
- Package README/JSDoc、capability catalogue、bundle patch、preset generator、deployment seed 与 capability UI tests 在同一变更更新。
- 真实 profile-boot test 在没有 production credentials 的情况下覆盖 capability store、deployment journal、tools 与 preset bindings；真实 production release 仍由 operator 触发。
- Recorded-session snapshots 覆盖 tool schemas、skill guidance、successful release evidence、approval rejection、health failure 与 `unknown_hold`。
- 在 release journal、remote lock、backup/restore、rollback 与 real composition tests 通过前，不添加 fixed workflow。

## Risks

**Build 与 deployment 仍是不同信任域。** 受污染 build 仍可产出恶意 artifact。Manifest hashes 与 source revision 改善可追踪性，但不证明 source honesty；source review 与 build-environment integrity 仍是独立控制。

**Remote script 现在是有序权威。** `update.sh` 或 `rollback.sh` 的 bug 可能绕过 service 期望。Script 与 capability 必须共享一个 manifest contract 并做 integration tests；service 不得静默复制步骤。

**Database restore 可能破坏更新后的数据。** Application rollback 与 database restore 保持不同决策。禁止自动数据库恢复。

**SSH 歧义会阻塞 release。** `unknown_hold` 有意优先安全而非可用性。Operator 必须检查 remote lock、journal 与 current image 后再恢复。

**Remote lock 依赖目标主机行为。** `/run/lock` 可能不可写，`flock` 可能不存在。Preflight 必须 fail closed，并允许 instance-specific lock path。

**Manifest hash 证明传输完整性，但不证明记录的 source revision 与 builder identity 为真。** 第一版记录 source revision 与 builder identity；cryptographic signing 或 attestation 推迟到 build environment 有稳定 trust root 后。

**Capability journal 是 deployment-local。** 第二个 control plane 仍可能竞争，除非 remote script lock 是权威。本设计接受 remote lock 是最终 fence。

**Health checks 可能不完整。** `/version`、image id 与 migration revision 把健康绑定到目标 release，但不证明业务正确性。Skill 要求在项目定义 post-release smoke checks 时执行。

**Redis persistence 因项目而异。** 第一版 ESHP 契约要求 MySQL backup，不要求 Redis backup。如果 Redis 保存不可重建状态，deployment instance 必须在启用 release 前增加 Redis backup 与 restore 策略。

**单一 tenant 或 owner-domain 可能过窄。** Schema 带 tenant 与 owner domain，使 ACL 可以在不迁移 release identity 的情况下增加；需要跨 tenant release authority 的安装必须显式定义策略。

**Fixed workflow 可能成为第二权威。** 如果它嵌入 commands 或 paths，capability 与 workflow 会漂移。Workflow 必须用相同 instance ids 调用相同 tools。

# DSH 基线记录（DSH-BASELINE）

> 改基线必须同步更新本文件与 `DSH-CORE-CHANGES.md`。

## 1. 基线坐标

| 项 | 值 |
| --- | --- |
| 上游仓库 | `https://github.com/deepseek-ai/deepseek-harness`（public） |
| 基线引用 | 标签 `agentops-baseline`：指向本仓库导入上游源码的那次提交 |
| 本仓库 DSH 版本号 | `@deepseek-ai/dsh-root@0.2.1-rc.3`（tag `dsh-v0.2.1-rc.3`） |
| 所有权边界 | `OWNED-PATHS.txt` |

标签缺失时用 `git tag agentops-baseline <导入提交>` 补建，或用 `--base <ref>` 临时指定别的基线。

## 2. 基线怎么比

跑 `node agentops/scripts/check-owned-paths.mjs` 可复现分类：

```text
OWNED            AgentOps 自有代码与资产（packages/agentops/**、agentops/**）
CORE             我们改过的 DSH 上游源码
INTEGRATION      把 AgentOps 接入 DSH 构建图的必需文件
ENV-ARTIFACT     symlink 或权限差异（内容一致）
UNEXPECTED       未登记的改动；必须恒为 0
```

`UNEXPECTED` 不为 0 时按脚本打印的修法处理：AgentOps 自有 → `OWNED-PATHS.txt`；DSH 核心改动 → `CORE-PATHS.txt` + `DSH-CORE-CHANGES.md`；集成必需 → `INTEGRATION-PATHS.txt` + `DSH-CORE-CHANGES.md`；仅 symlink/权限差异 → `ENV-ARTIFACTS.txt`。

## 3. 提交链

```text
HEAD               AgentOps 工作提交
<core-change>      feat(dsh): add collapsible sidebar panel sections
<baseline>         上游导入提交（标签 agentops-baseline）
```

DSH 原始代码由基线提交表示，不重复提交；DSH 核心改动进入 DSH 核心改动提交；AgentOps 自有代码与集成文件进入 AgentOps 工作提交。

## 4. 已知差异（相对基线标签）

分类结果以 `check-owned-paths.mjs` 的实际输出为准；本文件不复制一份会过期的计数。
历史登记见 `DSH-CORE-CHANGES.md` 的「历史」表。

## 5. 注意

- `git diff` 请加 `-c diff.renames=false`：历史 blob 未下载，改名检测会去读它们而报 `unable to read <sha>`。
- 不要把 `node_modules.pre-*`、`lib/`、`dist` 纳入版本管理（上游 `.gitignore` 已覆盖）。

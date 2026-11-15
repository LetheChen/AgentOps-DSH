# DSH 基线记录（DSH-BASELINE）

> 建立时间：2026-10-26 ｜ 维护：改基线必须同步更新本文件与 `DSH-CORE-CHANGES.md`

## 1. 基线坐标

| 项 | 值 |
|---|---|
| 上游仓库 | `https://github.com/deepseek-ai/deepseek-harness`（public） |
| 基线引用 | 标签 `agentops-baseline`：指向 2026-10-23 上游 master 合入 [PR #7075](https://github.com/deepseek-ai/deepseek-harness/pull/7075) 的那次提交 |
| 基线 root tree | `git rev-parse agentops-baseline^{tree}` |
| 本仓库 DSH 版本号 | `@deepseek-ai/dsh-root@0.2.1-rc.3`（tag `dsh-v0.2.1-rc.3`，**比基线旧**，仅作版本号保留） |
| 分支 | `agentops/main`（从基线起） |
| 历史深度 | **shallow = 1**（`.git/shallow` 记录基线提交，parent 尚未下载） |

基线提交在本仓库用**标签**而不是裸 commit 标识记录：仓库的维护文档禁止引用具体 commit（`verify-repository-references`），标签也不会随上游分支移动。标签缺失时用 `git tag agentops-baseline <上游基线 commit>` 补建，或用 `--base <ref>` 临时指定别的基线。

## 2. 基线是怎么来的（为什么不是普通 clone）

本地到 GitHub 的数据面不可用（直连 12–40 KB/s、SOCKS 12 KB/s、`git clone` 协商停滞），但**转发服务器到 GitHub 极快**。因此采用"服务器出对象、只回传不能本地生成的部分"：

1. 在 `203.0.113.10` 上 `git clone --filter=blob:none --depth=1`（**7.9 秒**）；
2. 服务器侧 `git pack-objects --revs --stdout --filter=blob:none` → **722 KB**（commit + 全部 tree，无 blob）；
3. `scp` 回传（58 秒，约 12 KB/s）；
4. 本地 `git init` → 放入 pack → `git read-tree <基线提交>` → 以真实上游 commit 作为 HEAD 的父提交。

因为本地 19,186 个文件与上游 **逐条 blob SHA 相同**，所以不需要传输任何 blob。

## 3. 提交链

```
HEAD               feat(agentops): migrate monitoring, agents, and native settings
<core-change>     feat(dsh): add collapsible sidebar panel sections
<design-doc>      docs(agentops): add task management migration design
<env-fix>         fix(env): 恢复被 .gitignore 误排除的上游 fixture；移除 GBK 命名的重复文件
<baseline>        upstream master（PR #7075，2026-10-23），本地标签 agentops-baseline
```

三类代码的提交边界：DSH 原始代码由基线提交表示，不重复提交；DSH 核心改动进入 DSH 核心改动提交；AgentOps 自有代码与集成文件进入当前 `feat(agentops)` 提交。

## 4. 已知差异（相对基线标签）

跑 `node agentops/scripts/check-owned-paths.mjs` 可复现分类：

| 类别 | 数量 | 说明 |
|---|---|---|
| OWNED | 222 | `packages/agentops/**` + `agentops/**`（AgentOps 自有代码与文档） |
| CORE | 19 | `packages/client/ui-sidebar/**`、`packages/client/ui-slots/**`、对应文档与 Agent Note |
| INTEGRATION | 3 | `tsconfig.client.json` / `tsconfig.host.json` / `pnpm-lock.yaml` |
| ENV-ARTIFACT | 66 | 23 个 mode-only（14 symlink + 9 可执行位）+ `.claude/skills` 展开的 43 个路径 |
| UNEXPECTED | 0 | 目标恒为 0；当前已通过 |

## 5. 历史深度怎么补

基线提交只有 1 层祖先。需要更深历史时：

1. 在转发服务器上对同一个 clone 执行 `git fetch --deepen=<n>`；
2. 用同一"只回传必要对象"的办法（`pack/git-receive-pack` 或再次 `pack-objects` + `index-pack`）；
3. 本地把新 pack 放进 `.git/objects/pack/` 后 `git fetch --deepen` 的等价操作是直接更新 `.git/shallow`（移除该行）——**commit 标识不变**，不需要改写历史。

网络条件改善后最简单：`git remote add upstream <url>` + `git fetch --unshallow upstream`。

## 6. 注意

- `git diff` 请加 `-c diff.renames=false`：历史 blob 未下载，改名检测会去读它们而报 `unable to read <sha>`。
- 不要把 `node_modules.pre-*`、`lib/`、`dist` 纳入版本管理（上游 `.gitignore` 已覆盖；`node_modules.pre-*` 在 `.git/info/exclude`）。

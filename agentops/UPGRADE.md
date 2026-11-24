# DSH 升级 SOP（UPGRADE）

> 原则：**不再覆盖式拷贝**。升级走 git，冲突面只允许出现在 OWNED / CORE / INTEGRATION / ENV-ARTIFACT。
> 覆盖式拷贝的教训：本目录曾有 `node_modules.pre-0.2.1-rc.3/`，说明上次升级是整目录替换——那会**静默删掉 `packages/agentops`**。

## 0. 前置检查

```powershell
git -C <dsh-repo> status --short     # 必须干净
node agentops/scripts/check-owned-paths.mjs          # 必须 UNEXPECTED=0
```

## 1. 取上游

```powershell
git fetch upstream            # 首次：git remote add upstream https://github.com/deepseek-ai/deepseek-harness.git
git log --oneline agentops-baseline..upstream/master   # 先看改了什么
```

## 2. 开分支合并

```powershell
git switch -c upgrade/dsh-<version>
git merge upstream/master
```

**预期冲突只会出现在**：

- `CORE-PATHS.txt` 已登记、且 `DSH-CORE-CHANGES.md` 有台账的 DSH 核心改动
- `tsconfig.client.json` / `tsconfig.host.json`（上游若新增 project reference）
- `pnpm-lock.yaml`
- 少数 `ENV-ARTIFACTS.txt` 里的路径（symlink/权限）

出现其他文件的冲突 = 红线，停下来查清是谁改的。

## 3. 重新安装与验证

```powershell
pnpm install
pnpm -r typecheck
pnpm -r build
node agentops/scripts/check-owned-paths.mjs --base <升级前的基线 SHA 或 upstream/master>
```

## 4. 冒烟（缺一不可）

1. `dsh web` 起得来；
2. **新建会话可创建**（preset 行的包名解析失败会在这里炸，且没有弹窗）；
3. AgentOps 侧栏面板可见、能打开；
4. `plugin_manager` / 设置页没有 `never started` 的插件行。

## 5. 收尾

- 更新 `DSH-BASELINE.md` 的基线坐标；
- 在 `DSH-CORE-CHANGES.md` 复核 CORE 改动是否仍需要、更新 INTEGRATION 接入项；
- 打 tag：`upstream-<new-sha>`，便于下次算差异。

## 6. 回滚

```powershell
git switch agentops/main
git branch -D upgrade/dsh-<version>   # 未合并直接丢
```

已合并时：`git revert -m 1 <merge-sha>`，并重跑第 3、4 步。

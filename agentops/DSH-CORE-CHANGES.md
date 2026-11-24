# DSH 核心改动台账（DSH-CORE-CHANGES）

> 规则：**DSH 核心改动必须最小化且逐项登记**；任何非 OWNED、非 ENV-ARTIFACT 的改动都必须在此登记，
> 否则 `agentops/scripts/check-owned-paths.mjs` 会以退出码 1 拦下。
> 登记格式：文件 → 为什么不能用 bundle/preset/配置解决 → 上游基线 SHA → 回滚方式。

## DSH 核心源码改动

### 1. 可折叠侧栏分组（CORE）

- 改动路径：`packages/client/ui-slots/**`、`packages/client/ui-sidebar/**`、`docs/subsystems/slots.*`，以及对应的 Agent Note。
- 改动：list 注册项新增可选的 `section` 元数据（稳定 id、可选 order、locale-aware label）；侧栏把共享同一 section 的面板渲染为可折叠顶层分组，并在其中打开当前面板时自动展开该分组。未 Pin 的面板仍在 More 菜单中保持扁平入口。
- 原因：AgentOps 需要“智能体管理 / 系统设置”等一级分组，但 profile、bundle、preset 只能追加面板行，不能改变通用侧栏的渲染、展开状态、无障碍语义和布局。
- 为何不能只改 AgentOps：侧栏渲染器属于通用 DSH client；在 AgentOps 内复制一份会形成长期分叉，后续所有侧栏修复都要双改。
- 验证：`vitest` 覆盖 section 元数据复制、冲突检测、按组折叠、活动分组自动展开、收起侧栏时点击分组展开侧栏，以及 More 菜单保持扁平。
- 回滚：revert `feat(dsh): add collapsible sidebar panel sections` 提交；无持久化数据迁移。

### 2. 窄屏侧栏展开态收拢（CORE）

- 改动路径：`packages/client/ui-layout/src/client/stores.ts`、`packages/client/ui-layout/tests/layout-store.client.spec.ts`。
- 改动：视口宽度小于 `SIDEBAR_AUTO_COLLAPSE` 时，手动展开的侧栏在选中面板后自动收拢。
- 原因：AgentOps 的分组侧栏在窄屏展开后遮住面板内容，面板标题与操作按钮点不到。
- 为何不能只改 AgentOps：侧栏展开态存在通用 layout store 里，AgentOps 面板拿不到也不该改它。
- 验证：`packages/client/ui-layout/tests/layout-store.client.spec.ts` 新增用例覆盖「窄屏展开后选中面板即收拢」。
- 回滚：revert 该提交；无持久化数据迁移。

### 3. AgentOps 子系统文档与网站投影（CORE）

- 改动路径：`docs/subsystems/agentops.md`、`docs/subsystems/agentops.zh.md`、`docs/subsystems/agentops.i18n.yaml`、`docs/subsystems/README.md`、`docs/subsystems/README.zh.md`、`docs/subsystems/README.i18n.yaml`、`website/docs.ts`。
- 改动：新增 AgentOps 子系统说明（双语 + i18n 字典），并在 `docs/subsystems/README.*` 与网站子系统目录里各加一条入口。
- 原因：DSH 的文档体系要求每个子系统在 `docs/subsystems` 有独立页面并投影到网站；AgentOps 是新增子系统，没有这条路径就只能把说明塞进 AgentOps 自己的 README。
- 为何不能只改 AgentOps：网站导航与子系统目录由 DSH 维护，AgentOps 无法注册自己的导航项。
- 验证：`pnpm run doc-sync`、`pnpm run website:build`。
- 回滚：删除上述文档文件并回退 `website/docs.ts` 的那一行。

### 4. 门禁白名单里的 AgentOps 条目（CORE）

- 改动路径：`scripts/doc-standard.spec.ts`、`scripts/gen-cordis-catalog.ts`、`scripts/type-equiv.manifest.json`、`scripts/verify-package-readme-model-experience.ts`。
- 改动：把 `@agentops/dsh-contracts`、`dsh-workspace-layout`、`dsh-workflow-compiler`、`dsh-workflow-catalog` 等新包登记进门禁的已知集合（包库描述、cordis 目录链接映射、类型等价清单、README 的 model-experience 判定）。
- 原因：这四个门禁按包路径白名单工作，新包不登记就报「未登记」；登记是门禁设计的用法，不是放宽判定标准。
- 为何不能只改 AgentOps：白名单在 DSH 的门禁脚本里，AgentOps 侧改不了它们的判定表。
- 验证：`pnpm run test:docs`、`pnpm run doc-sync`。
- 回滚：回退这四个文件里的对应条目。

### 5. AgentOps 迁移设计说明（Agent Note，CORE）

- 改动路径：`.agents/notes/proposed/architecture/2026-10-27-agentops-log-patrol-dsh-migration.md`、`.zh.md`、`.i18n.yaml`。
- 说明：日志巡检迁往 DSH 的设计说明草稿。
- 原因：DSH 的 Agent Note 树是跨仓协作的说明载体，迁移理由要写在这里才能被上游读到。
- 验证：`pnpm run doc-sync`。
- 回滚：删除这三个文件。

> 2–5 项是在本轮补登记：这些改动此前已在分支上累积而未登记，登记时间晚于改动发生时间。

### 6. AgentOps 服务进入 DSH 目录与文档图（CORE）

- 改动路径：`scripts/gen-cordis-catalog.ts`、`scripts/gen-doc-graphs.ts`、`scripts/type-equiv.manifest.json`、`scripts/project-doc-site.spec.ts`、`scripts/verify-export-jsdoc.ts`，以及它们的生成产物：`docs/capability-seams.md`、`docs/capability-seams.zh.md`、`docs/capability-seams.i18n.yaml`、`docs/config-catalog.md`、`docs/config-catalog.zh.md`、`docs/event-producer-consumer.md`、`docs/event-producer-consumer.zh.md`、`packages/extensions/cordis-client-runner/src/client/api-catalog.ts`、`packages/extensions/cordis-client-runner/src/client/slot-catalog.ts`、`packages/extensions/tool-cordis/src/api-catalog.ts`、`packages/preset/agent-preset/skills/cordis-composition-reference/references/packages.md`。
- 改动：把 `ctx.workspaceLayout` 与 `ctx.workflowCatalog` 两个 AgentOps 服务登记进 Cordis 服务目录（`SERVICE_PAGE` / `LINK_MAP` / `SERVICE_ROLES`）；把 workflow-catalog、workflow-compiler、contracts 的导出类型登记进类型等价清单，同时删去两条已失效的孤儿条目；把 AgentOps 子系统页计入文档站中文页数量；为逐字复制的上游文件加 vendored 豁免，避免对外份代码的 JSDoc 要求误报。生成产物由对应生成器重录。
- 原因：服务目录、类型等价清单与文档站页数都由 DSH 的生成器维护；新服务不登记就不会出现在目录、等价检查与文档站中。
- 为何不能只改 AgentOps：生成器与生成产物在 DSH 仓库内，AgentOps 包无法自行登记。
- 验证：`pnpm run verify-cordis-inspect-catalog`、`verify-client-catalog`、`verify-config-catalog`、`verify-plugin-packages`、`verify-type-equiv`、`pnpm run doc-sync`。
- 回滚：回退上述脚本里的条目，并重跑四个生成器。

### 7. 仓库根 README 增加 AgentOps 产品说明（CORE）

- 改动路径：`README.md`、`README.zh.md`、`README.i18n.yaml`。
- 改动：在上游 README 的 AgentOps 衍生说明之后插入 “Product overview” 段，写明 AgentOps-DSH 的定位、能力清单、快速开始与当前完成度。
- 原因：仓库根 README 是上游 DSH 的入口文档，衍生项目必须在这里声明自己的身份、定位与限制，否则使用者会把它当成原版 DSH。
- 为何不能只改 AgentOps：根 README 属于上游文件，AgentOps 包无法在其中增补段落。
- 验证：`pnpm run doc-sync` 的双语行对齐与链接检查。
- 回滚：删除该段并同步删除 `README.i18n.yaml` 中对应的键。

## 构建接入（INTEGRATION，不是 DSH 核心源码）

> 以下文件位于 DSH 构建配置中，但只负责把 AgentOps workspace 接入 DSH 的编译图；它们不是产品运行逻辑，也不应伪装成 CORE。


### 1. `tsconfig.client.json`（INTEGRATION）

- 改动：新增 1 行 project reference `{ "path": "./packages/agentops/client" }`。
- 原因：DSH 的 client 半边（`dsh.client`）必须进入 TS project reference 图，否则 `tsc -b` 不覆盖它、构建产物缺失。
- 为何不能用 bundle/preset 替代：这是编译期配置，运行时机制无法替代。
- 回滚：删除该行即可（AgentOps client 面板会退回"未构建"状态，不影响 DSH 本身）。

### 2. `tsconfig.host.json`（INTEGRATION）

- 改动：新增 8 行 project reference（host / knowledge / dag / task / security / db / vault / **sidecar**）。
- 原因：同上，host 半边需要参与类型检查与构建。
- 2026-10-26 修正：已删除 `./packages/agentops/sidecar`（该包已删除，引用会直接报 TS6053），并补上 `./packages/agentops/bundle`（该包有 src/tests 但没有 tsconfig，导致 TS6307）。现为 8 行：host/knowledge/dag/task/security/db/vault/bundle。
- 回滚：删除这 8 行（会使 `tsc -p tsconfig.host.json` 重新报错）。

### 3. `tsconfig.base.json`（INTEGRATION）

- 改动：新增 4 行 source-plane 路径别名（`@agentops/dsh-contracts`、`@agentops/dsh-workspace-layout`、`@agentops/dsh-workflow-compiler`、`@agentops/dsh-workflow-catalog`）。
- 原因：编译期配置，运行时机制无法替代；不加别名则跨包导入走不了 `src` 解析。
- 为何不能用 bundle/preset 替代：同上。
- 回滚：删除这 4 行。

### 4. `pnpm-lock.yaml`（INTEGRATION）

- 改动：新增约 361 行（`packages/agentops/*` 及其依赖的锁快照）。
- 原因：workspace 新增包后 `pnpm install` 必然重写锁文件。
- 回滚：移除 `packages/agentops/*` 后重新 `pnpm install`。

## 历史（未登记即视为缺失，不许补记）

| 日期 | 文件 | 说明 |
|---|---|---|
| 2026-10-26 | 上述 3 项 INTEGRATION | 基线接入时的首次登记 |
| 2026-10-29 | collapsible sidebar sections | AgentOps 菜单分组所需的通用 DSH 侧栏能力 |
| 2026-11-16 | 仓库根 README 三件套 | 衍生项目的身份、定位与完成度声明 |

## 不该出现在这里的东西

- `.claude/skills/**`、`CLAUDE.md` 等 symlink/权限差异 → 属于 `ENV-ARTIFACTS.txt`；
- `packages/agentops/**`、`agentops/**` → 属于 `OWNED-PATHS.txt`；
- 通过 profile（`$DSH_HOME/profiles/*/cordis.patch.yml`）、bundle、preset 行能实现的改动 → **不要改 DSH 文件**；
- 无法通过这些扩展点实现、且必须改 DSH 源码的通用能力 → 先在 `CORE-PATHS.txt` 登记，再在此记录原因、验证和回滚。

- 2026-10-26 追加：`tsconfig.host.json` 的 include 增加 `agentops/scripts/**/*.ts` 与 `agentops/tests/**/*.ts`（让生成器与它的测试进入类型检查；不属于 DSH 源码改动）。

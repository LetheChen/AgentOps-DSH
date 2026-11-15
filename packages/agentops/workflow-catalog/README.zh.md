---
description: "工作流定义目录：列出、读取、校验、编译，并以文件指纹做比较后写入（CAS）保存 AgentOps 工作流 YAML。"
kind: "package-reference"
---

# @agentops/dsh-workflow-catalog

[English](README.md) | 中文

## 概述

工作流 YAML 仍是唯一权威，本服务是唯一的写入方。它为管理页列出定义、在任何内容落盘前完成校验、通过共享编译器产出运行时将要执行的脚本以便编辑器预览，并以文件指纹做比较后写入（CAS）。`validateAndCompile()` 只解析一次候选文本，并返回校验结果与由同一份定义编译出的产物，因此编辑器不会校验一个文档却展示另一个文档的产物。带来的差别是：基于旧副本的编辑器会收到冲突，而不是静默覆盖掉更新的定义。

## 目录

- [使用此包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用此包

### 何时使用

在工作流管理路由或编辑器里注入 `ctx.workflowCatalog`：

```ts
import type { Context } from '@deepseek-ai/cordis'
import '@agentops/dsh-workflow-catalog'

declare const ctx: Context
declare const nextText: string

const listing = await ctx.workflowCatalog.list()
const { text, digest } = await ctx.workflowCatalog.readSource('log-patrol')
const compiled = await ctx.workflowCatalog.compile('log-patrol')
await ctx.workflowCatalog.save('log-patrol', nextText, digest) // CAS
```

`readSource()` 不解析 YAML，直接返回文件原文与 SHA-256 指纹，因此编辑器可以修复暂时非法的文档。定义不存在时会保留 `ENOENT`，管理路由将其映射为 404。

`validateAndCompile(text)` 对合法文本返回 `{ ok: true, value, issues, compiled }`，对非法文本只返回 `{ ok: false, issues }`。成功产物包含生成的 `source`、调度 `layers` 与 `digest`。`compileDefinition(definition)` 编译已经校验的定义；编辑器路由在仅源码编辑后使用它，不再次解析候选文本。

`save()` 接收这次编辑所基于的指纹，新建时传 `null`。文件已被改动会抛 `CatalogConflictError` 并带出两个指纹；文档解析失败会抛 `CatalogInvalidError` 并列出全部问题。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部结构——点击展开</summary>

| 文件 | 职责 |
|---|---|
| [`src/catalog.ts`](src/catalog.ts) | 目录扫描、原文读取、一次解析的校验与编译、原子 CAS 保存 |
| [`src/index.ts`](src/index.ts) | `workflowCatalog` 服务 |

写入经由暂存文件加 `rename`，读方不会看到写了一半的定义。非法文件保留在 `list().issues` 里而不是从页面上消失。

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [`../contracts/`](../contracts/README.zh.md) —— 本服务应用的定义类型与校验。
- [`../workflow-compiler/`](../workflow-compiler/README.zh.md) —— `compile()` 背后的编译器。
- [`../dag/`](../dag/README.zh.md) —— 执行工作流的引擎。

-----

<a id="model-experience"></a>
## 模型体验

无。本服务只读写定义文件，不构造模型输入。

#### KV 缓存影响

无；没有任何模型请求经过本服务。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **不含运行历史** —— 运行属于 DAG 引擎的存储；本服务只管定义，因此页面要读两个来源。
- **没有版本历史** —— `save()` 直接替换文件，尚无草稿、发布与回滚。
- **一个工作流一个文件** —— 定义必须位于 `<workflowId>.yaml`，且文件内的 `workflow_id` 不一致会被拒绝。
- **指纹是文本级的** —— CAS 比较原始字节，因此仅空白重排也会被判为冲突，即使语义相同。
- **编译预览的覆盖仍不完整** —— 数据端口尚未注入下游 prompt，retry/timeout 尚未写入生成的执行脚本，编译器尚未接入 `workflow-ptc`。YAML 仍是唯一权威，预览产物不会回写定义。
- **启动冒烟是脚本而非门禁测试** —— 在 vite 下 Loader 的动态导入会解析出第二份 @deepseek-ai/cordis，因此即便装配成功 `boot.get('workflowCatalog')` 也是 undefined；`scripts/smoke-boot.mts` 改用 tsx 运行。

服务是经 Cordis 代理访问的，方法里的 `this` 就是代理：私有字段会抛 `Cannot read private member`。因此状态放在代理能转发的公有属性上。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

比较后写入一直推迟到本服务出现才做：在还没有写入方的时候加一列 `compiled_sha256`，是投机 API。这里的指纹与编译器输出的是同一个，后续的定义存储可以直接落库，不必再引入第二套身份。

</details>

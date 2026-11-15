---
description: "AgentOps 知识库：LLM Wiki 草稿、发布、版本、BM25 检索、记忆投影与模型工具。"
kind: "package-reference"
---

# @agentops/dsh-knowledge

[English](README.md) | 中文

## 概述

本包闭合 LLM Wiki 链路：任务报告进入持久草稿箱，确定性检查标出重复内容、敏感信息与相关页面，发布后的页面成为版本化可检索文档。Agent 会在固定知识域内自动维护一至两级分类目录，只有没有匹配路径时才创建新目录。同一批页面同时供记忆星云投影和模型检索使用。可见性默认关闭：`readableSpaces` 为空时不返回检索结果；启用后，运行时新建的 shared 知识域会自动加入可读集合。

## 目录

- [何时使用](#use-this-package)
- [实现说明](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与待办](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## 使用此包

用于文档检索与 LLM Wiki 维护。人工维护的空间内容继续放在 [`../knowledge-base/`](../knowledge-base/GUIDE.md)；任务报告和提取出的技术文档通过浏览器桥或模型工具进入 SQLite 草稿箱。发布草稿会把 Markdown 写入选中的空间，`knowledge_search`、智能问数 Agent 和记忆星云随后读取同一份版本化材料。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部结构——点击展开</summary>

| 文件 | 职责 |
|---|---|
| `src/store.ts` | 空间、版本、分块与检索索引 |
| `src/corpus.ts` | 空间目录加载与按内容哈希的同步 |
| `src/http.ts` | 带 `readableSpaces` 过滤的路由 |
| `src/wiki.ts` | 页面类型、Schema、草稿分析与 Markdown 发布 |
| `src/wiki-service.ts` | 草稿检查、分类维护、发布、操作日志与记忆投影 |
| `src/tools.ts` | 面向模型的检索、导入计划与 Wiki 工具 |

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [`../vault/`](../vault/README.zh.md) — 同一 profile 的凭据存储

-----

<a id="model-experience"></a>
## 模型体验

模型可以检索知识；在 preset 授权时，还可以查询已维护的分类、创建经过检查的 Wiki 草稿、重新运行检查，并把可发布草稿发布到已有空间和分类目录。Agent 不创建顶级知识域。

#### KV 缓存影响

无；本包既不构造也不发送模型请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **可见性为空则结果为空** — 忘记配置 `readableSpaces` 的部署会得到一个能跑但沉默的知识库。
- **语义矛盾仍需复核** — 确定性检查覆盖结构、哈希、敏感信息与相关页面；语义层是否冲突仍由 Agent 判断。
- **发布是显式动作** — 草稿可自动检查，但发布必须选择目标空间或启用相应模型工具。
- **自动分类初始为待确认** — 没有现成路径时 Agent 可以创建目录，之后由复核人确认。
- **仅 BM25** — 没有向量或混合排序路径。
- **同步语料需要重启** — 从另一个进程写数据库是安全的，但运行中的宿主只提供其内存索引，直到重启。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>

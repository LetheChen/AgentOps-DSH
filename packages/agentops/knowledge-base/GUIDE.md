# 知识库语料

AgentOps 知识库的可评审来源。每个一级子目录是一个宏观知识域：`space.yaml` 声明空间标识、业务说明与可见性。平面域直接存放 Markdown；有分类的域再按稳定文档类型建立一级分类。

运行 `node --import tsx agentops/scripts/sync-knowledge.ts --write` 把它们写进 `$DSH_HOME/agentops/knowledge.db`。

## 分区

| 一级目录 | 空间标识 | 可见性 | 结构 |
|---|---|---|---|
| `财务制度/` | `finance` | shared | 平面域，不设二级目录 |
| `人事政策/` | `hr` | restricted | 平面域，不设二级目录 |
| `运维手册/` | `ops` | shared | 平面域，不设二级目录 |
| `办公协作/` | `office_docs` | shared | `周报`、`会议记录`、`系统规划`、`任务总结` |
| `项目分析报告/` | `project_analysis` | shared | 平面域，不设二级目录 |
| `技术文档/` | `technical_docs` | shared | `架构设计`、`接口说明`、`部署实施`、`故障排查`、`技术规范` |
| `学习资料/` | `learning` | shared | `课程`、`书籍文章`、`学习笔记` |
| `业务资产/` | `smart_query` | shared | `智能问数`、`智能审批` |
| `内容创作/` | `content_creation` | shared | `视频模板`、`动效卡片`、`周报模板`、`内容规范` |
| `待复核/` | `review` | shared | 平面域，承接无法确定归属的材料 |

一级目录表示知识长期服务的业务或用途，不按文件格式划分。由模板生成的具体周报进入 `办公协作/周报`；周报模板本身留在 `内容创作/周报模板`。财务制度、人事政策、运维手册、项目分析报告和待复核保持平面结构。

## 新增一个分区

先建目录并写 `space.yaml`，再往里放 Markdown。

```yaml
id: legal          # 小写字母、数字、下划线或连字符
name: 法务规范
description: 一句话说明这个分区收什么
visibility: shared # 或 restricted
readers: []        # restricted 时列 user:<id>
```

每篇文档带 front matter，`tags` 可省略：

```markdown
---
id: legal-contract
title: 合同审查要点
tags: [合同, 法务, 审查]
---

# 适用范围
...
```

`id` 会出现在引用与文档路由里，所以只允许 ASCII 小写标识；标题可以中文，省略 `title` 时取正文第一个一级标题。`tags` 是跨文档复用的内容标签，用于记忆星云中的跨域关联；知识域与细分领域仍由目录结构表达，不重复写成平铺层级。

## 新增或修改一篇文档

改 Markdown 后重跑同步脚本。脚本按正文内容哈希比较：内容没变不产生新版本，改了就追加一个版本，旧版本的切片立刻退出检索。

## 同步

```sh
node --import tsx agentops/scripts/sync-knowledge.ts                  # 只比对，语料有变化时退出码 1
node --import tsx agentops/scripts/sync-knowledge.ts --write          # 写入
node --import tsx agentops/scripts/sync-knowledge.ts --write --prune  # 同时删除语料里已移除的文档
```

`--db <path>` 指向别的数据库；默认按 `AGENTOPS_KNOWLEDGE_DB` → `$DSH_HOME/agentops/knowledge.db` 解析。数据库正被运行中的宿主打开时也可以写，但宿主的内存索引要到重启后才看到新文档。旧版 `weekly` 空间在宿主打开数据库时一次性迁移为 `content_creation`，随后语料同步会把具体周报移动到 `office_docs/周报`；空间权限和 Wiki 页面随迁移保留。平面域中的旧二级分类会在打开数据库时清理。

## LLM Wiki 草稿与发布

任务报告和提取出的技术文档不会直接修改本目录。它们在知识库的 `Wiki 工作台` 中进入草稿箱，随后执行三层流程：

1. **Schema**：确定页面类型（来源、实体、概念、对比、综述）与发布规则。
2. **Raw**：保存报告正文、来源任务、报告 ID 和内容哈希；草稿是只读来源记录。
3. **Wiki**：冲突检查找到重复内容、敏感值、同名页面和相关页面后，人工或 Agent 把无阻断项的草稿发布到目标空间。

发布后的 Wiki 是普通 Markdown 文档并进入同一 BM25 索引，因此 `knowledge_search`、智能问数 Agent 和记忆星云读取的是同一版本。发布页同时写入操作日志；所有宏观知识域中的制度、办公记录、技术文档、学习资料、模板和分析文档都可以作为记忆星云的节点来源。发布到平面域时分类为空。

## 归档规则

Agent 按以下顺序判断，不要求用户手工选目录：

1. **知识归属。** 财务、人事、运维等强治理材料进入对应平面域。
2. **长期用途。** 周报、会议记录、系统规划和任务总结进入 `office_docs`；课程、书籍文章和学习笔记进入 `learning`；架构、接口、部署、故障和工程规范进入 `technical_docs`。
3. **结论性质。** 项目研究、技术选型、竞品比较和方案评估结论进入 `project_analysis`，不复制到技术文档。
4. **业务资产。** 智能问数所需的指标、时间与查询方法进入 `smart_query/智能问数`；智能审批的数据目录与能力边界进入 `smart_query/智能审批`。
5. **可复用内容资产。** 视频模板、动效卡片、周报模板和内容规范进入 `content_creation`。
6. **无法判断。** 来源不明、跨域冲突或置信度不足时进入 `review`，不强行归档。

文档只选择一个主要知识域，关联主题通过 Wiki 链接表达。项目名称、日期、版本号、任务编号和个人姓名不创建目录；这些信息保留在标题、来源或正文中。平面域不写二级目录，有分类的域最多两级。

Agent 归档前先查询已有目录并优先复用；没有匹配时才创建新目录。自动创建的目录标记为待确认，复核人可在 Wiki 工作台确认。完整规则同时沉淀在 `办公协作/系统规划/知识库目录与归档规则.md`。

## 约束

- 一个分区目录只能有一个 `space.yaml`；缺清单或标识不合法的目录会被报告并跳过，不会猜。
- 文档标识全库唯一，重复会被报告并跳过。
- 正文为空、front matter 缺失或 YAML 语法错误的文件会被报告并跳过。

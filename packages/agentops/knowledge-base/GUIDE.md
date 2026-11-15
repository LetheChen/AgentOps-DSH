# 知识库语料

AgentOps 知识库的可评审来源。每个子目录是一个知识分区：`space.yaml` 声明空间标识与可见性，其余 Markdown 是该分区的文档。

运行 `node --import tsx agentops/scripts/sync-knowledge.ts --write` 把它们写进 `$DSH_HOME/agentops/knowledge.db`。

## 分区

| 目录 | 空间标识 | 可见性 | 内容 |
|---|---|---|---|
| `财务制度/` | `finance` | shared | 差旅、发票、采购与付款 |
| `人事政策/` | `hr` | restricted | 请假、加班与调休 |
| `运维手册/` | `ops` | shared | 发布、值班、备份 |
| `Weekly周报/` | `weekly` | shared | 按周沉淀的经营与交付进展 |
| `问数口径/` | `smart_query` | shared | 指标定义、时间口径、常见问法与能力边界；字段名仍以 `describe_database` 为准 |
| `项目分析报告/` | `project_analysis` | shared | GitHub/技术项目分析、选型、部署验证与方案案例；Agent 自动维护二级分类 |

## 新增一个分区

先建目录并写 `space.yaml`，再往里放 Markdown。

```yaml
id: legal          # 小写字母、数字、下划线或连字符
name: 法务规范
description: 一句话说明这个分区收什么
visibility: shared # 或 restricted
readers: []        # restricted 时列 user:<id>
```

每篇文档带 front matter：

```markdown
---
id: legal-contract
title: 合同审查要点
---

# 适用范围
...
```

`id` 会出现在引用与文档路由里，所以只允许 ASCII 小写标识；标题可以中文，省略 `title` 时取正文第一个一级标题。

## 新增或修改一篇文档

改 Markdown 后重跑同步脚本。脚本按正文内容哈希比较：内容没变不产生新版本，改了就追加一个版本，旧版本的切片立刻退出检索。

## 同步

```sh
node --import tsx agentops/scripts/sync-knowledge.ts                  # 只比对，语料有变化时退出码 1
node --import tsx agentops/scripts/sync-knowledge.ts --write          # 写入
node --import tsx agentops/scripts/sync-knowledge.ts --write --prune  # 同时删除语料里已移除的文档
```

`--db <path>` 指向别的数据库；默认按 `AGENTOPS_KNOWLEDGE_DB` → `$DSH_HOME/agentops/knowledge.db` 解析。数据库正被运行中的宿主打开时也可以写，但宿主的内存索引要到重启后才看到新文档。

## LLM Wiki 草稿与发布

任务报告和提取出的技术文档不会直接修改本目录。它们在知识库的 `Wiki 工作台` 中进入草稿箱，随后执行三层流程：

1. **Schema**：确定页面类型（来源、实体、概念、对比、综述）与发布规则。
2. **Raw**：保存报告正文、来源任务、报告 ID 和内容哈希；草稿是只读来源记录。
3. **Wiki**：冲突检查找到重复内容、敏感值、同名页面和相关页面后，人工或 Agent 把无阻断项的草稿发布到目标空间。

发布后的 Wiki 是普通 Markdown 文档并进入同一 BM25 索引，因此 `knowledge_search`、智能问数 Agent 和记忆星云读取的是同一版本。发布页同时写入操作日志；财务制度、人事政策、运维手册、项目分析和任务产出的技术文档都可以作为记忆星云的节点来源。

## 项目分析报告分类维护

`project_analysis` 是固定顶级知识域。Wiki 上传和其他业务归档不由 Agent 新建顶级知识域，而是在该域内维护最多两级的分类目录：

- `技术分析/本地部署`
- `技术分析/架构实现`
- `技术分析/性能评测`
- `产品与市场/商业分析`
- `治理与风险/安全合规`
- `任务归档/任务报告`
- `待复核/自动归档`

Agent 归档前先查询已有目录并优先复用；没有匹配时才创建新目录。低置信度、来源不明或分类冲突的资料进入 `待复核/自动归档`，不阻塞归档。自动创建的目录标记为待确认，复核人可在 Wiki 工作台确认。

## 约束

- 一个分区目录只能有一个 `space.yaml`；缺清单或标识不合法的目录会被报告并跳过，不会猜。
- 文档标识全库唯一，重复会被报告并跳过。
- 正文为空、front matter 缺失或 YAML 语法错误的文件会被报告并跳过。

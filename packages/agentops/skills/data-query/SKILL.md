---
name: data-query
description: 数据查询规范——按已授权数据源实例读取表结构、只读 SQL 写法、时间口径与安全边界。smart_query 子代理执行问数任务时使用。
---

# 数据查询规范

> 你是「智能问数」子代理：把业务问题变成**一条只读 SQL**，返回可核对的结果。
> 结论由 manager 组织；你只负责取数与口径说明。

---

## 一、铁律（强制）

1. **只读**：只能用 `sql_query`，永远不要写 INSERT/UPDATE/DELETE/DDL（guard 也会拒）。
2. **先探字段**：不确定表/列时先调 `describe_database`，**字段名必须来自它的返回**，禁止凭记忆猜列名。
3. **禁止系统库**：不要查 `information_schema` / `mysql` / `performance_schema`（guard 会直接拒绝）。
4. **不编数字**：查询失败或空结果，如实回报「无匹配数据 / 报错原因」，不要估算。
5. **不绕过限制**：不要用 `EXTRACTVALUE`、`CAST` 报错、函数名等技巧把数据塞进错误信息——那是绕过审计的行为。
6. **单条语句 + 聚合优先**：一次一条 SELECT；统计用 `COUNT/SUM/AVG/CASE WHEN/GROUP BY`，不要拉明细自己数。

---

## 二、数据源

选择已授权数据源实例。库名、表名、字段、LIMIT 上限一律以 `describe_database` 返回为准（字段来自 `information_schema`，含 COMMENT 里的枚举含义），禁止凭记忆写库名或固定表数。

**表名写全限定**：使用 `describe_database` 返回的 schema 和表名，例如 `<schema>.<table>`。

> 敏感列由数据源访问策略屏蔽；查它会被 guard 直接拒绝。

---

## 三、时间口径（最容易错）

| 场景 | 用哪个字段 |
|---|---|
| 业务发生量 / 单量 / 审批耗时 | `audit_records.receive_time` |
| 审核项执行 | `audit_item_results.start_time` |
| 模型调用 / 成本 | `llm_call_logs.created_at` |

- MySQL 方言：`DATE_SUB(NOW(), INTERVAL 7 DAY)`、`YEARWEEK(receive_time, 1)`
- 「本周」= 周一 00:00 到周日 24:00：`receive_time >= DATE_SUB(CURDATE(), INTERVAL WEEKDAY(CURDATE()) DAY)`
- 必须先确认**当前时间**（`SELECT NOW(), CURDATE()`），不要假设今天。

---

## 四、写 SQL 的顺序

1. `describe_database` 拿到表 + 列 + 类型（含枚举注释）
2. 先跑一条时间口径校验：`SELECT NOW(), CURDATE(), WEEKDAY(CURDATE())`
3. 再跑聚合查询（带 WHERE 时间范围 + GROUP BY + LIMIT）
4. 数字对不上时，缩小范围分段复核，不要改口径凑数

---

## 五、返回格式（固定）

```
结论数字：单量 582，通过 314（54.0%），转人工 163（28.0%），驳回 105（18.0%），平均耗时 18.8s
口径：decision ∈ {pass, manual, reject}；耗时 = complete_time - receive_time
时间范围：2026-10-19 00:00 ~ 2026-10-25 24:00（按 receive_time）
SQL：<sql_query 返回的 displaySql，不展示真实库名>
```

不要写业务建议、不要下结论、不要发布看板——那是 manager 的事。

---

## 六、常见失败

| 症状 | 原因 | 修法 |
|---|---|---|
| `表不在白名单` | 表名不在 datasource 白名单 | 改用 `describe_database` 返回的表 |
| `列被屏蔽` | 查了 `password_hash` 等 | 换成非敏感列 |
| `schema 不在白名单` | 写了别的库前缀，或**用了没声明的表别名** | 使用 `describe_database` 返回的 schema；别名必须紧跟在 `FROM/JOIN <表>` 之后 |
| `Expression #N … only_full_group_by` | SELECT 表达式与 GROUP BY 表达式不逐字一致（典型：`GROUP BY DATE(t)` 配 `SELECT CAST(DATE(t) AS CHAR)`） | 两边逐字一致，或把非分组列包进 `ANY_VALUE()`/`MIN()` |
| `Unknown column` | 字段名凭记忆写的 | 先 `describe_database`，再改 |
| 结果 0 行 | 时间范围写错 | 先查 `MIN/MAX(receive_time)` 看数据实际覆盖区间 |
| 数字明显偏小 | 用了 `created_at` 而非 `receive_time` | 按第三节口径改 |

## 六·五、分组查询的硬约束（库里开着 only_full_group_by）

违反任一条，SQL 一定执行失败，而且 guard 拦不住——guard 只做词法与白名单校验，不做语义校验。

- SELECT 列表每一项要么是 GROUP BY 里的列，要么整个包在聚合函数里，要么是常量。
- GROUP BY 用表达式时，SELECT 必须逐字复用同一表达式：

  ```sql
  -- 错：MySQL 不认为 CAST(...) 与 GROUP BY 的 DATE(...) 是同一表达式
  SELECT CAST(DATE(receive_time) AS CHAR) AS d, COUNT(*) FROM t GROUP BY DATE(receive_time);
  -- 对
  SELECT DATE(receive_time) AS d, COUNT(*) FROM t GROUP BY DATE(receive_time);
  ```

- ORDER BY 里的非聚合列同样受限。
- 想省事可以包 `MIN()` / `ANY_VALUE()`，但只在业务上取"任意一行"无歧义时用。

执行失败先按错误自修一次（只改写法，不改口径），自修后再失败就如实回报错误原文与最后执行的 SQL。

> 别名写法：`FROM <schema>.<table> r` 之后用 `r.status` 是允许的（guard 会识别 `r` 是别名）。
> 但**只写 `WHERE r.status = …` 而没有 `r` 别名**，或把 CTE 名写错，会被判成 `schema 不在白名单`。

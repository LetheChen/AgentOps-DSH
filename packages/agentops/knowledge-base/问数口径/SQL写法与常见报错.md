---
id: smart-query-sql-traps
title: SQL 写法与常见报错
---

# 为什么单独写一篇

取数失败大多不是数据问题，而是写法问题。这里收的是"guard 拦不住、数据库会拒"的那一类，写 SQL 之前先扫一眼。

# 分组查询（only_full_group_by）

库里开着 only_full_group_by，分组查询的 SELECT 列表里每一项必须满足三者之一：是 GROUP BY 里的列、整个包在聚合函数里、是常量。

GROUP BY 用表达式时，SELECT 必须逐字复用同一个表达式。把表达式再包一层函数，MySQL 就不认这种函数依赖，会报 Expression #N ... only_full_group_by。

失败示例：GROUP BY DATE(receive_time)，SELECT 里写 CAST(DATE(receive_time) AS CHAR)。
可行写法：SELECT DATE(receive_time) 配 GROUP BY DATE(receive_time)，或 SELECT DATE(MIN(receive_time))。

ORDER BY 里的非聚合列同样受这条约束。

# 时间过滤

区间用左闭右开，起止都写成显式表达式，不要依赖当前时间做隐式假设。跨零点和跨月的边界由表达式本身保证。

对时间列做函数（DATE()、YEARWEEK()）会让索引失效，只在分组维度上做，不要在 WHERE 的大范围过滤上用。

# 常见报错对照

| 报错 | 含义 | 处理 |
|---|---|---|
| Expression #N ... only_full_group_by | 分组表达式与 SELECT 表达式不一致 | 逐字一致，或包聚合 |
| Unknown column | 字段名不对 | 先 describe_database，按返回改 |
| Table ... doesn't exist | 表名不是白名单里的那几张 | 只用白名单表 |
| 列被屏蔽 / schema 不在白名单 | guard 拒了 | 换非敏感列、去掉别的库前缀 |
| 查询超时 | 范围太大或没走索引 | 收窄时间范围，先聚合再明细 |

# 失败后的处理顺序

先判断能不能自修：语法、分组、函数、类型问题都能自修，只改写法不改口径，且只重试一次。

权限、白名单、连接失败、超时不要重试，直接如实回报。

自修后仍失败，回复里要带上错误原文和最后执行的那条 SQL，方便人工复核。

# 不要做的事

不要为了跑通而改口径（比如把"本周"改成"最近 30 天"）；不要把失败的查询说成"无数据"；不要用结果为空来掩饰语法失败。

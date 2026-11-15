# 现有生产工作流模式

## 日志采集：确定性 IO 与汇总分离

参考：`agentops/workflows/log-puller.yaml`

模式：

1. `pull` 节点只调用 `pull_logs`，参数是 `log_task_id`。
2. 工具返回完整结构化 JSON，包含 `files[].delta_start/delta_end/skipped/bytes`。
3. `summarize` 节点消费 `pull_result`，写采集报告。
4. 采集不做日志内容分析。
5. 日志采集与日志巡检分开调度；巡检不重复增加采集节点。

重要约束：

- SSH 主机、远程路径、本地业务目录和凭证由能力中心日志采集任务解析；模型不传 host/path/credential。
- `pull_logs` 的模型侧结果必须是完整 JSON，不得只返回人类摘要。
- 失败时保留错误原文，不生成“成功”报告。
- ACL 必须同时允许 `log_puller` 采集、`log_analyst` 查询；工作流配置正确但 ACL 缺失仍会在工具层失败。

推荐节点输出：

```json
{"pull_result": "{\"ok\":true,\"files\":[...]}"}
```

或直接结构化对象：

```json
{"pull_result": {"ok": true, "files": []}}
```

## 日志巡检：scan → analyze → report → notify

参考：`agentops/workflows/log-patrol.yaml`

模式：

1. `scan` 调用 `log_read_delta`，只读自上次分析位点以来的增量。
2. `analyze` 根据扫描结果和固定规则判定重大问题。
3. `report` 生成 Markdown 报告。
4. `notify` 仅在存在重大问题时调用能力中心绑定的通知工具。
5. 四个节点复用同一个 `log_analyst` Agent，保持权限一致。

关键点：

- 扫描结果必须带 `truncated`、文件范围、匹配行和错误。
- 分析规则必须写明阈值，不能只说“分析异常”。
- 报告节点必须真实写文件；无数据时报告“无增量”，不能等同于“系统健康”。
- 通知工具只接收内容/标题等业务参数，Webhook URL 和凭证由能力中心实例解析。
- `skip_if` 分支的终止节点各自输出，避免未选分支继续执行。

## 智能问数：路由 → SQL → 执行 → 呈现

参考：`agentops/workflows/smart-query.yaml`

模式：

1. `route_intent` 判断是否属于数据查询，输出布尔 `intent`。
2. 两个互斥分支用 `skip_if` 守卫：
   - `refuse_intent`：拒绝非数据查询，直接终止。
   - `plan_sql`：只生成 SQL，不执行。
3. `run_sql` 调用只读 `sql_query`，失败只允许按最小改写重试一次。
4. `present_result` 把结构化结果转成用户可读答案。
5. 所有节点复用 `smart_query` Agent。

关键点：

- 字段必须来自 `describe_database`，不能凭记忆猜。
- 只读 SELECT；禁止 DDL/DML。
- 时间和业务口径来自 `data-query` skill，不在工作流里硬编码“今天”。
- 执行失败和空结果是两种状态，都不能伪造成功。
- 结果过大要截断并显式标注 `truncated=true`。

## 共同的反模式

- 为了“看起来完整”增加不执行任何职责的节点。
- 把多个业务动作塞进一个节点，导致输出契约无法验证。
- 用 JSON 字符串包裹一切，却不告诉下游内部字段。
- 依赖节点级 `inputs` 做隐式传值。
- 依赖 `{{workspace.root}}` 生成路径。
- 使用 `handoff`、`output_files` 对齐规则或旧 `command` 节点。
- 校验通过就直接声称生产可用，未核对 Agent、工具、ACL 和外部连接。
- 创建后自动执行有副作用的流程。
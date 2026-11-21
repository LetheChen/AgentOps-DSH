---
name: production-deployment
description: 使用 AgentOps artifact_build 与 deployment_* 能力完成受控构建、生产发布、镜像备份、健康检查和回滚时使用；不允许用通用 shell 或 SSH 绕过部署能力。
---

# 生产构建与部署

该 skill 只描述操作判断；实际根目录、SSH 实例、目标路径、命令、超时和健康检查来自 artifact-build / deployment capability instance。

## 铁律

1. 构建与生产发布分开：`build_operator` 只调用 `artifact_build`；`deploy_operator` 只调用 `deployment_*`。
2. 不接受用户临时提供的 host、用户名、密码、私钥、目标路径或任意 SSH 命令。
3. 生产发布前必须先 `deployment_plan`；发布和回滚必须经过工具内置审批。
4. 不把 `app:latest` 当作回滚身份。回滚身份是 journal 记录的当前 image id 与 timestamped backup tag。
5. SSH 结果不确定时报告 `unknown_hold`，不得重试、猜测成功或自行标记健康。
6. 数据库恢复是独立操作；应用镜像回滚不等于数据库回滚。

## 构建阶段

1. 确认当前工作区就是目标项目。
2. 调用 `artifact_build`，参数只用 `build_instance_id`。
3. 检查结果：
   - `ok=true`
   - `release_id` 存在
   - manifest 中每个 `artifactFiles[].sha256` 与目标文件一致
4. 构建失败时原样报告 `error.code`、`error.message` 和失败命令阶段，不生成成功报告。

## 发布前

1. 调用 `deployment_plan`，mode 默认 `update`；只有明确首次安装才用 `first_install`。
2. 确认 artifact manifest 覆盖所需文件，并且 build instance 与 deployment instance 使用兼容的 artifact 根，manifest 相对路径完全一致。
3. 确认当前实例允许发布，并确认当前 journal 没有 `unknown_hold`。
4. 如果目标实例已有 `unknown_hold`，先调用 `deployment_status`，不要继续发布。

## 日常发布

期望工具顺序：

```text
读取当前运行 image id
→ 创建 app:backup-YYYYMMDD-HHMMSS-<shortImageId>
→ 写入 release journal
→ 上传并校验新 artifact
→ docker load 新 app:latest
→ 按策略迁移
→ 只重建应用
→ 健康检查
```

调用 `deployment_release`。工具会负责备份、上传、导入与健康检查；Agent 不自行拼 docker 命令。

成功后报告：

- `instance_id`
- `release_id`
- `state`
- `image_id`
- `backup_tag`
- `backup_image_id`
- 健康检查结果

## 失败与 unknown_hold

- 明确非零退出码：报告失败，不声称回滚完成。
- SSH 断开或结果不确定：报告 `unknown_hold`，提示先执行 `deployment_status`。
- 健康检查失败：报告失败、当前 image id 和 backup tag；不要自动恢复数据库。
- 需要回滚时调用 `deployment_rollback`，参数使用已记录的健康 `release_id`。

## 数据安全

- 迁移或数据库变更前必须有可验证的 MySQL 备份；没有备份证据不得宣称发布安全。
- 不删除 `/opt/app/data/mysql`、`/opt/app/data/redis`。
- env 文件不得回显、写入回复或提交。

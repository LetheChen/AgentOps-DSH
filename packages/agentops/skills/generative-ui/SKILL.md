---
name: generative-ui
description: 生成式 UI 指南——用 present_content 工具把结构化结果渲染成 A2UI 可视化面板（右侧大屏）。当需要展示图表、指标组、流程状态或对比数据时使用。
---

# 生成式 UI 指南

本 skill 教你**什么时候**该把内容可视化、**怎么**写一份能通过校验的 A2UI surface。

渲染位置：**右侧「生成式 UI」大屏**（不是聊天气泡）。发布后大屏会自动打开并显示最新一份 surface。

---

## 一、什么时候用

**用**，当满足任意一条：

- 要展示 **3 个以上数字**（指标组、对比、占比）
- 数据有**结构**：按类目分组、按时间趋势、按节点流转
- 用户会**反复回看**或**对比**（预算 vs 实际、本周 vs 上周）
- 需要**流程/进度**的全局视图（DAG 节点状态、任务阶段）

**不用**：

- 一句话能说清的结论
- 纯文本报告、代码、报错堆栈
- 少于 3 个数据点
- 用户没要求、也没有对比价值的内容（每次发布都会抢占大屏）

> 判断口径：**如果贴成文字会让人眯眼找重点，就该可视化。**

## 二、看板模型（重要）

右侧是一块**固定看板**，不是信息流。每张卡片有 `viewId`：

| 你想要的 | 怎么做 |
|---|---|
| 更新某张卡片（同主题新数据） | 用**同一个** `viewId` 再发一次，就地替换 |
| 新增一张卡片 | 换一个 `viewId` |
| 整块看板重来 | 每个 viewId 各发一次；不会再叠历史 |

推荐命名：`overview`（概览指标）、`trend`（趋势）、`breakdown`（结构/占比）、`table`（明细）、`flow`（流程）。
**不要**每次都用新 id，那会把看板变成历史堆积。

## 三、推送图片

浏览器或桌面截图完成后，仍然使用生成式 UI 的 `present_content`，发布 `content_type: "image"` 卡片。它内部复用 A2UI 标准 `Image` 组件，不要再手写 `Image` 组件，也不要把 base64 塞进 `surface`。

```json
{
  "name": "present_content",
  "arguments": {
    "title": "登录页截图",
    "content_type": "image",
    "data": {
      "source": "latest-screenshot",
      "caption": "修复后的登录页"
    },
    "viewId": "login-shot"
  }
}
```

- `data.source` 省略时默认 `latest-screenshot`：读取当前会话最近一次截图工具结果（浏览器 MCP、桌面截图均可）。Chrome DevTools 只返回“Saved screenshot to …”路径时，也会自动读取该文件。
- 也可以传当前工作区内的 PNG/JPEG/WebP/GIF 路径，或安全的 HTTP(S) 图片 URL。
- 同 `viewId` 再发一次会就地替换图片；省略 `viewId` 时替换默认图片卡片 `image`。
- 不接受 data URL、HTML 或裸 base64；本地/截图图片必须是 PNG、JPEG、WebP 或 GIF。
- `data`、`surface`、`content` 必须优先传对象；工具兼容 JSON 字符串，但不要主动把嵌套对象序列化成字符串。

## 四、工具签名

```json
{
  "name": "present_content",
  "arguments": {
    "title": "本周审核业务概览",
    "surface": { "version": "v1.0", "catalogId": "https://agentops.dev/a2ui/catalogs/core/v1", "components": [ ... ] },
    "content": { "bar": [ { "label": "差旅报销", "value": 386 } ] }
  }
}
```

- `title`：大屏标题，**必填**，一句话说清范围与时间
- `surface`：A2UI v1 组件树，**必填**
- `content`：**数据模型**，组件通过路径绑定读取（图表必须用）
- 返回：`{ stored: true, id, components }`；失败时 `stored: false` 并给出 `reason`

## 五、surface 骨架（固定三件）

```json
{
  "version": "v1.0",
  "catalogId": "https://agentops.dev/a2ui/catalogs/core/v1",
  "components": [
    { "id": "root", "component": "AoSection", "title": "概览", "children": ["m1", "m2", "bar"] },
    { "id": "m1", "component": "AoMetric", "label": "调用总数", "value": "1764", "unit": "次", "tone": "info" },
    { "id": "m2", "component": "AoMetric", "label": "成功率", "value": "100", "unit": "%", "tone": "positive" },
    { "id": "bar", "component": "AoBarChart", "source": { "path": "/bar" }, "itemLabelPath": "/label", "itemValuePath": "/value", "unit": "单" }
  ]
}
```

规则：

1. `version` 必须是 `v1.0`，`catalogId` 必须是上面那一串（写错直接拒收）
2. `id` 唯一；父组件用 `children: [id…]` 或 `child: id` 引用子组件
3. **必须恰有一个 `id` 为 `root` 的根组件**，其余组件由它（或它的子组件）用 `children` 引用；schema 会强制校验这一条

## 六、可用组件（只列常用的）

| 组件 | 必填 | 说明 |
|---|---|---|
| `AoSection` | `children` | 区块，可带 `title`、`tone` |
| `AoGrid` | `columns`、`children` | 栅格：`columns: { default: 3, compact: 1 }` |
| `AoMetric` | `label`、`value` | 指标卡；`unit` 可选；`value` 是字符串更安全 |
| `AoProgress` | `value`（数字） | 进度/占比；`label` 可选 |
| `AoStatusBadge` | `text` | 状态徽标 |
| `Text` | `text` | 段落/说明；`variant` 只能是 `caption` 或 `body`（**没有 h1/h2/h3**） |
| `Image` | `url` | A2UI 标准图片组件；`fit` 可选 `contain/cover/fill/none/scaleDown`。截图通过 `present_content` 的 `content_type:"image"` 发布 |
| `AoBarChart` | `source` + `itemLabelPath` + `itemValuePath` | 条形/分组柱状 |
| `AoPieChart` | `source` + `itemLabelPath` + `itemValuePath` | 饼图 |
| `AoLineChart` | `source` + `xAxis` + `seriesNamePath` + `seriesDataPath` | 折线（多系列） |
| `AoDag` | `source` + `itemIdPath` + `itemLabelPath` + `itemDependsOnPath` | 流程节点图 |

`tone` 只能是：`neutral` / `info` / `positive` / `warning` / `critical`。

## 七、数据绑定（最容易错的地方）

图表**不接受内联数组**，必须：

1. 数据放进 `content`：

```json
"content": { "bar": [ { "label": "差旅报销", "value": 386 }, { "label": "费用报销", "value": 85 } ] }
```

2. 组件用 `source: { "path": "/bar" }` 指向它，再用 `itemLabelPath: "/label"`、`itemValuePath: "/value"` 指出字段。

路径格式：以 `/` 开头，字段名直接写；**不要**写 `bar[0].label` 这种表达式。

折线图多系列：

```json
"content": { "trend": { "x": ["周一","周二"], "series": [ { "name": "通过", "data": [12, 18] } ] } }
```
组件侧：`"source": { "path": "/trend" }`, `"xAxis": { "path": "/x" }`, `"seriesNamePath": "/name"`, `"seriesDataPath": "/data"`。

## 八、常见失败与自查

| 症状 | 原因 | 修法 |
|---|---|---|
| `stored:false`，`version` 报错 | 版本号不是 `v1.0` | 照抄骨架 |
| `stored:false`，`catalogId` 报错 | 目录地址拼错 | 照抄骨架 |
| 图表空白 | 没传 `content` 或 `source.path` 指错 | 检查 path 名与 content 键名一致 |
| 校验报 `additionalProperties` | 组件用了不存在的字段（如给 AoMetric 加 `items`） | 只写上表字段 |
| 校验报 `must be equal to constant` | 组件名拼错（大小写敏感） | 对照组件表 |
| 大屏没更新 | 发布成功但页面没刷新 | 大屏自动轮询最新一份，等 4 秒或手动刷新 |
| `present_content` 图片卡说没有截图 | `latest-screenshot` 只认本会话中的截图工具结果 | 先调用截图工具；或把截图保存到工作区后传文件路径 |

**发布前自查三问**：数字对不对？单位和口径写了吗？标题能让人一眼知道范围吗？

**发布前必查三项（校验器会拒）**：

1. 每个组件都有 `id` 和 `component`（组件名大小写敏感，只认上表）
2. 属性**平铺**，不能包在 `props` 里
3. `tone` 只用 `neutral/info/positive/warning/critical`；`Text.variant` 只用 `caption/body`

## 九、一次完整调用（可直接改）

```json
{
  "title": "本周审核业务概览（10-20 ~ 10-26）",
  "viewId": "overview",
  "surface": {
    "version": "v1.0",
    "catalogId": "https://agentops.dev/a2ui/catalogs/core/v1",
    "components": [
      { "id": "root", "component": "AoSection", "title": "审核业务概览", "tone": "info", "children": ["m1", "m2", "p1", "bar", "pie"] },
      { "id": "m1", "component": "AoMetric", "label": "接口调用总数", "value": "1764", "unit": "次", "tone": "info" },
      { "id": "m2", "component": "AoMetric", "label": "LLM 成功率", "value": "100", "unit": "%", "tone": "positive" },
      { "id": "p1", "component": "AoProgress", "label": "转人工率", "value": 19.7, "tone": "warning" },
      { "id": "bar", "component": "AoBarChart", "source": { "path": "/bar" }, "itemLabelPath": "/label", "itemValuePath": "/value", "unit": "单" },
      { "id": "pie", "component": "AoPieChart", "source": { "path": "/pie" }, "itemLabelPath": "/label", "itemValuePath": "/value", "unit": "项" }
    ]
  },
  "content": {
    "bar": [
      { "label": "差旅报销", "value": 386 },
      { "label": "费用报销", "value": 85 },
      { "label": "采购合同", "value": 49 },
      { "label": "合同评审", "value": 16 }
    ],
    "pie": [
      { "label": "通过", "value": 2190 },
      { "label": "转人工", "value": 569 },
      { "label": "拒绝", "value": 124 }
    ]
  }
}
```

## 十、硬限制

- 单个 surface ≤ **64 KB**
- 组件数 ≤ **128**，直接子节点 ≤ **24**
- 嵌套深度 ≤ **8**

超限会被拒收（不会降级渲染），请先聚合再发布。

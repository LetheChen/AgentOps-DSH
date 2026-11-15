# Agent Note: 可折叠的侧栏面板分组

Status: implemented

[English](2026-10-29-collapsible-sidebar-sections.md) | 中文

## Problem

客户端插件可以向 `sidebar.panellist` 注册独立入口，但侧栏把所有入口都渲染成扁平导航项。部署需要把相关面板收进一个一级标题下，却无法通过 profile、bundle 或 preset 表达分组。把侧栏复制进产品插件又会分叉通用导航、无障碍、Pin 和折叠行为。

## Decision

list 注册项可以携带可选的 `section` 元数据，包含稳定 id、可选 order 和 locale-aware label。`ui-slots` 在保存注册项时复制该元数据。`ui-sidebar` 校验同一 id 的注册项具有一致的 label 与 order，把已 Pin 的子项归入一个可折叠分组；section order 优先使用元数据，缺省时取最早子项的顺序。选中子项会展开其分组；More 菜单仍以扁平列表展示每个面板。

## Alternatives considered

**在侧栏中硬编码 AgentOps 分组 id。** 否决，因为侧栏是通用 DSH 包，不应获得产品特定知识。

**在 AgentOps 客户端插件内渲染分组。** 否决，因为插件贡献的是面板入口，不是侧栏容器；重造导航外壳会复制 Pin、折叠、键盘和无障碍行为。

**为每个分组要求一个独立嵌套 slot 声明。** 否决，因为分组只是现有独立面板注册项上的展示元数据，不是新的组合位置或生命周期。

## Consequences

插件现在可以给相关面板分组，而不必为每个产品修改侧栏实现。侧栏会强制同一分组的元数据一致，未 Pin 的入口仍可单独访问。分组展开状态是内存 UI 状态，刷新后重置，不属于 Session 或 profile 数据。非法的 section label 或 order 会在注册同步时失败，而不会静默生成重复标题。

## Testing

聚焦客户端测试覆盖元数据复制、section 元数据冲突、可折叠渲染、活动分组自动展开、侧栏收起时点击分组，以及 More 菜单的扁平行为。受影响 `ui-sidebar` 与 `ui-slots` 测试共 57 条通过。
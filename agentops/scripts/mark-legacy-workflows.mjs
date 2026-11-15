/**
 * One-off: mark workflows that cannot be owned by an Agent under the workflow
 * ownership model. Kept as a script so the exact text written is reviewable.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const dir = 'agentops/workflows'

const LEGACY = {
  'content-curation': {
    reason: 'inline-agent-permissions',
    detail: '节点用 inline_agent 自带 allowed_tools，与「节点继承所属 Agent 权限」冲突；DSH 解析期直接拒绝。重写为显式 Agent 后才可执行。',
  },
  'docker-container-demo': {
    reason: 'inline-agent-permissions',
    detail: '节点用 inline_agent 自带 allowed_tools，与「节点继承所属 Agent 权限」冲突；DSH 解析期直接拒绝。',
  },
  'travel-expense': {
    reason: 'multi-agent-nodes',
    detail: '12 个节点分别引用 10 个不同 Agent，违反「一条工作流 = 一个显式 Agent」。需拆成单 Agent 工作流后重写。',
  },
  'example-greet': {
    reason: 'missing-agent',
    detail: '节点引用 content_curator，原项目 config/agents/ 中并不存在该 Agent；PoC 样例，从未能执行。',
  },
  'hello-world': {
    reason: 'missing-agent',
    detail: '节点引用 echo_agent，原项目 config/agents/ 中并不存在该 Agent；PoC 样例，从未能执行。',
  },
  'hybrid-test': {
    reason: 'missing-agent',
    detail: '节点引用 echo_agent，原项目 config/agents/ 中并不存在该 Agent；PoC 样例，从未能执行。',
  },
}

const block = (reason, detail) => [
  '',
  '# LEGACY（工作流归属模型，REVIEW-manager-dispatch-2026-11-03）',
  '# 保留为拓扑样例，不可执行：没有 Agent 声明它，也没有任何执行入口会启动它。',
  'legacy:',
  `  reason: ${reason}`,
  `  detail: ${JSON.stringify(detail)}`,
  '',
].join('\n')

for (const [workflowId, meta] of Object.entries(LEGACY)) {
  const path = join(dir, `${workflowId}.yaml`)
  const source = readFileSync(path, 'utf8')
  if (/^legacy:/m.test(source)) {
    console.log(`${workflowId}: already marked, skipped`)
    continue
  }
  const lines = source.split('\n')
  const boundary = lines.findIndex((line, index) => index > 0 && /^(layout|workspace|nodes|inputs):/.test(line))
  if (boundary === -1) throw new Error(`${workflowId}: no top-level boundary found`)
  const next = [...lines.slice(0, boundary), ...block(meta.reason, meta.detail).split('\n'), ...lines.slice(boundary)]
  writeFileSync(path, next.join('\n'))
  console.log(`${workflowId}: marked legacy (${meta.reason})`)
}

"""Visual contract: measurable style invariants for every AgentOps panel."""

import json
import os
import sys
import tempfile
from playwright.sync_api import sync_playwright

URL = sys.argv[1]
PANELS = [
    "AgentOps", "知识库", "工作流", "Agent 管理", "定时计划",
    "运行历史", "安全与访问", "监控中心", "协作可视化",
    "任务报告", "凭证管理", "会话回放",
]

PROBE = """() => {
  const px = v => v
  const surface = document.querySelector('.agentops-surface')
  const s = surface ? getComputedStyle(surface) : null
  const table = document.querySelector('.data-table')
  const th = table ? table.querySelector('thead th') : null
  const rows = table ? table.querySelectorAll('tbody tr').length : 0
  // 样式对最后一行去边框，因此只对多行表校验首行
  const td = table ? table.querySelector('tbody tr:first-child td') : null
  const pill = document.querySelector('.status-pill')
  const primary = document.querySelector('.btn-primary')
  const input = document.querySelector('.input-base')

  const info = el => {
    if (!el) return null
    const cs = getComputedStyle(el)
    const box = el.getBoundingClientRect()
    return {
      bg: cs.backgroundColor, color: cs.color, border: cs.borderTopWidth + ' ' + cs.borderTopColor,
      padding: cs.padding, w: Math.round(box.width), h: Math.round(box.height),
    }
  }
  return {
    surface: s ? { bg: s.backgroundColor, color: s.color, height: Math.round(surface.getBoundingClientRect().height) } : null,
    table: table ? {
      rows,
      tdBorderBottom: td ? getComputedStyle(td).borderBottomWidth : null,
      thColor: th ? getComputedStyle(th).color : null,
      thUpper: th ? getComputedStyle(th).textTransform : null,
    } : null,
    pill: info(pill),
    primary: info(primary),
    input: info(input),
    overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
  }
}"""

with sync_playwright() as p:
    browser = p.chromium.launch(channel="chrome", headless=True)
    page = browser.new_page(viewport={"width": 1600, "height": 1000})
    page.goto(URL, wait_until="domcontentloaded")
    page.wait_for_timeout(7000)

    report = {}
    for label in PANELS:
        entry = page.get_by_text(label, exact=True)
        if entry.count() == 0:
            report[label] = {"entry": False}
            continue
        entry.first.click(timeout=8000)
        page.wait_for_timeout(2000)
        report[label] = page.evaluate(PROBE)

    open(os.path.join(tempfile.gettempdir(), "visual-report.json"), "w", encoding="utf-8").write(
        json.dumps(report, ensure_ascii=False, indent=2))
    browser.close()

DARK_BG = "rgb(11, 15, 20)"
problems = []
for name, probe in report.items():
    if not probe.get("surface"):
        problems.append(f"{name}: 缺少 surface")
        continue
    if probe["surface"]["bg"] != DARK_BG:
        problems.append(f"{name}: surface 底色 {probe['surface']['bg']}")
    if probe["surface"]["height"] < 900:
        problems.append(f"{name}: 高度 {probe['surface']['height']} < 900")
    if probe["overflowX"] > 1:
        problems.append(f"{name}: 横向溢出 {probe['overflowX']}")
    table = probe.get("table")
    if table and table.get("rows", 0) > 1 and table.get("tdBorderBottom") in ("0px", "0"):
        problems.append(f"{name}: 多行表首行单元格无下边框")
    if probe["table"] and probe["table"]["thColor"] in ("rgb(15, 17, 21)",):
        problems.append(f"{name}: 表头文字用了浅色主题色")
    if probe["pill"] and probe["pill"]["bg"] in ("rgba(0, 0, 0, 0)", "transparent"):
        problems.append(f"{name}: 状态徽标无底色")
    if probe["primary"] and probe["primary"]["bg"] in ("rgba(0, 0, 0, 0)", "transparent"):
        problems.append(f"{name}: 主按钮无底色")
    if probe["input"] and probe["input"]["bg"] in ("rgb(255, 255, 255)",):
        problems.append(f"{name}: 输入框仍是白底")

print(json.dumps({"panels": len(report), "problems": problems}, ensure_ascii=False, indent=2))

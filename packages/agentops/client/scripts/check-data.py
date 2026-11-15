"""Data-presence check: does each panel actually render migrated data?"""

import json
import sys
from playwright.sync_api import sync_playwright

URL = sys.argv[1]

CHECKS = {
    "AgentOps": "() => ({ cards: document.querySelectorAll('article').length, lanes: document.querySelectorAll('section').length })",
    "知识库": "() => ({ cards: document.querySelectorAll('.kh-domain-card').length, tabs: document.querySelectorAll('.kh-tab').length })",
    "工作流": "() => ({ cards: document.querySelectorAll('.workflow-card').length, verified: [...document.querySelectorAll('.workflow-card .status-pill')].filter(e => e.textContent.includes('已验证')).length })",
    "Agent 管理": "() => ({ cards: document.querySelectorAll('.agent-card').length })",
    "定时计划": "() => ({ rows: document.querySelectorAll('.data-table tbody tr').length })",
    "运行历史": "() => ({ rows: document.querySelectorAll('.data-table tbody tr').length })",
    "安全与访问": "() => ({ rows: document.querySelectorAll('.data-table tbody tr').length, pills: document.querySelectorAll('.status-pill').length })",
    "监控中心": "() => ({ cards: document.querySelectorAll('.ao-monitor__card').length, agents: document.querySelectorAll('.ao-monitor__agent-card').length, heatCells: document.querySelectorAll('.ao-monitor__heat-cell').length })",
    "协作可视化": "() => ({ rows: document.querySelectorAll('.data-table tbody tr').length })",
    "任务报告": "() => ({ options: document.querySelectorAll('select option').length, tables: document.querySelectorAll('.data-table').length })",
    "凭证管理": "() => ({ rows: document.querySelectorAll('.data-table tbody tr').length })",
    "会话回放": "() => ({ items: document.querySelectorAll('.card [role=button]').length, tables: document.querySelectorAll('.data-table').length })",
}

with sync_playwright() as p:
    browser = p.chromium.launch(channel="chrome", headless=True)
    page = browser.new_page(viewport={"width": 1600, "height": 1000})
    page.goto(URL, wait_until="domcontentloaded")
    page.wait_for_timeout(7000)
    report = {}
    for label, expr in CHECKS.items():
        entry = page.get_by_text(label, exact=True)
        if entry.count() == 0:
            report[label] = {"entry": False}
            continue
        entry.first.click()
        page.wait_for_timeout(2200)
        report[label] = page.evaluate(expr)
    print(json.dumps(report, ensure_ascii=False, indent=2))
    browser.close()

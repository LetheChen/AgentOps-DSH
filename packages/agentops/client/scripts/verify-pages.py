"""Full-surface regression: open every ported AgentOps page and record evidence.

Usage (after starting a host with the AgentOps plugins mounted):

    set DSH_URL=http://127.0.0.1:3099/?token=...
    python packages/agentops/client/scripts/verify-pages.py [screenshot-dir]

Asserts: each sidebar entry exists, its page shows a known marker, every
`/api/agentops/*` route answers 200, and no page error was raised.
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

URL = os.environ.get("DSH_URL", "")
OUT = Path(sys.argv[1] if len(sys.argv) > 1 else ".")

DETAIL_MARKERS = ["阶段时间线", "事件流", "返回看板"]

LAYOUT_PROBE = """() => {
  const surface = document.querySelector('.agentops-surface')
  const rect = surface ? surface.getBoundingClientRect() : null
  return {
    surface: surface !== null,
    bg: surface ? getComputedStyle(surface).backgroundColor : null,
    height: rect ? Math.round(rect.height) : 0,
    overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
  }
}"""

# 页面标记必须只出现在页面里（不能是侧栏文案），否则会假阳。
REMOVED_LABELS = ["运行环境", "模型供应商", "模型凭据"]

PAGES = [
    ("AgentOps", "任务管理"),
    ("知识库", "知识域仪表盘"),
    ("工作流", "个工作流"),
    ("Agent 管理", "身份定义"),
    ("定时计划", "已启用"),
    ("运行历史", "次运行"),
    ("安全与访问", "Token 用量"),
    ("监控中心", "用量与成本"),
    ("协作可视化", "主体"),
    ("任务报告", "状态流转"),
    ("凭证管理", "凭据状态"),
    ("会话回放", "只读回放"),
]

REMOVED_APIS = [
    "/api/agentops/system",
    "/api/agentops/providers",
    "/api/agentops/credentials",
]

APIS = [
    "/api/agentops/tasks",
    "/api/agentops/monitor",
    "/api/agentops/activity",
    "/api/agentops/security/users",
    "/api/agentops/sessions",
    "/api/agentops/knowledge",
    "/api/agentops/workflows",
    "/api/agentops/agents",
    "/api/agentops/schedules",
    "/api/agentops/connections",
]


def main() -> int:
    if not URL:
        print("DSH_URL is required", file=sys.stderr)
        return 2

    with sync_playwright() as p:
        browser = p.chromium.launch(channel="chrome", headless=True)
        page = browser.new_page(viewport={"width": 1600, "height": 1000})
        errors: list[str] = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        page.goto(URL, wait_until="domcontentloaded")
        page.wait_for_timeout(8000)

        removed_pages = {label: page.get_by_text(label, exact=True).count() == 0 for label in REMOVED_LABELS}
        rows = []
        for label, marker in PAGES:
            entry = page.get_by_text(label, exact=True)
            row = {"page": label, "entry": entry.count() > 0}
            if row["entry"]:
                entry.first.click(timeout=8000)
                page.wait_for_timeout(2500)
                row["marker"] = marker in page.locator("body").inner_text()
                # Layout must be painted by us, fill the viewport and not scroll sideways.
                row["layout"] = page.evaluate(LAYOUT_PROBE)
            rows.append(row)

        # 任务详情不是侧栏入口：从看板点第一张卡片进去
        detail = {"opened": False, "markers": {}}
        try:
            page.get_by_text("AgentOps", exact=True).first.click(timeout=8000)
            page.wait_for_timeout(1500)
            page.locator("article").first.click(timeout=8000)
            page.wait_for_timeout(2000)
            body = page.locator("body").inner_text()
            detail = {"opened": True, "markers": {marker: marker in body for marker in DETAIL_MARKERS}}
            page.screenshot(path=str(OUT / "dsh-task-detail.png"))
            page.get_by_text("← 返回看板", exact=False).first.click(timeout=8000)
            page.wait_for_timeout(1000)
        except Exception as error:  # noqa: BLE001
            detail["error"] = str(error)

        apis = {path: page.request.get(f"{URL.split('?')[0].rstrip('/')}{path}").status for path in APIS}
        removed_apis = {path: page.request.get(f"{URL.split('?')[0].rstrip('/')}{path}").status for path in REMOVED_APIS}
        print(json.dumps({"pages": rows, "removed_pages": removed_pages, "detail": detail, "apis": apis, "removed_apis": removed_apis, "page_errors": errors[:8]}, ensure_ascii=False, indent=2))
        browser.close()

    def layout_ok(row):
        layout = row.get("layout") or {}
        return (
            layout.get("surface") is True
            and layout.get("bg") not in (None, "rgba(0, 0, 0, 0)", "transparent")
            and (layout.get("height") or 0) >= 900
            and (layout.get("overflowX") or 0) <= 1
        )

    ok = (all(row.get("entry") and row.get("marker") and layout_ok(row) for row in rows)
          and all(removed_pages.values())
          and all(code == 200 for code in apis.values())
          and all(code != 200 for code in removed_apis.values())
          and not errors
          and detail.get("opened") is True
          and all(detail.get("markers", {}).values()))
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())

"""Execute workflow fixtures with the legacy Python engine and print node states.

Set `AGENTOPS_ROOT` to the legacy project root, then run:

    python packages/agentops/dag/parity/run_legacy.py <fixture.yaml> [...]

Only deterministic-harness fixtures are accepted: any other harness would call
a model and destroy the comparison.
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
from pathlib import Path

ROOT = os.environ.get("AGENTOPS_ROOT")
if ROOT is None:
    raise SystemExit("Set AGENTOPS_ROOT to the legacy AgentOps project root")
sys.path.insert(0, ROOT)


async def run_one(path: str) -> dict[str, object]:
    from orchestrator import LocalSdkOrchestrator, RunRequest

    orchestrator = LocalSdkOrchestrator()
    orchestrator.load_workflow_file(path)
    workflow_id = Path(path).stem

    handle = await orchestrator.run(RunRequest(workflow_id=workflow_id, inputs={"topic": "parity"}))
    final = "unknown"
    async for event in orchestrator.stream_events(handle.run_id):
        name = getattr(event.type, "name", str(event.type))
        if name in ("RUN_COMPLETED", "RUN_FAILED", "RUN_CANCELLED"):
            final = name
            break

    state = await orchestrator.get_run(handle.run_id)
    nodes = {node_id: getattr(status, "value", str(status)) for node_id, status in state.node_states.items()}
    return {"file": Path(path).name, "status": final, "nodes": nodes}


async def main(paths: list[str]) -> int:
    results = [await run_one(path) for path in paths]
    print(json.dumps(results, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main(sys.argv[1:])))

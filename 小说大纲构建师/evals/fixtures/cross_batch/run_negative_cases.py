#!/usr/bin/env python3
"""Adversarial cross-batch tests: mutations pass the validator but MUST be blocked by finalize --previous."""

from __future__ import annotations

import copy
import json
import subprocess
import sys
import tempfile
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(__file__).resolve().parents[3]
FINALIZER = ROOT / "scripts" / "finalize_outline.py"
BASE = Path(__file__).resolve().parent / "dangan_yujin_batch2.json"


def fake_previous(**overrides) -> dict:
    ledger = {
        "ledger_version": "1.1",
        "contract_version": "1.3",
        "last_chapter_number": 3,
        "open_threads": ["TH-001"],
        "foreshadowing_snapshot": {"FS-001": "ADVANCE", "FS-002": "ADVANCE"},
        "entity_terminal": [],
        "story_threads": [{"definition": {"id": "TH-001", "line_id": "L-001", "summary": "主线", "status": "OPEN"}}],
        "chapters": [],
    }
    ledger.update(overrides)
    return ledger


def run_case(name: str, mutate, previous: dict) -> bool:
    doc = json.loads(BASE.read_text(encoding="utf-8"))
    mutate(doc)
    with tempfile.TemporaryDirectory(prefix="cross-batch-neg-") as directory:
        case_path = Path(directory) / "case.json"
        case_path.write_text(json.dumps(doc, ensure_ascii=False), encoding="utf-8")
        previous_dir = Path(directory) / "prev"
        previous_dir.mkdir()
        (previous_dir / "03_连续性账本.json").write_text(
            json.dumps(previous, ensure_ascii=False), encoding="utf-8"
        )
        result = subprocess.run(
            [
                sys.executable,
                str(FINALIZER),
                str(case_path),
                "--previous",
                str(previous_dir),
                "--output-dir",
                str(Path(directory) / "out"),
            ],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
        )
        output = result.stdout + result.stderr
        blocked = result.returncode != 0 and "跨批核验" in output
        marker = "PASS" if blocked else "FAIL"
        detail = [line for line in output.strip().splitlines() if "跨批核验" in line]
        reason = detail[0] if detail else output.strip().splitlines()[-1] if output.strip() else "(no output)"
        print(f"[{marker}] {name}: {reason}")
        return blocked


def renumber(doc, offset):
    doc["chapter_offset"] = offset
    for index, chapter in enumerate(doc["chapters"]):
        chapter["number"] = offset + 1 + index
        chapter["id"] = f"CH-{chapter['number']:04d}"
    doc["volumes"][0]["chapter_start"] = offset + 1
    doc["volumes"][0]["chapter_end"] = offset + len(doc["chapters"])
    for foreshadowing in doc["foreshadowing"]:
        if foreshadowing["id"] == "FS-003":
            foreshadowing["plant_chapter"] = f"CH-{offset + 1:04d}"
    for chapter in doc["chapters"]:
        for entry in chapter.get("axis_advance", []):
            if isinstance(entry.get("evidence"), str):
                entry["evidence"] = f"{chapter['id']}#gocs[0].state_change"


def mutate_offset_overlap(doc):
    renumber(doc, 1)


def mutate_replant(doc):
    doc["chapters"][0]["foreshadowing_ops"].append({"id": "FS-002", "action": "plant", "summary": "重复埋设"})


def mutate_unknown_inherited_thread(doc):
    doc["inherited"]["threads"] = ["TH-001", "TH-999"]
    doc["story_threads"].append({
        "id": "TH-999", "line_id": "L-002", "summary": "伪造承接", "opened_chapter": "CH-0001",
        "planned_resolution_chapter": None, "status": "OPEN",
    })
    doc["chapters"][0]["thread_ops"].append({"id": "TH-999", "action": "advance", "effect": "伪造的承接线程"})


def mutate_downgrade(doc):
    doc["contract_version"] = "1.2"


def mutate_dead_entity(doc):
    doc["chapters"][0]["state_delta"]["changed_state"].append("旧档案室在诉讼保全中被贴上封条")
    doc["chapters"][0]["gocs"][0]["state_change"] += "，旧档案室被贴上封条"


def mutate_reaped_inherited(doc):
    pass  # 由 fake_previous 提供 FS-002=REAP


def main() -> int:
    real_previous = json.loads((Path(sys.argv[1]) / "03_连续性账本.json").read_text(encoding="utf-8")) if len(sys.argv) > 1 else None
    if real_previous is None:
        print("usage: run_negative_cases.py PATH_TO_BATCH1_OUTPUT_DIR")
        return 2
    cases = [
        ("章节重叠（offset 回退）", mutate_offset_overlap, real_previous),
        ("重复 plant 上批伏笔", mutate_replant, real_previous),
        ("承接上一批不存在的线程", mutate_unknown_inherited_thread, real_previous),
        ("从 1.3 降级回 1.2", mutate_downgrade, real_previous),
        ("上一批已销毁实体再现", mutate_dead_entity, fake_previous(
            entity_terminal=[{"name": "旧档案室", "status": "destroyed", "chapter": 2}]
        )),
        ("承接上一批已 REAP 的伏笔", mutate_reaped_inherited, fake_previous(foreshadowing_snapshot={"FS-001": "ADVANCE", "FS-002": "REAP"})),
    ]
    results = [run_case(name, mutate, previous) for name, mutate, previous in cases]
    passed = sum(results)
    print(f"\n{passed}/{len(results)} negative cases blocked")
    return 0 if passed == len(results) else 1


if __name__ == "__main__":
    raise SystemExit(main())

#!/usr/bin/env python3
"""Adversarial regression tests: genre-contract blocks, warn-tier routing, and 1.2 backward compatibility.

Each case mutates a known-good example and asserts the validator's verdict:
- block cases must exit 1 and mention the rule id;
- warn cases must still exit 0 (VALID) but print a WARN line (分级门禁：warn 不拒绝);
- compat cases must stay VALID after downgrading to contract 1.2.
"""

from __future__ import annotations

import copy
import json
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any, Callable

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(__file__).resolve().parents[3]
VALIDATOR = ROOT / "scripts" / "validate_outline.py"
MYSTERY = ROOT / "examples" / "three_chapter_outline.json"
URBAN = ROOT / "examples" / "standalone_batch_danganyujin.json"


def validate(doc: dict, directory: Path) -> subprocess.CompletedProcess[str]:
    path = directory / "case.json"
    path.write_text(json.dumps(doc, ensure_ascii=False), encoding="utf-8")
    return subprocess.run(
        [sys.executable, str(VALIDATOR), str(path)],
        capture_output=True, text=True, encoding="utf-8", errors="replace",
    )


def blocked(result: subprocess.CompletedProcess[str], keyword: str) -> bool:
    output = result.stdout + result.stderr
    return result.returncode != 0 and keyword in output


def warned(result: subprocess.CompletedProcess[str], keyword: str) -> bool:
    output = result.stdout + result.stderr
    return result.returncode == 0 and f"WARN: {keyword}" in output


def valid(result: subprocess.CompletedProcess[str]) -> bool:
    return result.returncode == 0 and "VALID OUTLINE" in result.stdout


def retarget(doc: dict, axis_map: dict[str, str], drop_axes: set[str] = set()) -> None:
    """Switch primary genre and remap every axis to the new vocab (dropping listed axes)."""
    doc["genre_profile"]["progression_axes"] = sorted(set(axis_map.values()) - drop_axes)
    for chapter in doc["chapters"]:
        remapped = []
        for entry in chapter.get("axis_advance", []):
            mapped = axis_map[entry["axis"]]
            if mapped in drop_axes:
                continue
            remapped.append({**entry, "axis": mapped})
        chapter["axis_advance"] = remapped
    for step in doc["story_engine"].get("escalation_ladder", []):
        if isinstance(step.get("axis_refs"), list):
            step["axis_refs"] = [axis_map.get(ref, ref) for ref in step["axis_refs"]]


def case_myst01(doc: dict) -> None:
    doc["foreshadowing"][0]["type"] = "情感关系"


def case_myst02(doc: dict) -> None:
    doc["chapters"][1]["foreshadowing_ops"] = []


def case_myst03(doc: dict) -> None:
    doc["chapters"][2].pop("evidence_refs", None)
    doc["chapters"][2]["axis_advance"] = []


def case_vocab(doc: dict) -> None:
    doc["chapters"][0]["axis_advance"][0]["axis"] = "修炼境界"


def case_rest(doc: dict) -> None:
    doc["chapters"][1]["axis_advance"] = [{"axis": "休整", "delivers": "随口一说的兑现"}]


def case_evidence(doc: dict) -> None:
    for entry in doc["chapters"][0]["axis_advance"]:
        if "evidence" in entry:
            entry["evidence"] = "CH-9999#gocs[0].state_change"


def case_roma01(doc: dict) -> None:
    doc["genre_profile"]["primary"] = "romance"
    doc["genre_profile"]["secondary"] = []
    for line in doc["narrative_lines"]:
        if line.get("type") == "relationship":
            line["type"] = "subplot"
    retarget(doc, {"资源": "共同目标", "声誉": "失去风险", "关系": "信任交换"}, drop_axes={"信任交换"})


def case_prog01_same(doc: dict) -> None:
    doc["genre_profile"]["primary"] = "progression"
    doc["genre_profile"]["secondary"] = []
    retarget(doc, {"资源": "资源", "声誉": "代价", "关系": "战术"})
    ladder = doc["story_engine"]["escalation_ladder"]
    ladder[0]["axis_refs"] = ["资源"]
    ladder[1]["axis_refs"] = ["资源"]


def case_prog01_missing(doc: dict) -> None:
    doc["genre_profile"]["primary"] = "progression"
    doc["genre_profile"]["secondary"] = []
    retarget(doc, {"资源": "资源", "声誉": "代价", "关系": "战术"})
    doc["story_engine"]["escalation_ladder"][1].pop("axis_refs", None)


def case_fant01(doc: dict) -> None:
    doc["genre_profile"]["primary"] = "fantasy"
    doc["genre_profile"]["secondary"] = []
    retarget(doc, {"资源": "资源", "声誉": "身份", "关系": "阵营"}, drop_axes={"阵营"})


def case_strip_axis(doc: dict) -> None:
    for chapter in doc["chapters"]:
        chapter["axis_advance"] = []


def case_downgrade_12(doc: dict) -> None:
    doc["contract_version"] = "1.2"
    doc.pop("commercial_profile", None)
    doc.pop("entity_ledger", None)
    for chapter in doc["chapters"]:
        chapter.pop("axis_advance", None)
        reason = chapter.get("continue_reason")
        if isinstance(reason, dict):
            chapter["continue_reason"] = reason.get("text", "承接上一章")


def case_roma_a1(doc: dict) -> None:
    doc["genre_profile"]["primary"] = "romance"
    doc["genre_profile"]["secondary"] = []
    retarget(doc, {"资源": "共同目标", "声誉": "失去风险", "关系": "信任交换"})
    for chapter in doc["chapters"]:
        for entry in chapter["axis_advance"]:
            if entry["axis"] == "信任交换":
                entry.pop("cost_paid", None)
    doc["chapters"][2]["axis_advance"].append({"axis": "信任交换", "change": "第三阶段：旧账摊牌后的信任赤字继续扩大"})


def case_scif_a1(doc: dict) -> None:
    doc["genre_profile"]["primary"] = "science_fiction"
    doc["genre_profile"]["secondary"] = []
    retarget(doc, {"资源": "资源", "声誉": "伦理", "关系": "风险"})


CASES: list[tuple[str, Path, Callable[[dict], None], str, str]] = [
    # (名称, 基底, 变异, 判定类型, 关键词/规则ID)
    ("基线：悬疑示例应 VALID", MYSTERY, lambda doc: None, "valid", ""),
    ("基线：都市示例应 VALID", URBAN, lambda doc: None, "valid", ""),
    ("MYST-01 P0伏笔无物证/信息被拒", MYSTERY, case_myst01, "block", "MYST-01"),
    ("MYST-02 全卷无advance/hint被拒", MYSTERY, case_myst02, "block", "MYST-02"),
    ("MYST-03 reap章无证据被拒", MYSTERY, case_myst03, "block", "MYST-03"),
    ("词表外轴名被拒", MYSTERY, case_vocab, "block", "不在题材词表中"),
    ("休整章delivers不兑现must_deliver被拒", MYSTERY, case_rest, "block", "休整章 delivers"),
    ("evidence引用不存在章节被拒", MYSTERY, case_evidence, "block", "不存在的章节"),
    ("ROMA-01 无关系线且无关系轴被拒", URBAN, case_roma01, "block", "ROMA-01"),
    ("PROG-01 升梯相邻步骤轴相同被拒", URBAN, case_prog01_same, "block", "PROG-01"),
    ("PROG-01 升梯步骤缺axis_refs被拒", URBAN, case_prog01_missing, "block", "PROG-01"),
    ("FANT-01 全卷无带代价世界规则/阵营轴被拒", URBAN, case_fant01, "block", "FANT-01"),
    ("1.3删空axis_advance被拒", URBAN, case_strip_axis, "block", "needs at least one entry"),
    ("1.2旧大纲降级后仍 VALID（兼容回归）", URBAN, case_downgrade_12, "valid", ""),
    ("ROMA-A1 无代价推进仅告警不拒绝", URBAN, case_roma_a1, "warn", "ROMA-A1"),
    ("SCIF-A1 只换名词冲突仅告警不拒绝", URBAN, case_scif_a1, "warn", "SCIF-A1"),
]


def main() -> int:
    outlines: dict[Path, dict[str, Any]] = {}
    results: list[tuple[str, bool]] = []
    with tempfile.TemporaryDirectory(prefix="adversarial-test-") as directory:
        work = Path(directory)
        for name, base_path, mutate, kind, keyword in CASES:
            if base_path not in outlines:
                outlines[base_path] = json.loads(base_path.read_text(encoding="utf-8"))
            doc = copy.deepcopy(outlines[base_path])
            mutate(doc)
            result = validate(doc, work)
            if kind == "block":
                hit = blocked(result, keyword)
            elif kind == "warn":
                hit = warned(result, keyword)
            else:
                hit = valid(result)
            results.append((name, hit))
    passed = sum(hit for _, hit in results)
    for name, hit in results:
        print(f"[{'PASS' if hit else 'FAIL'}] {name}")
    print(f"\n{passed}/{len(results)} adversarial cases correct")
    return 0 if passed == len(results) else 1


if __name__ == "__main__":
    raise SystemExit(main())

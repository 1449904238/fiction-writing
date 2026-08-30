#!/usr/bin/env python3
"""Adversarial tests for the commercial layer: evidence_source existence + hook assertions."""

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
VALIDATOR = ROOT / "scripts" / "validate_outline.py"
OUTLINE = ROOT / "examples" / "standalone_batch_danganyujin.json"
HIGH_PULL = {"危机", "悬念", "反转"}


def validate(doc: dict, directory: Path) -> subprocess.CompletedProcess[str]:
    path = directory / "case.json"
    path.write_text(json.dumps(doc, ensure_ascii=False), encoding="utf-8")
    return subprocess.run(
        [sys.executable, str(VALIDATOR), str(path)],
        capture_output=True, text=True, encoding="utf-8", errors="replace",
    )


def check(result: subprocess.CompletedProcess[str], expect_valid: bool, keyword: str = "") -> bool:
    output = result.stdout + result.stderr
    ok = (result.returncode == 0) == expect_valid and (not keyword or keyword in output)
    return ok


def main() -> int:
    base = json.loads(OUTLINE.read_text(encoding="utf-8"))
    results: list[tuple[str, bool]] = []

    with tempfile.TemporaryDirectory(prefix="commercial-test-") as directory:
        work = Path(directory)
        benchmark_file = work / "对标节奏包.json"
        benchmark_file.write_text(json.dumps({"sample": "对标数据"}, ensure_ascii=False), encoding="utf-8")

        # 正例：真实对标文件 + 前三章高拉力钩子
        doc = copy.deepcopy(base)
        doc["commercial_profile"] = {
            "platform": "番茄小说",
            "evidence_source": str(benchmark_file),
            "assumption_flag": "benchmarked",
            "hook_policy": {"first_3_chapters": "all_high_pull"},
            "high_energy_gap_max": 3,
        }
        for index, chapter in enumerate(doc["chapters"]):
            chapter["continue_reason"] = {
                "hook_type": ["反转", "悬念", "危机"][index],
                "text": chapter["continue_reason"]["text"] if isinstance(chapter["continue_reason"], dict) else str(chapter["continue_reason"]),
            }
        result = validate(doc, work)
        results.append(("benchmarked 正例（真实文件+高拉力钩子）", check(result, True)))

        # 负例：虚构 evidence_source
        doc = copy.deepcopy(base)
        doc["commercial_profile"] = {
            "platform": "番茄小说",
            "evidence_source": str(work / "不存在的对标.json"),
            "assumption_flag": "benchmarked",
        }
        result = validate(doc, work)
        results.append(("虚构对标来源被拒绝", check(result, False, "禁止虚构对标来源")))

        # 负例：无来源也无 assumption_flag
        doc = copy.deepcopy(base)
        doc["commercial_profile"] = {"platform": "番茄小说"}
        result = validate(doc, work)
        results.append(("无来源无声明被拒绝", check(result, False, "editorial_assumption")))

        # 负例：导入对标后前三章出现低拉力钩子
        doc = copy.deepcopy(base)
        doc["commercial_profile"] = {
            "platform": "番茄小说",
            "evidence_source": str(benchmark_file),
            "hook_policy": {"first_3_chapters": "all_high_pull"},
        }
        for index, chapter in enumerate(doc["chapters"]):
            chapter["continue_reason"] = {
                "hook_type": ["情感", "悬念", "危机"][index],
                "text": "钩子文本",
            }
        result = validate(doc, work)
        results.append(("前三章低拉力钩子被拒绝", check(result, False, "高拉力")))

        # 负例：hook_type 非法枚举
        doc = copy.deepcopy(base)
        doc["commercial_profile"] = {"platform": "番茄小说", "assumption_flag": "editorial_assumption"}
        doc["chapters"][0]["continue_reason"] = {"hook_type": "爆点", "text": "非法枚举"}
        result = validate(doc, work)
        results.append(("非法 hook_type 枚举被拒绝", check(result, False, "hook_type is invalid")))

    passed = sum(hit for _, hit in results)
    for name, hit in results:
        print(f"[{'PASS' if hit else 'FAIL'}] {name}")
    print(f"\n{passed}/{len(results)} commercial cases correct")
    return 0 if passed == len(results) else 1


if __name__ == "__main__":
    raise SystemExit(main())

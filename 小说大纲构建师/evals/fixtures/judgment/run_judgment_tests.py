#!/usr/bin/env python3
"""End-to-end test for the judge protocol: warn -> receipt -> judgment -> verification."""

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
VERIFY = ROOT / "scripts" / "verify_judgment.py"
OUTLINE = ROOT / "examples" / "three_chapter_outline.json"


def run(command: list[str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(command, capture_output=True, text=True, encoding="utf-8", errors="replace")


def main() -> int:
    with tempfile.TemporaryDirectory(prefix="judge-test-") as directory:
        work = Path(directory)

        doc = json.loads(OUTLINE.read_text(encoding="utf-8"))
        doc["chapters"][0]["axis_advance"][0].pop("cost_paid", None)
        doc["chapters"][0]["axis_advance"][1].pop("cost_paid", None)
        outline_path = work / "01_大纲数据.json"
        outline_path.write_text(json.dumps(doc, ensure_ascii=False), encoding="utf-8")

        result = run([sys.executable, str(FINALIZER), str(outline_path), "--output-dir", str(work)])
        if result.returncode != 0:
            print("FINALIZE failed unexpectedly:")
            print(result.stdout or result.stderr)
            return 1
        receipt = json.loads((work / "03_审计回执.json").read_text(encoding="utf-8"))
        warns = receipt.get("warnings", [])
        if not any("cost_paid" in item for item in warns):
            print(f"FAIL: receipt should carry cost_paid warnings, got {warns}")
            return 1
        print(f"[PASS] 回执携带 {len(warns)} 条机检告警（含 cost_paid 嫌疑）")

        good = {
            "judgment_version": "1.0",
            "outline": str(outline_path),
            "receipt": str(work / "03_审计回执.json"),
            "reviewer": "agent-semantic-review",
            "verdicts": [
                {
                    "scope": "CH-0001",
                    "dimension": "causal_pressure",
                    "verdict": "fail",
                    "score": 2,
                    "evidence": [
                        {"anchor": "CH-0001#axis_advance[0]", "claim": "证据链推进未声明代价"}
                    ],
                    "note": "越权取底稿应有具体代价，缺 cost_paid 属实",
                },
                {
                    "scope": "V-01",
                    "dimension": "opponent_agency",
                    "verdict": "pass",
                    "score": 3,
                    "evidence": [
                        {"anchor": "V-01#opposition", "claim": "委员会手段具体且随主角行动升级"}
                    ],
                },
            ],
        }
        good_path = work / "04_语义评审.json"
        good_path.write_text(json.dumps(good, ensure_ascii=False), encoding="utf-8")
        result = run([sys.executable, str(VERIFY), str(good_path)])
        print(f"[{'PASS' if result.returncode == 0 else 'FAIL'}] 正例判断：{result.stdout.strip().splitlines()[0]}")
        good_ok = result.returncode == 0

        bad = copy.deepcopy(good)
        bad["verdicts"][0]["evidence"][0]["anchor"] = "CH-0009#gocs[0].state_change"
        bad["verdicts"].append({
            "target": "MYST-A9",
            "scope": "CH-0002",
            "verdict": "confirmed",
            "evidence": [{"anchor": "CH-0002#gocs[0]", "claim": "虚构的机检对象"}],
        })
        bad["verdicts"].append({
            "scope": "V-01",
            "dimension": "causal_pressure",
            "verdict": "pass",
            "score": 9,
            "evidence": [{"anchor": "V-01#goal", "claim": "越界分数"}],
        })
        bad_path = work / "04_语义评审_bad.json"
        bad_path.write_text(json.dumps(bad, ensure_ascii=False), encoding="utf-8")
        result = run([sys.executable, str(VERIFY), str(bad_path)])
        output = result.stdout
        checks = [
            ("幻觉章节引用", "不存在于大纲" in output),
            ("虚构机检对象", "未出现在审计回执" in output),
            ("越界分数", "score 必须是 0-4" in output),
        ]
        bad_ok = result.returncode != 0 and all(hit for _, hit in checks)
        for name, hit in checks:
            print(f"[{'PASS' if hit else 'FAIL'}] 负例-{name}")
        print(f"[{'PASS' if bad_ok else 'FAIL'}] 负例判断整体被拒绝")
        return 0 if good_ok and bad_ok else 1


if __name__ == "__main__":
    raise SystemExit(main())

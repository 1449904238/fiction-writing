#!/usr/bin/env python3
"""Run deterministic outline contract/handoff checks over a case directory."""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
import tempfile
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")


ROOT = Path(__file__).resolve().parents[1]
VALIDATOR = ROOT / "scripts" / "validate_outline.py"
PROJECTOR = ROOT / "scripts" / "project_outline.py"
FINALIZER = ROOT / "scripts" / "finalize_outline.py"


def run_case(path: Path) -> dict[str, object]:
    validation = subprocess.run([sys.executable, str(VALIDATOR), str(path)], capture_output=True, text=True, encoding="utf-8", errors="replace")
    result: dict[str, object] = {
        "case": str(path),
        "R_schema": validation.returncode == 0,
        "R_semantic": validation.returncode == 0,
        "R_input": "unmeasured",
        "R_quality": "unmeasured",
        "R_total": "unmeasured",
        "validator_output": validation.stdout.strip() or validation.stderr.strip(),
    }
    if validation.returncode != 0:
        result["R_handoff"] = False
        return result
    with tempfile.TemporaryDirectory(prefix="outline-eval-") as directory:
        json_out = Path(directory) / "handoff.json"
        md_out = Path(directory) / "handoff.md"
        projection = subprocess.run(
            [sys.executable, str(PROJECTOR), str(path), "--json-out", str(json_out), "--md-out", str(md_out)],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
        )
        handoff_ok = projection.returncode == 0 and json_out.exists() and md_out.exists()
        if handoff_ok:
            handoff = json.loads(json_out.read_text(encoding="utf-8"))
            plans = handoff.get("chapter_plan", [])
            required = {"user_emotion_anchor", "scene_effect_target", "narrative_line_ids", "line_intersection", "branch_deduction", "foreshadowing_ops", "unresolved_pull"}
            handoff_ok = all(required.issubset(plan) for plan in plans)
        result["R_handoff"] = handoff_ok
        result["projector_output"] = projection.stdout.strip() or projection.stderr.strip()
        receipt_dir = Path(directory) / "finalized"
        finalization = subprocess.run(
            [sys.executable, str(FINALIZER), str(path), "--output-dir", str(receipt_dir)],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
        )
        receipt_path = receipt_dir / "03_审计回执.json"
        ledger_path = receipt_dir / "03_连续性账本.json"
        receipt_ok = finalization.returncode == 0 and receipt_path.exists() and ledger_path.exists()
        if receipt_ok:
            receipt = json.loads(receipt_path.read_text(encoding="utf-8"))
            receipt_ok = receipt.get("status") == "passed" and receipt.get("gates", {}).get("continuity_ledger") == "written"
        result["R_gate"] = receipt_ok
        result["finalizer_output"] = finalization.stdout.strip() or finalization.stderr.strip()
    return result


def run_suite(label: str, command: list[str]) -> tuple[str, bool]:
    result = subprocess.run(command, capture_output=True, text=True, encoding="utf-8", errors="replace")
    output = (result.stdout + result.stderr).strip()
    print(f"--- {label} ---")
    if output:
        print(output)
    return label, result.returncode == 0


def run_self_test() -> int:
    """Run every adversarial fixture suite plus the cross-batch positive chain."""
    fixtures = ROOT / "evals" / "fixtures"
    batch1 = fixtures / "cross_batch" / "batch1_output"
    batch2 = fixtures / "cross_batch" / "batch2_output"
    if not (batch1 / "03_连续性账本.json").exists():
        batch1.mkdir(parents=True, exist_ok=True)
        first = subprocess.run(
            [sys.executable, str(FINALIZER), str(ROOT / "examples" / "standalone_batch_danganyujin.json"), "--output-dir", str(batch1)],
            capture_output=True, text=True, encoding="utf-8", errors="replace",
        )
        if first.returncode != 0:
            print(first.stdout + first.stderr)
            print("SELF-TEST FAILED: cannot build batch1 ledger")
            return 1
    results = [
        run_suite("adversarial（题材契约 block/warn 分级 + 1.2 兼容）", [sys.executable, str(fixtures / "adversarial" / "run_adversarial_tests.py")]),
        run_suite("commercial（商业层机检）", [sys.executable, str(fixtures / "commercial" / "run_commercial_tests.py")]),
        run_suite("judgment（语义评审证据核验）", [sys.executable, str(fixtures / "judgment" / "run_judgment_tests.py")]),
        run_suite("cross-batch negatives（跨批负例拦截）", [sys.executable, str(fixtures / "cross_batch" / "run_negative_cases.py"), str(batch1)]),
        run_suite("cross-batch positive chain（跨批正例：批2带 --previous 通过）", [sys.executable, str(FINALIZER), str(fixtures / "cross_batch" / "dangan_yujin_batch2.json"), "--previous", str(batch1), "--output-dir", str(batch2)]),
    ]
    failed = [label for label, ok in results if not ok]
    print(f"\nSELF-TEST {'PASSED' if not failed else 'FAILED'}: {sum(ok for _, ok in results)}/{len(results)} suites")
    if failed:
        for label in failed:
            print(f"- failed: {label}")
    return 0 if not failed else 1


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("cases", type=Path, nargs="?", help="directory containing *.json outline cases")
    parser.add_argument("--report", type=Path, help="optional JSON report output")
    parser.add_argument("--self-test", action="store_true", help="run adversarial fixture suites (adversarial/commercial/judgment/cross-batch) instead of case evaluation")
    args = parser.parse_args()
    if args.self_test:
        return run_self_test()
    if args.cases is None:
        parser.error("cases is required unless --self-test is given")
    cases = sorted(
        path
        for path in args.cases.glob("*.json")
        # 01_ 是规范大纲文件；02_/03_ 是派生产物（交接/审计回执/账本），不作为评测样本。
        if not path.name.startswith(("02_", "03_")) and path.name != "handoff.json"
    )
    if not cases:
        print(f"NO CASES: {args.cases}")
        return 2
    results = [run_case(case) for case in cases]
    e2e_passed = sum(bool(result.get("R_schema") and result.get("R_semantic") and result.get("R_handoff") and result.get("R_gate")) for result in results)
    report = {
        "cases": len(results),
        "e2e_passed": e2e_passed,
        "e2e_pass_rate": round(e2e_passed / len(results), 3),
        "results": results,
        "note": "E2E pass rate is deterministic gate compliance. R_input/R_quality require independent review; R_total remains unmeasured until supplied."
    }
    rendered = json.dumps(report, ensure_ascii=False, indent=2)
    if args.report:
        args.report.write_text(rendered + "\n", encoding="utf-8")
    print(rendered)
    return 0 if all(result.get("R_schema") and result.get("R_handoff") and result.get("R_gate") for result in results) else 1


if __name__ == "__main__":
    raise SystemExit(main())

#!/usr/bin/env python3
"""Run every deterministic outline gate and emit the handoff receipt."""

from __future__ import annotations

import argparse
import hashlib
import json
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")


ROOT = Path(__file__).resolve().parents[1]
VALIDATOR = ROOT / "scripts" / "validate_outline.py"
PROJECTOR = ROOT / "scripts" / "project_outline.py"


def write_json(path: Path, value: Any) -> None:
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def build_ledger(root: dict[str, Any]) -> dict[str, Any]:
    chapters = sorted(root.get("chapters", []), key=lambda item: item.get("number", 0))
    threads = {item.get("id"): item for item in root.get("story_threads", [])}
    history: dict[str, list[dict[str, Any]]] = {thread_id: [] for thread_id in threads}
    active: set[str] = set()
    chapter_records: list[dict[str, Any]] = []
    for chapter in chapters:
        delta = chapter.get("state_delta", {})
        events = []
        for operation in chapter.get("thread_ops", []):
            thread_id = operation.get("id")
            action = operation.get("action")
            event = {
                "chapter_id": chapter.get("id"),
                "chapter": chapter.get("number"),
                "action": action,
                "effect": operation.get("effect"),
            }
            history.setdefault(thread_id, []).append(event)
            events.append({"thread_id": thread_id, **event})
            if action == "open":
                active.add(thread_id)
            elif action in {"close", "abandon"}:
                active.discard(thread_id)
        chapter_records.append({
            "chapter_id": chapter.get("id"),
            "chapter": chapter.get("number"),
            "volume_id": chapter.get("volume_id"),
            "entry_state": delta.get("entry_state", []),
            "trigger": delta.get("trigger"),
            "choice": delta.get("choice"),
            "cost": delta.get("cost"),
            "changed_state": delta.get("changed_state", []),
            "new_obligations": delta.get("new_obligations", []),
            "continuity_break": delta.get("continuity_break", False),
            "continuity_note": delta.get("continuity_note", ""),
            "unresolved_pull": delta.get("unresolved_pull"),
            "thread_events": events,
            "active_threads_after": sorted(active),
        })
    entity_terminal: list[dict[str, Any]] = []
    ledger_raw = root.get("entity_ledger")
    if isinstance(ledger_raw, dict):
        for entity in ledger_raw.get("entities", []):
            if not isinstance(entity, dict):
                continue
            facts = sorted(
                (fact for fact in entity.get("critical_facts", []) if isinstance(fact, dict)),
                key=lambda fact: fact.get("chapter", 0),
            )
            if facts and facts[-1].get("status") in {"dead", "destroyed"}:
                entity_terminal.append({
                    "name": entity.get("name"),
                    "status": facts[-1].get("status"),
                    "chapter": facts[-1].get("chapter"),
                })
    foreshadowing_snapshot = {
        item.get("id"): item.get("status")
        for item in root.get("foreshadowing", [])
        if isinstance(item, dict)
    }
    return {
        "ledger_version": "1.1",
        "contract_version": root.get("contract_version"),
        "source_revision": root.get("source_revision"),
        "outline_scope": root.get("outline_scope"),
        "last_chapter_number": chapters[-1].get("number") if chapters else None,
        "open_threads": sorted(active),
        "foreshadowing_snapshot": foreshadowing_snapshot,
        "entity_terminal": entity_terminal,
        "chapters": chapter_records,
        "story_threads": [
            {"definition": threads[thread_id], "history": history.get(thread_id, [])}
            for thread_id in sorted(threads)
        ],
    }


def load_previous_ledger(path: Path) -> dict[str, Any]:
    resolved = path.resolve()
    if resolved.is_dir():
        resolved = resolved / "03_连续性账本.json"
    return json.loads(resolved.read_text(encoding="utf-8"))


def is_flashback(chapter: dict[str, Any]) -> bool:
    if chapter.get("flashback") is True:
        return True
    return any(isinstance(goc, dict) and goc.get("mode") == "flashback" for goc in chapter.get("gocs", []))


def cross_batch_check(root: dict[str, Any], previous: dict[str, Any]) -> tuple[list[str], list[str]]:
    errors: list[str] = []
    warnings: list[str] = []
    if "ledger_version" not in previous:
        warnings.append("跨批核验：上一批账本版本过旧（无跨批快照字段），跳过全部跨批断言")
        return errors, warnings

    current_version = root.get("contract_version")
    previous_version = previous.get("contract_version")
    if previous_version == "1.3" and current_version == "1.2":
        errors.append("跨批核验：上一批为 contract 1.3，本批不允许降级回 1.2（规避新断言）；请将本批升级为 1.3")
        return errors, warnings
    if previous_version == "1.2" and current_version == "1.3":
        warnings.append("跨批核验：上一批为 1.2（无实体账本快照），仅执行基础衔接核验，实体终态承接不可用")

    chapters = sorted(root.get("chapters", []), key=lambda item: item.get("number", 0))
    numbers = [chapter.get("number") for chapter in chapters if isinstance(chapter.get("number"), int)]
    last_number = previous.get("last_chapter_number")
    current_offset = root.get("chapter_offset", 0)
    if isinstance(last_number, int) and numbers:
        if current_offset < last_number:
            errors.append(
                f"跨批核验：本批 chapter_offset={current_offset}（起始章 {current_offset + 1}）与上一批结束章 {last_number} 重叠或回退"
            )
        elif current_offset > last_number:
            warnings.append(f"跨批核验：本批起始章 {current_offset + 1} 与上一批结束章 {last_number} 之间存在跳章")

    previous_threads = {
        item.get("definition", {}).get("id")
        for item in previous.get("story_threads", [])
        if isinstance(item, dict) and isinstance(item.get("definition"), dict)
    }
    previous_threads.discard(None)
    open_threads: set[str] = set(previous.get("open_threads") or [])
    snapshot: dict[str, Any] = previous.get("foreshadowing_snapshot") or {}
    inherited_raw = root.get("inherited") if isinstance(root.get("inherited"), dict) else {}
    for thread_id in inherited_raw.get("threads", []):
        if thread_id not in previous_threads:
            errors.append(f"跨批核验：inherited.threads 承接的线程 {thread_id} 不存在于上一批账本")
        elif thread_id not in open_threads:
            errors.append(f"跨批核验：inherited.threads 承接的线程 {thread_id} 在上一批已闭合，不能续写")
    for foreshadowing_id in inherited_raw.get("foreshadowing", []):
        state = snapshot.get(foreshadowing_id)
        if state is None:
            errors.append(f"跨批核验：inherited.foreshadowing 承接的伏笔 {foreshadowing_id} 不存在于上一批账本")
        elif state in {"REAP", "ARCHIVE"}:
            errors.append(f"跨批核验：inherited.foreshadowing 承接的伏笔 {foreshadowing_id} 已在上一批进入终态 {state}，不能续写")
    seen_open = set(open_threads)
    for chapter in chapters:
        for operation in chapter.get("thread_ops", []):
            thread_id = operation.get("id")
            action = operation.get("action")
            if action == "open":
                if thread_id in previous_threads:
                    errors.append(f"跨批核验：线程 {thread_id} 已在上一批登记，本批不能重复 open（续写请用 advance）")
                seen_open.add(thread_id)
            elif action in {"advance", "close", "abandon"}:
                if thread_id not in seen_open:
                    errors.append(f"跨批核验：线程 {thread_id} 在上一批结束时未开启，本批却执行 {action}")
                if action in {"close", "abandon"}:
                    seen_open.discard(thread_id)

    planted_here: set[str] = set()
    for chapter in chapters:
        for operation in chapter.get("foreshadowing_ops", []):
            foreshadowing_id = operation.get("id")
            action = operation.get("action")
            if action == "plant":
                if foreshadowing_id in snapshot:
                    errors.append(
                        f"跨批核验：伏笔 {foreshadowing_id} 已在上一批登记（状态 {snapshot.get(foreshadowing_id)}），本批不能重复 plant"
                    )
                planted_here.add(foreshadowing_id)
            else:
                if foreshadowing_id not in snapshot and foreshadowing_id not in planted_here:
                    errors.append(f"跨批核验：伏笔 {foreshadowing_id} 未在上一批登记也未在本批 plant，却执行 {action}")
                elif snapshot.get(foreshadowing_id) in {"REAP", "ARCHIVE"}:
                    errors.append(
                        f"跨批核验：伏笔 {foreshadowing_id} 已在上一批进入终态 {snapshot.get(foreshadowing_id)}，本批不能继续操作"
                    )

    if previous_version == "1.3" and current_version == "1.3":
        for entity in previous.get("entity_terminal") or []:
            name = entity.get("name")
            if not isinstance(name, str) or not name:
                continue
            for chapter in chapters:
                if is_flashback(chapter):
                    continue
                delta = chapter.get("state_delta") if isinstance(chapter.get("state_delta"), dict) else {}
                participatory = [str(value) for value in delta.get("changed_state", []) if isinstance(value, str)]
                participatory += [
                    str(goc.get("choice"))
                    for goc in chapter.get("gocs", [])
                    if isinstance(goc, dict) and isinstance(goc.get("choice"), str)
                ]
                if any(name in text for text in participatory):
                    errors.append(
                        f"跨批核验：实体「{name}」在上一批第 {entity.get('chapter')} 章后已 {entity.get('status')}，"
                        f"本批第 {chapter.get('number')} 章仍作为参与者出现（回忆性内容请标记 flashback）"
                    )
    return errors, warnings


def run(command: list[str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(command, capture_output=True, text=True, encoding="utf-8", errors="replace")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("outline", type=Path, help="path to 01_大纲数据.json")
    parser.add_argument("--setting-package", type=Path, help="manifest path or setting package directory")
    parser.add_argument("--previous", type=Path, help="previous batch output dir or its 03_连续性账本.json；启用跨批核验（章节衔接/线程承接/伏笔终态/实体终态）")
    parser.add_argument("--output-dir", type=Path, help="directory for derived handoff, ledger and receipt")
    parser.add_argument("--skip-handoff", action="store_true", help="本 skill 只交付大纲：跳过 02_细纲交接 投影（细纲交接属下游细纲构建的消费格式，不归本 skill 产出）。仍会写入 03_审计回执 与 03_连续性账本（质量凭证 + 跨批核验依赖，不削弱大纲质量机制）")
    args = parser.parse_args()

    outline = args.outline.resolve()
    output_dir = (args.output_dir or outline.parent).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    root = json.loads(outline.read_text(encoding="utf-8"))
    validator_command = [sys.executable, str(VALIDATOR), str(outline)]
    if args.setting_package:
        validator_command.extend(["--setting-package", str(args.setting_package.resolve())])
    validation = run(validator_command)
    if validation.returncode != 0:
        print(validation.stdout or validation.stderr, end="")
        print("FINALIZE BLOCKED: validation failed")
        return validation.returncode or 1
    validator_warnings = [
        line[len("WARN: "):].strip()
        for line in (validation.stdout or "").splitlines()
        if line.startswith("WARN: ")
    ]

    cross_gate = "skipped"
    cross_warnings: list[str] = []
    if args.previous:
        try:
            previous = load_previous_ledger(args.previous)
        except (OSError, json.JSONDecodeError) as exc:
            print(f"FINALIZE BLOCKED: cannot read previous ledger from {args.previous}: {exc}")
            return 1
        cross_errors, cross_warnings = cross_batch_check(root, previous)
        if cross_errors:
            for message in cross_errors:
                print(f"- {message}")
            print("FINALIZE BLOCKED: cross-batch check failed")
            return 1
        cross_gate = "passed"

    json_out = output_dir / "02_细纲交接.json"
    md_out = output_dir / "02_细纲交接.md"
    artifacts: dict[str, Any] = {}
    if args.skip_handoff:
        projector_gate = "skipped"
    else:
        projection = run([
            sys.executable,
            str(PROJECTOR),
            str(outline),
            "--json-out",
            str(json_out),
            "--md-out",
            str(md_out),
        ])
        if projection.returncode != 0 or not json_out.exists() or not md_out.exists():
            print(projection.stdout or projection.stderr, end="")
            print("FINALIZE BLOCKED: projection failed")
            return projection.returncode or 1
        projector_gate = "passed"
        artifacts["handoff_json"] = {"path": str(json_out), "sha256": sha256(json_out)}
        artifacts["handoff_markdown"] = {"path": str(md_out), "sha256": sha256(md_out)}

    ledger_path = output_dir / "03_连续性账本.json"
    receipt_path = output_dir / "03_审计回执.json"
    write_json(ledger_path, build_ledger(root))
    artifacts["continuity_ledger"] = {"path": str(ledger_path), "sha256": sha256(ledger_path)}
    receipt = {
        "receipt_version": "1.1",
        "status": "passed",
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "source_outline": str(outline),
        "contract_version": root.get("contract_version"),
        "source_revision": root.get("source_revision"),
        "outline_scope": root.get("outline_scope"),
        "chapter_count": len(root.get("chapters", [])),
        "gates": {"validator": "passed", "projector": projector_gate, "continuity_ledger": "written", "cross_batch": cross_gate},
        "warnings": validator_warnings,
        "cross_batch_warnings": cross_warnings,
        "artifacts": artifacts,
    }
    write_json(receipt_path, receipt)
    print("FINALIZE PASSED")
    for message in validator_warnings:
        print(f"WARN: {message}")
    for message in cross_warnings:
        print(f"WARN: {message}")
    print(f"receipt: {receipt_path}")
    print(f"ledger: {ledger_path}")
    if not args.skip_handoff:
        print(f"handoff: {json_out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

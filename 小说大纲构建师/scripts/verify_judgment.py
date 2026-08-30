#!/usr/bin/env python3
"""Verify that a semantic-review judgment file only cites evidence that truly exists."""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path
from typing import Any

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

ROOT_DIR = Path(__file__).resolve().parents[1]
RUBRIC_PATH = ROOT_DIR / "evals" / "quality_rubric.json"

VERDICTS = {"confirmed", "false_positive", "pass", "fail"}
ANCHOR_RE = re.compile(r"^(CH-\d{4}|V-\d{2})((?:#[^\s]+)?)$")
PATH_TOKEN_RE = re.compile(r"[^.\[\]]+|\[\d+\]")


def error(errors: list[str], message: str) -> None:
    errors.append(message)


def resolve_path(value: Any, path: str) -> tuple[bool, Any]:
    for token in PATH_TOKEN_RE.findall(path):
        if token.startswith("["):
            index = int(token[1:-1])
            if not isinstance(value, list) or index >= len(value):
                return False, None
            value = value[index]
        else:
            if not isinstance(value, dict) or token not in value:
                return False, None
            value = value[token]
    return True, value


def load_rubric() -> set[str]:
    try:
        rubric = json.loads(RUBRIC_PATH.read_text(encoding="utf-8"))
        return {item.get("id") for item in rubric.get("dimensions", []) if isinstance(item, dict)}
    except (OSError, json.JSONDecodeError):
        return set()


def receipt_warn_ids(receipt_path: Path | None, errors: list[str]) -> set[str] | None:
    if receipt_path is None:
        return None
    try:
        receipt = json.loads(receipt_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        error(errors, f"receipt 无法读取：{exc}")
        return None
    warns = receipt.get("warnings") or receipt.get("cross_batch_warnings") or []
    if not isinstance(warns, list):
        return set()
    found = set()
    for item in warns:
        text = item if isinstance(item, str) else json.dumps(item, ensure_ascii=False)
        found.update(re.findall(r"\b[A-Z]{4}-A?\d+\b", text))
    return found


def main(filename: str) -> int:
    errors: list[str] = []
    try:
        judgment = json.loads(Path(filename).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        print(f"INVALID JUDGMENT: cannot read {filename}: {exc}")
        return 1
    if not isinstance(judgment, dict):
        print("INVALID JUDGMENT: root must be an object")
        return 1

    for field in ("judgment_version", "outline", "reviewer", "verdicts"):
        if not judgment.get(field):
            error(errors, f"root.{field} is required")
    if judgment.get("judgment_version") != "1.0":
        error(errors, "root.judgment_version must be 1.0")

    outline_path = Path(judgment.get("outline", ""))
    try:
        outline = json.loads(outline_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        error(errors, f"outline 无法读取（{judgment.get('outline')}）：{exc}")
        outline = None

    chapters: dict[str, Any] = {}
    volumes: dict[str, Any] = {}
    if isinstance(outline, dict):
        for chapter in outline.get("chapters", []):
            if isinstance(chapter, dict) and chapter.get("id"):
                chapters[chapter["id"]] = chapter
        for volume in outline.get("volumes", []):
            if isinstance(volume, dict) and volume.get("id"):
                volumes[volume["id"]] = volume

    receipt_path = Path(judgment["receipt"]) if judgment.get("receipt") else None
    known_warn_ids = receipt_warn_ids(receipt_path, errors)

    rubric_ids = load_rubric()
    verdicts = judgment.get("verdicts")
    if not isinstance(verdicts, list) or not verdicts:
        error(errors, "root.verdicts needs at least one entry")
        verdicts = []

    for index, raw in enumerate(verdicts):
        label = f"verdicts[{index}]"
        if not isinstance(raw, dict):
            error(errors, f"{label} must be an object")
            continue
        verdict = raw.get("verdict")
        if verdict not in VERDICTS:
            error(errors, f"{label}.verdict is invalid（confirmed/false_positive/pass/fail）")
        scope = raw.get("scope")
        if scope in {None, "outline"}:
            pass
        elif scope in chapters or scope in volumes:
            pass
        else:
            error(errors, f"{label}.scope「{scope}」不是本大纲中的章节/卷 ID，也不是 outline")
        target = raw.get("target")
        if target is not None:
            if receipt_path is None:
                error(errors, f"{label} 提供 target 时必须同时提供 receipt 路径")
            elif known_warn_ids is not None and target not in known_warn_ids:
                error(errors, f"{label}.target「{target}」未出现在审计回执的告警中（禁止评审虚构机检对象）")
        dimension = raw.get("dimension")
        if dimension is not None:
            if rubric_ids and dimension not in rubric_ids:
                error(errors, f"{label}.dimension「{dimension}」不在 quality_rubric.json 的维度中")
            score = raw.get("score")
            if not isinstance(score, int) or not 0 <= score <= 4:
                error(errors, f"{label}.score 必须是 0-4 整数（提供 dimension 时必填）")
        elif raw.get("score") is not None:
            error(errors, f"{label}.score 只能与 dimension 一起提供")
        evidence = raw.get("evidence")
        if not isinstance(evidence, list) or not evidence:
            error(errors, f"{label}.evidence 至少需要 1 条（没有 anchor 的结论不可核验）")
            continue
        for ev_index, raw_evidence in enumerate(evidence):
            ev_label = f"{label}.evidence[{ev_index}]"
            if not isinstance(raw_evidence, dict):
                error(errors, f"{ev_label} must be an object")
                continue
            anchor = raw_evidence.get("anchor")
            claim = raw_evidence.get("claim")
            if not isinstance(claim, str) or not claim.strip():
                error(errors, f"{ev_label}.claim is required")
            if not isinstance(anchor, str):
                error(errors, f"{ev_label}.anchor is required")
                continue
            match = ANCHOR_RE.match(anchor)
            if not match:
                error(errors, f"{ev_label}.anchor「{anchor}」格式非法（应为 CH-0004#gocs[0].state_change 或 V-01#cost）")
                continue
            object_id, path = match.group(1), match.group(2).lstrip("#")
            container = chapters.get(object_id) or volumes.get(object_id)
            if container is None:
                error(errors, f"{ev_label}.anchor 引用的对象 {object_id} 不存在于大纲")
                continue
            if path:
                resolved, value = resolve_path(container, path)
                if not resolved:
                    error(errors, f"{ev_label}.anchor 的字段路径 {path} 无法在 {object_id} 中解析（幻觉引用）")
                elif value is None or value == "" or value == []:
                    error(errors, f"{ev_label}.anchor 指向 {object_id}#{path} 的值为空")

    if errors:
        print("INVALID JUDGMENT")
        for item in errors:
            print(f"- {item}")
        return 1
    print(f"VERIFIED JUDGMENT（{len(verdicts)} 条结论的证据锚点全部真实存在）")
    return 0


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print("Usage: verify_judgment.py PATH_TO_04_语义评审.json")
        raise SystemExit(2)
    raise SystemExit(main(sys.argv[1]))

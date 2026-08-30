#!/usr/bin/env python3
"""Project canonical outline JSON into the legacy 02 handoff shape."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")


def load(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError("outline root must be an object")
    return value


def primary_line(chapter: dict[str, Any]) -> str | None:
    weights = chapter.get("line_weights")
    if isinstance(weights, dict) and weights:
        return max(weights, key=lambda key: (float(weights.get(key, 0)), key))
    lines = chapter.get("narrative_line_ids", [])
    return lines[0] if lines else None


def continuous_count(chapters: list[dict[str, Any]], index: int, line_id: str | None) -> int:
    if not line_id:
        return 0
    count = 0
    for item in reversed(chapters[: index + 1]):
        if primary_line(item) != line_id:
            break
        count += 1
    return count


def continue_reason_text(reason: Any) -> str:
    if isinstance(reason, dict):
        return str(reason.get("text", ""))
    return reason if isinstance(reason, str) else ""


def project(root: dict[str, Any]) -> dict[str, Any]:
    chapters = sorted(root.get("chapters", []), key=lambda item: item.get("number", 0))
    branches = root.get("branch_nodes", [])
    branch_by_chapter: dict[str, list[dict[str, Any]]] = {}
    for branch in branches:
        branch_by_chapter.setdefault(branch.get("chapter_id", ""), []).append(branch)

    chapter_plan: list[dict[str, Any]] = []
    for index, chapter in enumerate(chapters):
        line_ids = list(chapter.get("narrative_line_ids", []))
        primary = primary_line(chapter)
        intersection = chapter.get("line_intersection")
        if not isinstance(intersection, dict):
            intersection = {
                "is_intersection": len(line_ids) > 1,
                "line_ids": line_ids if len(line_ids) > 1 else [],
                "reason": "多线在同一章共同改变局势" if len(line_ids) > 1 else "",
            }
        selected_branches = []
        for branch in branch_by_chapter.get(chapter.get("id", ""), []):
            selected_branches.append({
                "id": branch.get("id"),
                "decision": branch.get("decision"),
                "beats": branch.get("selected", {}).get("beats", []),
                "selection_reason": branch.get("selection_reason"),
            })
        delta = chapter.get("state_delta") if isinstance(chapter.get("state_delta"), dict) else {}
        chapter_plan.append({
            "chapter": chapter.get("number"),
            "chapter_id": chapter.get("id"),
            "volume_id": chapter.get("volume_id"),
            "purpose": chapter.get("purpose"),
            "user_emotion_anchor": {
                "value": chapter.get("reader_emotion"),
                "emotion_source": chapter.get("emotion_source"),
                "rhythm_function": chapter.get("rhythm_function"),
            },
            "scene_effect_target": chapter.get("scene_effects", []),
            "narrative_line_primary": primary,
            "narrative_line_ids": line_ids,
            "line_weights": chapter.get("line_weights", {}),
            "continuous_line_count": continuous_count(chapters, index, primary),
            "line_intersection": intersection,
            "branch_deduction": selected_branches,
            "foreshadowing_ops": chapter.get("foreshadowing_ops", []),
            "gocs": chapter.get("gocs", []),
            "entry_state": delta.get("entry_state", []),
            "trigger": delta.get("trigger"),
            "choice": delta.get("choice"),
            "cost": delta.get("cost"),
            "changed_state": delta.get("changed_state", []),
            "new_obligations": delta.get("new_obligations", []),
            "continuity_break": delta.get("continuity_break", False),
            "continuity_note": delta.get("continuity_note", ""),
            "unresolved_pull": delta.get("unresolved_pull") or continue_reason_text(chapter.get("continue_reason")),
            "axis_advance": chapter.get("axis_advance", []),
            "continue_reason": chapter.get("continue_reason"),
            "thread_ops": chapter.get("thread_ops", []),
            "evidence_refs": chapter.get("evidence_refs", []),
        })
    return {
        "contract_version": root.get("contract_version"),
        "source_revision": root.get("source_revision"),
        "source_outline": "01_大纲数据.json",
        "genre_profile": root.get("genre_profile", {}),
        "story_threads": root.get("story_threads", []),
        "chapter_plan": chapter_plan,
    }


def markdown(projected: dict[str, Any]) -> str:
    lines = [
        "# 02 细纲交接",
        "",
        f"- contract_version: `{projected.get('contract_version')}`",
        f"- source_revision: `{projected.get('source_revision')}`",
        "- 机器字段来源：`01_大纲数据.json`（本文件为投影，不可反向修改）",
        "",
    ]
    for item in projected.get("chapter_plan", []):
        emotion = item.get("user_emotion_anchor", {})
        lines.extend([
            f"## 第{item.get('chapter')}章 · {item.get('chapter_id')}",
            f"- 卷：`{item.get('volume_id')}`",
            f"- 目标：{item.get('purpose')}",
            f"- 情绪锚点：{emotion.get('value')}（来源：{emotion.get('emotion_source')}；节奏：{emotion.get('rhythm_function')}）",
            f"- 主叙事线：`{item.get('narrative_line_primary')}`；连续计数：{item.get('continuous_line_count')}",
            f"- 叙事线：{', '.join(f'`{v}`' for v in item.get('narrative_line_ids', []))}",
            f"- 线权重：`{json.dumps(item.get('line_weights', {}), ensure_ascii=False)}`",
            f"- 交汇：`{json.dumps(item.get('line_intersection', {}), ensure_ascii=False)}`",
            f"- 场景效果：`{json.dumps(item.get('scene_effect_target', []), ensure_ascii=False)}`",
            f"- 分支推演：`{json.dumps(item.get('branch_deduction', []), ensure_ascii=False)}`",
            f"- 伏笔操作：`{json.dumps(item.get('foreshadowing_ops', []), ensure_ascii=False)}`",
            f"- 状态变化：触发={item.get('trigger')}；选择={item.get('choice')}；代价={item.get('cost')}",
            f"- 连续性账本：入口={json.dumps(item.get('entry_state', []), ensure_ascii=False)}；变化={json.dumps(item.get('changed_state', []), ensure_ascii=False)}；新义务={json.dumps(item.get('new_obligations', []), ensure_ascii=False)}",
            f"- 推进轴：`{json.dumps(item.get('axis_advance', []), ensure_ascii=False)}`",
            f"- 章末钩子：`{json.dumps(item.get('continue_reason'), ensure_ascii=False)}`",
            f"- 故事线操作：`{json.dumps(item.get('thread_ops', []), ensure_ascii=False)}`",
            f"- 未解决拉力：{item.get('unresolved_pull')}",
            "",
        ])
    return "\n".join(lines)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("outline", type=Path, help="path to 01_大纲数据.json")
    parser.add_argument("--json-out", type=Path, help="output handoff JSON")
    parser.add_argument("--md-out", type=Path, help="output handoff Markdown")
    args = parser.parse_args()
    projected = project(load(args.outline))
    json_out = args.json_out or args.outline.with_name("02_细纲交接.json")
    md_out = args.md_out or args.outline.with_name("02_细纲交接.md")
    json_out.write_text(json.dumps(projected, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    md_out.write_text(markdown(projected), encoding="utf-8")
    print(f"PROJECTED {len(projected['chapter_plan'])} chapters")
    print(json_out)
    print(md_out)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

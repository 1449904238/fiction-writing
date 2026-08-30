#!/usr/bin/env python3
"""Validate a canonical outline JSON asset without external dependencies."""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path
from typing import Any

ROOT_DIR = Path(__file__).resolve().parents[1]
GENRE_CONTRACTS_PATH = ROOT_DIR / "references" / "genre_contracts.json"

PLACEHOLDER = re.compile(r"(?:TODO|TBD|待定|待填写|\[.*?(?:填写|待定|TODO).*?\])", re.IGNORECASE)
PATTERNS = {
    "line": re.compile(r"^L-\d{3}$"),
    "volume": re.compile(r"^V-\d{2}$"),
    "chapter": re.compile(r"^CH-\d{4}$"),
    "foreshadowing": re.compile(r"^FS-\d{3}$"),
    "branch": re.compile(r"^BN-\d{2}-\d{2}$"),
    "thread": re.compile(r"^TH-\d{3}$"),
    "entity": re.compile(r"^ENT-\d{3}$"),
}
NUMBER_IN_TEXT = re.compile(r"\d+(?:\.\d+)?")
HOOK_ENUM = {"危机", "悬念", "反转", "期待", "情感", "兑现", "代价"}
HOOK_HIGH_PULL = {"危机", "悬念", "反转"}
ENTITY_TYPES = {"character", "item", "location", "faction", "concept"}
ENTITY_TERMINAL = {"dead", "destroyed"}
POWER_GENRES = {"progression", "fantasy", "science_fiction"}
POWER_AXES = {"能力边界", "对手强度"}


def error(errors: list[str], message: str) -> None:
    errors.append(message)


def warn(warnings: list[str], message: str) -> None:
    warnings.append(message)


def mapping(value: Any, label: str, errors: list[str]) -> dict[str, Any]:
    if not isinstance(value, dict):
        error(errors, f"{label} must be an object")
        return {}
    return value


def array(value: Any, label: str, errors: list[str]) -> list[Any]:
    if not isinstance(value, list):
        error(errors, f"{label} must be an array")
        return []
    return value


def fields(item: dict[str, Any], names: list[str], label: str, errors: list[str]) -> None:
    for name in names:
        value = item.get(name)
        if value is None or value == "":
            error(errors, f"{label}.{name} is required")
        elif isinstance(value, str) and PLACEHOLDER.search(value):
            error(errors, f"{label}.{name} contains a placeholder")


def ids(items: list[Any], label: str, pattern: re.Pattern[str], errors: list[str]) -> set[str]:
    result: set[str] = set()
    for index, raw in enumerate(items):
        item = mapping(raw, f"{label}[{index}]", errors)
        value = item.get("id")
        if not isinstance(value, str) or not pattern.match(value):
            error(errors, f"{label}[{index}].id has invalid format")
        elif value in result:
            error(errors, f"{label} has duplicate id {value}")
        else:
            result.add(value)
    return result


def load_genre_contracts(errors: list[str]) -> dict[str, Any] | None:
    try:
        contracts = json.loads(GENRE_CONTRACTS_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        error(errors, f"genre contracts cannot be read from {GENRE_CONTRACTS_PATH}: {exc}")
        return None
    if not isinstance(contracts, dict) or not isinstance(contracts.get("genres"), dict):
        error(errors, "genre contracts file is malformed")
        return None
    return contracts


def chapter_axis_entries(chapter: dict[str, Any]) -> list[dict[str, Any]]:
    entries = chapter.get("axis_advance")
    if not isinstance(entries, list):
        return []
    return [entry for entry in entries if isinstance(entry, dict)]


def volume_covered(item: dict[str, Any], numbers: set[int]) -> bool:
    start, end = item.get("chapter_start"), item.get("chapter_end")
    if not (isinstance(start, int) and isinstance(end, int)):
        return False
    return set(range(start, end + 1)) <= numbers


def is_flashback_chapter(chapter: dict[str, Any]) -> bool:
    if chapter.get("flashback") is True:
        return True
    return any(isinstance(goc, dict) and goc.get("mode") == "flashback" for goc in chapter.get("gocs", []))


def axis_vocab(root: dict[str, Any], contracts: dict[str, Any], warnings: list[str]) -> set[str]:
    genre_profile = root.get("genre_profile") if isinstance(root.get("genre_profile"), dict) else {}
    primary = genre_profile.get("primary")
    declared = [str(axis) for axis in genre_profile.get("progression_axes", []) if isinstance(axis, str)]
    genres: dict[str, Any] = contracts.get("genres", {})
    vocab: set[str] = set()
    if primary == "mixed":
        vocab |= set(declared)
    else:
        spec = genres.get(primary) or {}
        vocab |= set(spec.get("progression_axes_vocab") or [])
    for secondary in genre_profile.get("secondary", []):
        if isinstance(secondary, str) and secondary in genres:
            vocab |= set(genres[secondary].get("progression_axes_vocab") or [])
    vocab.add("休整")
    for axis in declared:
        if axis not in vocab:
            warn(warnings, f"genre_profile.progression_axes 声明了词表外轴「{axis}」；请对齐 genre_contracts.json 或在词表中扩展")
    return vocab


def check_axis_advance(
    chapters: list[dict[str, Any]],
    ordered: list[dict[str, Any]],
    vocab: set[str],
    must_deliver: list[str],
    chapter_ids: set[str],
    errors: list[str],
    warnings: list[str],
) -> None:
    for chapter in ordered:
        entries = chapter_axis_entries(chapter)
        label = f"chapters[{chapter.get('number')}]"
        if not entries:
            error(errors, f"{label}.axis_advance needs at least one entry（休整章用 axis=休整 + delivers 兑现 must_deliver）")
            continue
        for entry in entries:
            axis = entry.get("axis")
            if not isinstance(axis, str) or not axis.strip():
                error(errors, f"{label}.axis_advance.axis is required")
                continue
            if axis == "休整":
                if entry.get("delivers") not in must_deliver:
                    error(errors, f"{label} 休整章 delivers 必须逐字兑现一条 must_deliver（当前值不在清单中）")
                continue
            if axis not in vocab:
                error(errors, f"{label}.axis_advance.axis「{axis}」不在题材词表中")
                continue
            change = entry.get("change")
            if not isinstance(change, str) or not change.strip() or PLACEHOLDER.search(change):
                error(errors, f"{label} axis「{axis}」的 change is required")
            if not entry.get("cost_paid"):
                warn(warnings, f"{label} axis「{axis}」缺 cost_paid（无代价推进嫌疑，转语义评审抽查）")
            evidence = entry.get("evidence")
            if evidence is not None:
                if not isinstance(evidence, str) or "#" not in evidence:
                    error(errors, f"{label} axis「{axis}」的 evidence 必须形如 CH-0002#gocs[0].state_change")
                elif evidence.split("#", 1)[0] not in chapter_ids:
                    error(errors, f"{label} axis「{axis}」的 evidence 引用了不存在的章节 {evidence.split('#', 1)[0]}")


def consecutive_without_axis(ordered: list[dict[str, Any]], axes: set[str], span: int) -> list[Any]:
    hits: list[Any] = []
    run = 0
    for chapter in ordered:
        present = any(entry.get("axis") in axes for entry in chapter_axis_entries(chapter))
        run = 0 if present else run + 1
        if run == span:
            hits.append(chapter.get("number"))
    return hits


def check_genre_rules(
    root: dict[str, Any],
    contracts: dict[str, Any],
    ordered: list[dict[str, Any]],
    volumes: list[dict[str, Any]],
    numbers: set[int],
    foreshadowing: list[dict[str, Any]],
    foreshadowing_history: dict[str, list[tuple[int, int, str]]],
    narrative_lines: list[dict[str, Any]],
    branches: list[dict[str, Any]],
    vocab: set[str],
    errors: list[str],
    warnings: list[str],
) -> None:
    genre_profile = root.get("genre_profile") if isinstance(root.get("genre_profile"), dict) else {}
    primary = genre_profile.get("primary")
    genres: dict[str, Any] = contracts.get("genres", {})
    if primary not in genres or primary == "mixed":
        return
    volume_specs = [(item, volume_covered(item, numbers)) for item in volumes]

    def covered_chapters(item: dict[str, Any]) -> list[dict[str, Any]]:
        start, end = item.get("chapter_start"), item.get("chapter_end")
        return [ch for ch in ordered if isinstance(start, int) and isinstance(end, int) and start <= ch.get("number", 0) <= end]

    if primary == "mystery":
        for item, covered in volume_specs:
            if not covered:
                continue
            vol_chapters = covered_chapters(item)
            vol_ids = {ch.get("id") for ch in vol_chapters}
            if not any(
                fs.get("importance") == "P0" and fs.get("type") in {"物证", "信息"} and fs.get("plant_chapter") in vol_ids
                for fs in foreshadowing
            ):
                error(errors, f"{item.get('id')} 违反 MYST-01：P0 伏笔中至少 1 条应为物证或信息")
            if not any(
                op.get("action") in {"advance", "hint"} for ch in vol_chapters for op in ch.get("foreshadowing_ops", [])
            ):
                error(errors, f"{item.get('id')} 违反 MYST-02：每卷至少 1 次 foreshadowing advance/hint 操作")
            suspicion = sum(1 for ch in vol_chapters for entry in chapter_axis_entries(ch) if entry.get("axis") == "嫌疑模型")
            if suspicion < 2:
                warn(warnings, f"{item.get('id')} 违反 MYST-04：嫌疑模型轴推进不足 2 次（当前 {suspicion}）")
        for chapter in ordered:
            if any(op.get("action") == "reap" for op in chapter.get("foreshadowing_ops", [])):
                has_evidence = bool(chapter.get("evidence_refs"))
                has_advance = any(entry.get("axis") != "休整" for entry in chapter_axis_entries(chapter))
                if not has_evidence and not has_advance:
                    error(errors, f"chapters[{chapter.get('number')}] 违反 MYST-03：reap 章必须有 evidence_refs 或非休整 axis_advance")
        run = 0
        for chapter in ordered:
            has_ops = bool(chapter.get("foreshadowing_ops"))
            has_chain = any(entry.get("axis") == "证据链" for entry in chapter_axis_entries(chapter))
            run = 0 if (has_ops or has_chain) else run + 1
            if run == 3:
                warn(warnings, f"MYST-A1 证据链断裂：第 {chapter.get('number')} 章连续 3 章无伏笔操作且无证据链推进")
        for fs_id, history in foreshadowing_history.items():
            actions = [action for _, _, action in history]
            if "reap" in actions and "advance" not in actions and "hint" not in actions:
                warn(warnings, f"MYST-A2 无回溯依据的揭示：{fs_id} 直接 plant→reap，缺少 advance/hint 铺垫")

    elif primary == "romance":
        # 纯关系推进轴（关系边界/信任交换）；共同目标/失去风险/欲望张力是情境轴，
        # 全书只有情境轴推进的言情等于没有关系变化，必须被 ROMA-01 拦下。
        relationship_axes = {"关系边界", "信任交换"}
        has_relationship_line = any(line.get("type") == "relationship" for line in narrative_lines)
        has_relationship_axis = any(
            entry.get("axis") in relationship_axes for chapter in ordered for entry in chapter_axis_entries(chapter)
        )
        if not (has_relationship_line or has_relationship_axis):
            error(errors, "违反 ROMA-01：言情大纲必须有 relationship 叙事线或纯关系轴（关系边界/信任交换）axis_advance")
        run = 0
        for chapter in ordered:
            rel = [entry for entry in chapter_axis_entries(chapter) if entry.get("axis") in relationship_axes]
            if rel and all(not entry.get("cost_paid") for entry in rel):
                run += 1
                if run == 3:
                    warn(warnings, f"ROMA-A1 无代价推进：第 {chapter.get('number')} 章起连续 3 章关系轴推进无 cost_paid")
            elif rel:
                run = 0
        seen: dict[tuple[Any, Any], int] = {}
        for chapter in ordered:
            for entry in chapter_axis_entries(chapter):
                if entry.get("axis") == "休整":
                    continue
                key = (entry.get("axis"), entry.get("change"))
                seen[key] = seen.get(key, 0) + 1
        for (axis, change), count in seen.items():
            if count >= 3:
                warn(warnings, f"ROMA-A2 标签式推进：axis「{axis}」的 change「{change}」重复出现 {count} 次")

    elif primary == "progression":
        ladder = (root.get("story_engine") or {}).get("escalation_ladder") or []
        previous_set: set[Any] | None = None
        for index, raw_step in enumerate(ladder):
            step = raw_step if isinstance(raw_step, dict) else {}
            refs = step.get("axis_refs")
            if not isinstance(refs, list) or not refs:
                error(errors, f"escalation_ladder[{index}] 违反 PROG-01：成长/战斗题材升梯步骤必须声明 axis_refs")
                previous_set = None
                continue
            bad = [ref for ref in refs if ref not in vocab]
            if bad:
                error(errors, f"escalation_ladder[{index}].axis_refs 含词表外轴 {bad}")
            current = set(refs)
            if previous_set is not None and current == previous_set:
                error(errors, f"escalation_ladder[{index}] 违反 PROG-01：与上一步 axis_refs 完全相同（升级性质未变）")
            previous_set = current
        for item, covered in volume_specs:
            if not covered:
                continue
            entries = [
                entry
                for chapter in covered_chapters(item)
                for entry in chapter_axis_entries(chapter)
                if entry.get("axis") in POWER_AXES
            ]
            paid = [entry for entry in entries if entry.get("cost_paid")]
            if entries and len(paid) * 2 < len(entries):
                warn(warnings, f"{item.get('id')} 违反 PROG-02：能力轴推进过半无 cost_paid")
        run = 0
        for chapter in ordered:
            power = [entry for entry in chapter_axis_entries(chapter) if entry.get("axis") in POWER_AXES]
            if power and all(not entry.get("cost_paid") for entry in power):
                run += 1
                if run == 3:
                    warn(warnings, f"PROG-A1 无代价突破：第 {chapter.get('number')} 章起连续 3 章能力轴推进无 cost_paid")
            elif power:
                run = 0

    elif primary in {"workplace", "historical", "urban"}:
        aggregate_axes = {
            "workplace": {"准入", "制度"},
            "historical": {"制度", "时代限制"},
            "urban": {"资源", "声誉"},
        }[primary]
        streak_axes = {
            "workplace": {"准入", "制度", "利益", "声誉"},
            "historical": {"制度", "资源", "地理", "身份", "时代限制"},
            "urban": {"资源", "声誉", "准入", "生活约束"},
        }[primary]
        rule_id = {"workplace": "WORK-01", "historical": "HIST-01", "urban": "URBA-01"}[primary]
        detector_id = {"workplace": "WORK-A1", "historical": "HIST-A1", "urban": "URBA-A1"}[primary]
        span = 5
        for item, covered in volume_specs:
            if not covered:
                continue
            if not any(
                entry.get("axis") in aggregate_axes
                for chapter in covered_chapters(item)
                for entry in chapter_axis_entries(chapter)
            ):
                warn(warnings, f"{item.get('id')} 违反 {rule_id}：本卷无 {('/'.join(sorted(aggregate_axes)))} 轴推进")
        for number in consecutive_without_axis(ordered, streak_axes, span):
            warn(warnings, f"{detector_id}：第 {number} 章起连续 {span} 章无 {'/'.join(sorted(streak_axes))} 轴推进")
        if primary == "urban":
            branch_chapters = {branch.get("chapter_id") for branch in branches}
            for chapter in ordered:
                if chapter.get("id") not in branch_chapters:
                    continue
                entries = [entry for entry in chapter_axis_entries(chapter) if entry.get("axis") != "休整"]
                if entries and all(not entry.get("cost_paid") for entry in entries):
                    warn(warnings, f"URBA-A1 万能人脉/巧合解题嫌疑：关键选择章 {chapter.get('number')} 的全部 axis_advance 无 cost_paid")

    elif primary == "science_fiction":
        core_axes = {"科技规则", "系统性后果"}
        has_core_paid = any(
            entry.get("axis") in core_axes and entry.get("cost_paid")
            for chapter in ordered
            for entry in chapter_axis_entries(chapter)
        )
        if not has_core_paid:
            warn(warnings, "违反 SCIF-01：全书无一次带 cost_paid 的科技规则/系统性后果轴推进（核心设定未改变可行选择）")
        if not any(entry.get("axis") in core_axes for chapter in ordered for entry in chapter_axis_entries(chapter)):
            warn(warnings, "SCIF-A1 只换名词的都市冲突嫌疑：全书无科技规则/系统性后果轴推进")

    elif primary == "fantasy":
        for item, covered in volume_specs:
            if not covered:
                continue
            if not any(
                entry.get("axis") in {"世界规则", "阵营"} and entry.get("cost_paid")
                for chapter in covered_chapters(item)
                for entry in chapter_axis_entries(chapter)
            ):
                error(errors, f"{item.get('id')} 违反 FANT-01：世界规则/阵营轴推进必须至少一次带 cost_paid（规则成为行动阻力）")
        for chapter in ordered:
            entries = [entry for entry in chapter_axis_entries(chapter) if entry.get("axis") != "休整"]
            if len(entries) > 4 and all(not entry.get("cost_paid") for entry in entries):
                warn(warnings, f"FANT-A1 百科式设定倾倒嫌疑：第 {chapter.get('number')} 章 axis_advance 超过 4 条且全部无 cost_paid")

    elif primary == "literary":
        for item, covered in volume_specs:
            if not covered:
                continue
            if not any(
                entry.get("axis") in {"认知", "价值冲突"}
                for chapter in covered_chapters(item)
                for entry in chapter_axis_entries(chapter)
            ):
                warn(warnings, f"{item.get('id')} 违反 LITE-01：本卷无认知/价值冲突轴推进")
        run = 0
        for chapter in ordered:
            entries = [entry for entry in chapter_axis_entries(chapter) if entry.get("axis") != "休整"]
            if entries and all(not entry.get("cost_paid") for entry in entries):
                run += 1
                if run == 3:
                    warn(warnings, f"LITE-A1 抽象抒情替代事件选择嫌疑：第 {chapter.get('number')} 章起连续 3 章推进无 cost_paid")
            elif entries:
                run = 0


def check_entity_ledger(
    root: dict[str, Any],
    ordered: list[dict[str, Any]],
    errors: list[str],
    warnings: list[str],
) -> None:
    ledger = root.get("entity_ledger")
    if ledger is None:
        return
    ledger = mapping(ledger, "entity_ledger", errors)
    entities = array(ledger.get("entities"), "entity_ledger.entities", errors)
    known_ids: set[str] = set()
    for index, raw in enumerate(entities):
        entity = mapping(raw, f"entity_ledger.entities[{index}]", errors)
        fields(entity, ["id", "name", "type"], f"entity_ledger.entities[{index}]", errors)
        entity_id = entity.get("id")
        if isinstance(entity_id, str) and PATTERNS["entity"].match(entity_id):
            if entity_id in known_ids:
                error(errors, f"entity_ledger has duplicate id {entity_id}")
            known_ids.add(entity_id)
        elif entity_id is not None:
            error(errors, f"entity_ledger.entities[{index}].id has invalid format (ENT-001)")
        if entity.get("type") not in ENTITY_TYPES:
            error(errors, f"entity_ledger.entities[{index}].type is invalid")
        facts = array(entity.get("critical_facts"), f"entity_ledger.entities[{index}].critical_facts", errors)
        name = entity.get("name") if isinstance(entity.get("name"), str) else ""
        terminal_chapter: int | None = None
        number_sequence: list[tuple[int, float]] = []
        for fact_index, raw_fact in enumerate(facts):
            fact = mapping(raw_fact, f"entity_ledger.entities[{index}].critical_facts[{fact_index}]", errors)
            fields(fact, ["chapter", "fact", "status"], f"entity_ledger.entities[{index}].critical_facts[{fact_index}]", errors)
            if fact.get("status") not in {"active", "dead", "destroyed", "lost", "changed"}:
                error(errors, f"entity_ledger.entities[{index}].critical_facts[{fact_index}].status is invalid")
            chapter = fact.get("chapter")
            if isinstance(chapter, int) and fact.get("status") in ENTITY_TERMINAL:
                terminal_chapter = chapter if terminal_chapter is None else min(terminal_chapter, chapter)
            if isinstance(chapter, int) and isinstance(fact.get("fact"), str):
                match = NUMBER_IN_TEXT.search(fact["fact"])
                if match:
                    number_sequence.append((chapter, float(match.group())))
        if terminal_chapter is not None and name:
            for chapter in ordered:
                number = chapter.get("number")
                if not isinstance(number, int) or number <= terminal_chapter:
                    continue
                if is_flashback_chapter(chapter):
                    continue
                delta = chapter.get("state_delta") if isinstance(chapter.get("state_delta"), dict) else {}
                participatory = [str(value) for value in delta.get("changed_state", []) if isinstance(value, str)]
                participatory += [
                    str(goc.get("choice"))
                    for goc in chapter.get("gocs", [])
                    if isinstance(goc, dict) and isinstance(goc.get("choice"), str)
                ]
                if any(name in text for text in participatory):
                    error(
                        errors,
                        f"entity_ledger 实体「{name}」在第 {terminal_chapter} 章后状态为 {ENTITY_TERMINAL}，"
                        f"但第 {number} 章仍作为参与者出现（回忆性内容请标记 flashback）",
                    )
        values: dict[float, int] = {}
        for chapter, value in number_sequence:
            values[value] = chapter
        ordered_values = sorted(values.items(), key=lambda pair: pair[1])
        for index in range(1, len(ordered_values)):
            prev_value, _ = ordered_values[index - 1]
            current_value, _ = ordered_values[index]
            if current_value > prev_value:
                decreased_before = any(
                    earlier < prev_value
                    for earlier, _ in ordered_values[: index - 1]
                )
                if decreased_before:
                    warn(warnings, f"entity_ledger 实体「{name}」的数值先减后增（{[v for v, _ in ordered_values]}），确认中间有恢复事件")
                    break


def check_internal_anchors(
    root: dict[str, Any],
    chapter_ids: set[str],
    vocab: set[str],
    errors: list[str],
    warnings: list[str],
) -> None:
    anchors = root.get("internal_anchors")
    if anchors is None:
        pass
    else:
        anchors = mapping(anchors, "internal_anchors", errors)
        power = anchors.get("power_system")
        if power is not None:
            power = mapping(power, "internal_anchors.power_system", errors)
            levels = array(power.get("levels"), "internal_anchors.power_system.levels", errors)
            for index, raw in enumerate(levels):
                level = mapping(raw, f"internal_anchors.power_system.levels[{index}]", errors)
                fields(level, ["tier", "ceiling", "boundary"], f"internal_anchors.power_system.levels[{index}]", errors)
        number_anchors = array(anchors.get("number_anchors"), "internal_anchors.number_anchors", errors)
        for index, raw in enumerate(number_anchors):
            anchor = mapping(raw, f"internal_anchors.number_anchors[{index}]", errors)
            fields(anchor, ["kind", "entity", "value"], f"internal_anchors.number_anchors[{index}]", errors)
            locked_at = anchor.get("locked_at")
            if locked_at is not None and locked_at not in chapter_ids:
                error(errors, f"internal_anchors.number_anchors[{index}].locked_at references unknown chapter")
    genre_profile = root.get("genre_profile") if isinstance(root.get("genre_profile"), dict) else {}
    primary = genre_profile.get("primary")
    ladder = (root.get("story_engine") or {}).get("escalation_ladder") or []
    ladder_uses_power = any(
        isinstance(step, dict) and any(ref in POWER_AXES for ref in step.get("axis_refs", []) if isinstance(ref, str))
        for step in ladder
    )
    if primary in POWER_GENRES and ladder_uses_power:
        power = (root.get("internal_anchors") or {}).get("power_system") if isinstance(root.get("internal_anchors"), dict) else None
        if not power:
            error(errors, "internal_anchors.power_system is required when escalation_ladder 引用能力轴（独立模式也必须自建，防战力崩坏）")
    for index, step in enumerate(ladder):
        if not isinstance(step, dict):
            continue
        refs = step.get("axis_refs")
        if refs is None:
            continue
        bad = [ref for ref in refs if ref not in vocab]
        if bad:
            error(errors, f"story_engine.escalation_ladder[{index}].axis_refs 含词表外轴 {bad}")


def check_commercial(
    root: dict[str, Any],
    ordered: list[dict[str, Any]],
    outline_path: Path,
    errors: list[str],
    warnings: list[str],
) -> None:
    profile = root.get("commercial_profile")
    if profile is None:
        return
    profile = mapping(profile, "commercial_profile", errors)
    assumption_flag = profile.get("assumption_flag")
    if assumption_flag is not None and assumption_flag not in {"editorial_assumption", "benchmarked"}:
        error(errors, "commercial_profile.assumption_flag is invalid")
    evidence_source = profile.get("evidence_source")
    benchmarked = False
    if evidence_source is not None:
        if not isinstance(evidence_source, str) or not evidence_source.strip():
            error(errors, "commercial_profile.evidence_source must be a non-empty file path")
        else:
            source_path = Path(evidence_source)
            if not source_path.is_absolute():
                source_path = outline_path.parent / source_path
            if not source_path.exists():
                error(errors, f"commercial_profile.evidence_source 指向的文件不存在：{evidence_source}（禁止虚构对标来源；无数据请改用 assumption_flag=editorial_assumption）")
            else:
                benchmarked = True
    elif assumption_flag != "editorial_assumption":
        error(errors, "commercial_profile 需要 evidence_source（真实文件路径）或显式 assumption_flag=editorial_assumption")
    hook_policy = profile.get("hook_policy") if isinstance(profile.get("hook_policy"), dict) else {}
    if benchmarked and hook_policy.get("first_3_chapters") == "all_high_pull":
        first_numbers = sorted(chapter.get("number") for chapter in ordered if isinstance(chapter.get("number"), int))[:3]
        if first_numbers and first_numbers[0] == 1:
            for chapter in ordered:
                number = chapter.get("number")
                if number not in first_numbers:
                    continue
                reason = chapter.get("continue_reason")
                hook = reason.get("hook_type") if isinstance(reason, dict) else None
                if hook not in HOOK_HIGH_PULL:
                    error(errors, f"chapters[{number}] 违反 commercial_profile.hook_policy：前三章 hook_type 必须为高拉力（危机/悬念/反转）")
    gap_max = profile.get("high_energy_gap_max")
    if benchmarked and isinstance(gap_max, int) and gap_max > 0:
        positions = [
            chapter.get("number")
            for chapter in ordered
            if isinstance(chapter.get("continue_reason"), dict)
            and chapter["continue_reason"].get("hook_type") in HOOK_HIGH_PULL
        ]
        for previous, current in zip(positions, positions[1:]):
            if isinstance(previous, int) and isinstance(current, int) and current - previous > gap_max:
                warn(warnings, f"违反 commercial_profile.high_energy_gap_max：第 {previous}→{current} 章高拉力钩子间隔超过 {gap_max}")


def collect_upstream_clues(metadata: dict[str, Any]) -> list[dict[str, Any]]:
    """从 01_设定元数据.json 的 genre_module[].data.clue_ledger 提取线索账本。"""
    collected: list[dict[str, Any]] = []
    genres = metadata.get("genre_module", {})
    srcs = []
    if isinstance(genres, dict):
        for key in ("primary", "secondary"):
            mod = genres.get(key)
            if isinstance(mod, dict):
                srcs.append(mod)
    elif isinstance(genres, list):
        srcs.extend(g for g in genres if isinstance(g, dict))
    for mod in srcs:
        data = mod.get("data") if isinstance(mod.get("data"), dict) else {}
        clues = data.get("clue_ledger") if isinstance(data.get("clue_ledger"), list) else []
        collected.extend(c for c in clues if isinstance(c, dict))
    return collected


def _strip_negation(text: str) -> str:
    return re.sub(r"^(不|别|莫|毋|勿)", "", text.strip())


def _shares_core(rule: str, candidates: set[str], min_run: int = 6) -> bool:
    """判断 rule 与任一候选项是否有足够长度的连续公共子串（规避措辞差异误报）。"""
    rule_core = _strip_negation(rule)
    if len(rule_core) < min_run:
        return bool(candidates) and sum(len(c) for c in candidates) > 0
    for cand in candidates:
        if cand and _strip_negation(cand) in rule_core or (len(cand) >= min_run and rule_core in cand):
            return True
    window = {rule_core[i:i + min_run] for i in range(len(rule_core) - min_run + 1)}
    return any(any(win in _strip_negation(c) for win in window) for c in candidates if c)


def check_constraint_transfer(
    constraints: dict[str, Any],
    root: dict[str, Any],
    errors: list[str],
    warnings: list[str],
    clues: list[dict[str, Any]],
) -> None:
    """校验大纲是否把设定包 02_写作约束 与 clue_ledger 忠实传导入 Foreshadowing。"""
    if not isinstance(constraints, dict):
        error(errors, "setting 02_写作约束 must be an object")
        return
    narrative = constraints.get("narrative_guardrails")
    genre_profile = root.get("genre_profile", {})
    if not isinstance(genre_profile, dict):
        genre_profile = {"avoid_moves": [], "must_deliver": []}
    gp_avoid = {str(v).strip() for v in genre_profile.get("avoid_moves", []) if isinstance(v, str)}
    gp_must = {str(v).strip() for v in genre_profile.get("must_deliver", []) if isinstance(v, str)}
    if isinstance(narrative, dict):
        for rule in narrative.get("avoid_moves", []):
            if isinstance(rule, str) and not _shares_core(rule, gp_avoid):
                warn(warnings, f"设定包叙事约束未传入大纲避免动作：{_strip_negation(rule)}")
        for rule in narrative.get("required_moves", []):
            if isinstance(rule, str) and not _shares_core(rule, gp_must):
                warn(warnings, f"设定包叙事约束未传入大纲必做动作：{rule}")
    clue_ids = {str(c.get("id")) for c in clues if c.get("id")}
    if not clue_ids:
        return
    foreshadowing = root.get("foreshadowing", []) if isinstance(root.get("foreshadowing"), list) else []
    for index, raw in enumerate(foreshadowing):
        if not isinstance(raw, dict):
            continue
        src = raw.get("source_clue")
        if src is None:
            continue
        if src not in clue_ids:
            error(errors, f"foreshadowing[{index}].source_clue 引用了不存在的线索 {src}（设定包 clue_ledger 中无此 id）")


def check_foreshadowing_triggers(
    foreshadowing: list[dict[str, Any]],
    chapter_ids: set[str],
    chapter_number_by_id: dict[str, int],
    errors: list[str],
) -> None:
    for index, raw in enumerate(foreshadowing):
        item = mapping(raw, f"foreshadowing[{index}]", errors)
        trigger_id = item.get("trigger_chapter")
        if trigger_id is None:
            continue
        if trigger_id not in chapter_ids:
            error(errors, f"foreshadowing[{index}].trigger_chapter does not exist")
            continue
        condition = item.get("trigger_condition")
        if not isinstance(condition, str) or not condition.strip():
            error(errors, f"foreshadowing[{index}].trigger_condition is required when trigger_chapter is set")
        plant_number = chapter_number_by_id.get(item.get("plant_chapter"))
        trigger_number = chapter_number_by_id.get(trigger_id)
        if isinstance(plant_number, int) and isinstance(trigger_number, int) and trigger_number < plant_number:
            error(errors, f"foreshadowing[{index}].trigger_chapter 不得早于 plant_chapter")
        for harvest_field in ("planned_harvest", "actual_harvest"):
            harvest_id = item.get(harvest_field)
            harvest_number = chapter_number_by_id.get(harvest_id) if harvest_id else None
            if isinstance(harvest_number, int) and isinstance(trigger_number, int) and harvest_number < trigger_number:
                error(errors, f"foreshadowing[{index}].trigger_chapter 不得晚于 {harvest_field}")


def check_hook_types(chapters: list[dict[str, Any]], errors: list[str]) -> None:
    for index, raw in enumerate(chapters):
        reason = raw.get("continue_reason")
        if reason is None or isinstance(reason, str):
            continue
        if isinstance(reason, dict):
            hook = reason.get("hook_type")
            if hook not in HOOK_ENUM:
                error(errors, f"chapters[{index}].continue_reason.hook_type is invalid（封闭枚举：{'/'.join(sorted(HOOK_ENUM))}）")
            if not isinstance(reason.get("text"), str) or not reason.get("text", "").strip():
                error(errors, f"chapters[{index}].continue_reason.text is required")
        else:
            error(errors, f"chapters[{index}].continue_reason must be a string or {{hook_type, text}}")


def check_break_abuse(ordered: list[dict[str, Any]], warnings: list[str]) -> None:
    run = 0
    for chapter in ordered:
        delta = chapter.get("state_delta") if isinstance(chapter.get("state_delta"), dict) else {}
        if delta.get("continuity_break") and delta.get("break_type") != "arc_reset":
            run += 1
            if run == 2:
                warn(warnings, f"chapters[{chapter.get('number')}] 连续第 2 次非 arc_reset 的 continuity_break；逃生门被滥用嫌疑，转语义评审")
        else:
            run = 0


def main(filename: str, setting_package: str | None = None) -> int:
    errors: list[str] = []
    warnings: list[str] = []
    outline_path = Path(filename)
    try:
        root = json.loads(outline_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        print(f"INVALID: {exc}")
        return 1
    root = mapping(root, "root", errors)
    fields(root, ["contract_version", "outline_scope", "source_revision", "source_trace", "setting_refs", "genre_profile", "story_threads", "direction_gate", "story_engine", "open_decisions"], "root", errors)
    version = root.get("contract_version")
    if version not in {"1.2", "1.3"}:
        error(errors, "root.contract_version must be 1.2 or 1.3")
    v13 = version == "1.3"
    if root.get("outline_scope") not in {"batch", "full"}:
        error(errors, "root.outline_scope must be batch or full")
    contracts: dict[str, Any] | None = None
    if v13:
        contracts = load_genre_contracts(errors)
    raw_profile = root.get("outline_profile")
    if raw_profile is not None and raw_profile not in {"lite", "standard", "full"}:
        error(errors, "root.outline_profile is invalid (lite/standard/full)")
        raw_profile = None
    profile = raw_profile or ("full" if root.get("outline_scope") == "full" else "standard")
    if raw_profile == "lite":
        if root.get("outline_scope") != "batch":
            error(errors, "outline_profile=lite 仅允许 outline_scope=batch（长篇/全书必须保留完整护栏）")
        if not root.get("profile_intent"):
            error(errors, "outline_profile=lite 需要 root.profile_intent 说明短篇意图")
    lite = profile == "lite"
    if setting_package:
        package_dir = Path(setting_package)
        package_path = package_dir / "manifest.json" if package_dir.is_dir() else package_dir
        try:
            package = json.loads(package_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            error(errors, f"setting package cannot be read: {exc}")
        else:
            package_revision = package.get("source_revision")
            if package_revision and package_revision != root.get("source_package_revision"):
                error(errors, "setting package source_revision must match root.source_package_revision")
            metadata_path = package_path.parent / "01_设定元数据.json"
            if metadata_path.exists():
                try:
                    metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
                except (OSError, json.JSONDecodeError) as exc:
                    error(errors, f"setting metadata cannot be read: {exc}")
                else:
                    world = metadata.get("world", {}) if isinstance(metadata, dict) else {}
                    available = {
                        "character_ids": {item.get("id") for item in metadata.get("characters", []) if isinstance(item, dict) and item.get("id")},
                        "location_ids": {item.get("id") for item in world.get("locations", []) if isinstance(item, dict) and item.get("id")},
                        "faction_ids": {item.get("id") for item in world.get("factions", []) if isinstance(item, dict) and item.get("id")},
                        "rule_ids": {item.get("id") for item in world.get("rules", []) if isinstance(item, dict) and item.get("id")},
                        "resource_ids": {item.get("id") for item in world.get("resources", []) if isinstance(item, dict) and item.get("id")},
                    }
                    refs = root.get("setting_refs", {})
                    for ref_name, known_ids in available.items():
                        requested = refs.get(ref_name, []) if isinstance(refs, dict) else []
                        for ref_id in requested:
                            if known_ids and ref_id not in known_ids:
                                error(errors, f"setting_refs.{ref_name} references unknown upstream id {ref_id}")
                    # —— 契约 1.3 设定包增强：消费 02_写作约束 与 genre_module.clue_ledger ——
                    clues = collect_upstream_clues(metadata)
                    constraint_path = package_path.parent / "02_写作约束.json"
                    if constraint_path.exists():
                        try:
                            constraints = json.loads(constraint_path.read_text(encoding="utf-8"))
                            check_constraint_transfer(constraints, root, errors, warnings, clues)
                        except (OSError, json.JSONDecodeError) as exc:
                            error(errors, f"setting constraints cannot be read: {exc}")
    # 独立输入（一份设定文档）可省略 input_package/source_package_revision；
    # 只有声明消费设定包时才强制版本一致。
    if root.get("input_package") is not None:
        input_package = mapping(root.get("input_package"), "input_package", errors)
        fields(input_package, ["source_revision", "contract_version"], "input_package", errors)
        if not root.get("source_package_revision"):
            error(errors, "input_package present requires root.source_package_revision")
        elif input_package.get("source_revision") != root.get("source_package_revision"):
            error(errors, "input_package.source_revision must match root.source_package_revision")
    setting_refs = mapping(root.get("setting_refs"), "setting_refs", errors)
    for ref_name in ("character_ids", "location_ids", "faction_ids", "rule_ids", "resource_ids"):
        if ref_name in setting_refs and not isinstance(setting_refs[ref_name], list):
            error(errors, f"setting_refs.{ref_name} must be an array")
    genre_profile = mapping(root.get("genre_profile"), "genre_profile", errors)
    fields(genre_profile, ["primary", "secondary", "reader_promise", "progression_axes", "must_deliver", "avoid_moves"], "genre_profile", errors)
    valid_genres = {"mystery", "romance", "progression", "workplace", "historical", "urban", "science_fiction", "fantasy", "literary", "mixed"}
    if genre_profile.get("primary") not in valid_genres:
        error(errors, "genre_profile.primary is invalid")
    for field_name in ("secondary", "progression_axes", "must_deliver", "avoid_moves"):
        values = array(genre_profile.get(field_name), f"genre_profile.{field_name}", errors)
        if field_name != "secondary" and not values:
            error(errors, f"genre_profile.{field_name} needs at least one item")

    direction = mapping(root.get("direction_gate"), "direction_gate", errors)
    fields(direction, ["premise", "reader_promise", "pitch", "opening_delivery", "assumptions"], "direction_gate", errors)
    trace = mapping(root.get("source_trace"), "source_trace", errors)
    fields(trace, ["preserved", "inferred"], "source_trace", errors)
    opening = mapping(direction.get("opening_delivery"), "direction_gate.opening_delivery", errors)
    fields(opening, ["first_500", "first_3_chapters"], "direction_gate.opening_delivery", errors)
    if not array(opening.get("first_3_chapters"), "direction_gate.opening_delivery.first_3_chapters", errors):
        error(errors, "direction_gate.opening_delivery.first_3_chapters needs at least one delivery")
    story = mapping(root.get("story_engine"), "story_engine", errors)
    fields(story, ["theme_question", "protagonist", "opponent", "ending_proof", "escalation_ladder"], "story_engine", errors)
    ending_proof = mapping(story.get("ending_proof"), "story_engine.ending_proof", errors)
    fields(ending_proof, ["resolution_id", "claim"], "story_engine.ending_proof", errors)
    if not re.match(r"^RES-[0-9A-Z-]+$", str(ending_proof.get("resolution_id", ""))):
        error(errors, "story_engine.ending_proof.resolution_id has invalid format")
    ladder = array(story.get("escalation_ladder"), "story_engine.escalation_ladder", errors)
    if len(ladder) < 3:
        error(errors, "story_engine.escalation_ladder needs at least 3 steps")
    for index, raw in enumerate(ladder):
        fields(mapping(raw, f"escalation_ladder[{index}]", errors), ["trigger", "choice", "cost", "state_change"], f"escalation_ladder[{index}]", errors)

    lines = array(root.get("narrative_lines"), "narrative_lines", errors)
    volumes = array(root.get("volumes"), "volumes", errors)
    chapters = array(root.get("chapters"), "chapters", errors)
    foreshadowing = array(root.get("foreshadowing"), "foreshadowing", errors)
    branches = array(root.get("branch_nodes"), "branch_nodes", errors)
    story_threads = array(root.get("story_threads"), "story_threads", errors)
    decisions = array(root.get("open_decisions"), "open_decisions", errors)
    line_ids = ids(lines, "narrative_lines", PATTERNS["line"], errors)
    volume_ids = ids(volumes, "volumes", PATTERNS["volume"], errors)
    chapter_ids = ids(chapters, "chapters", PATTERNS["chapter"], errors)
    foreshadowing_ids = ids(foreshadowing, "foreshadowing", PATTERNS["foreshadowing"], errors)
    ids(branches, "branch_nodes", PATTERNS["branch"], errors)
    thread_ids = ids(story_threads, "story_threads", PATTERNS["thread"], errors)
    implicit_volume = lite and not volumes
    thread_specs: dict[str, dict[str, Any]] = {}
    for index, raw in enumerate(story_threads):
        item = mapping(raw, f"story_threads[{index}]", errors)
        fields(item, ["id", "line_id", "summary", "opened_chapter", "status"], f"story_threads[{index}]", errors)
        if "planned_resolution_chapter" not in item:
            error(errors, f"story_threads[{index}].planned_resolution_chapter is required")
        thread_specs[item.get("id", "?")] = item
        if item.get("line_id") not in line_ids:
            error(errors, f"story_threads[{index}].line_id does not exist")
        if item.get("status") not in {"OPEN", "CLOSED", "ABANDONED"}:
            error(errors, f"story_threads[{index}].status is invalid")
    for index, raw in enumerate(decisions):
        fields(mapping(raw, f"open_decisions[{index}]", errors), ["question", "blocks", "owner"], f"open_decisions[{index}]", errors)
    for index, raw in enumerate(lines):
        item = mapping(raw, f"narrative_lines[{index}]", errors)
        fields(item, ["id", "name", "type", "purpose"], f"narrative_lines[{index}]", errors)
        if item.get("type") not in {"main", "subplot", "relationship", "growth"}:
            error(errors, f"narrative_lines[{index}].type is invalid")

    ranges: list[tuple[int, int, str]] = []
    endings: dict[str, Any] = {}
    resolutions: dict[str, Any] = {}
    for index, raw in enumerate(volumes):
        item = mapping(raw, f"volumes[{index}]", errors)
        fields(item, ["id", "chapter_start", "chapter_end", "promise", "goal", "opposition", "choice", "cost", "state_change", "anchors", "resolution_id"], f"volumes[{index}]", errors)
        start, end = item.get("chapter_start"), item.get("chapter_end")
        if isinstance(start, int) and isinstance(end, int) and start <= end:
            ranges.append((start, end, item.get("id", "?")))
        else:
            error(errors, f"volumes[{index}] has an invalid chapter range")
        anchors = mapping(item.get("anchors"), f"volumes[{index}].anchors", errors)
        fields(anchors, ["quarter", "midpoint", "three_quarter", "ending"], f"volumes[{index}].anchors", errors)
        if not re.match(r"^AN-[0-9A-Z-]+$", str(anchors.get("ending", ""))):
            error(errors, f"volumes[{index}].anchors.ending has invalid stable ID format")
        endings[item.get("id", "?")] = anchors.get("ending")
        resolutions[item.get("id", "?")] = item.get("resolution_id")
        if not isinstance(item.get("resolution_id"), str) or not re.match(r"^RES-[0-9A-Z-]+$", item.get("resolution_id", "")):
            error(errors, f"volumes[{index}].resolution_id has invalid format")

    numbers: set[int] = set()
    ending_chapters: set[str] = set()
    operation_order = {"plant": 1, "advance": 2, "hint": 3, "reap": 4, "archive": 5}
    foreshadowing_history: dict[str, list[tuple[int, int, str]]] = {}
    thread_history: dict[str, list[tuple[int, str]]] = {}
    chapter_fields_required = ["id", "volume_id", "number", "purpose", "reader_emotion", "emotion_source", "rhythm_function", "narrative_line_ids", "anchor_tags", "gocs", "scene_effects", "foreshadowing_ops", "state_delta", "continue_reason"]
    if not lite:
        chapter_fields_required.append("thread_ops")
    for index, raw in enumerate(chapters):
        item = mapping(raw, f"chapters[{index}]", errors)
        fields(item, chapter_fields_required, f"chapters[{index}]", errors)
        number = item.get("number")
        if not isinstance(number, int) or number < 1 or number in numbers:
            error(errors, f"chapters[{index}].number must be a unique positive integer")
        else:
            numbers.add(number)
            if not implicit_volume:
                matches = [volume_id for start, end, volume_id in ranges if start <= number <= end]
                if matches != [item.get("volume_id")]:
                    error(errors, f"chapters[{index}] must belong to exactly its declared volume range")
        if not implicit_volume and item.get("volume_id") not in volume_ids:
            error(errors, f"chapters[{index}].volume_id does not exist")
        if item.get("emotion_source") not in {"user", "editorial_assumption"}:
            error(errors, f"chapters[{index}].emotion_source is invalid")
        delta = mapping(item.get("state_delta"), f"chapters[{index}].state_delta", errors)
        fields(delta, ["entry_state", "trigger", "choice", "cost", "changed_state", "new_obligations", "unresolved_pull"], f"chapters[{index}].state_delta", errors)
        if "continuity_break" in delta and not isinstance(delta.get("continuity_break"), bool):
            error(errors, f"chapters[{index}].state_delta.continuity_break must be boolean")
        if delta.get("continuity_break") and not isinstance(delta.get("continuity_note"), str):
            error(errors, f"chapters[{index}].state_delta.continuity_break requires continuity_note")
        if "break_type" in delta and delta.get("break_type") not in {None, "arc_reset", "jump"}:
            error(errors, f"chapters[{index}].state_delta.break_type is invalid (arc_reset/jump)")
        for delta_field in ("entry_state", "changed_state", "new_obligations"):
            if not isinstance(delta.get(delta_field), list):
                error(errors, f"chapters[{index}].state_delta.{delta_field} must be an array")
            elif delta_field != "new_obligations" and not delta.get(delta_field):
                error(errors, f"chapters[{index}].state_delta.{delta_field} needs at least one item")
        for op_index, raw_op in enumerate(array(item.get("thread_ops"), f"chapters[{index}].thread_ops", errors)):
            thread_op = mapping(raw_op, f"chapters[{index}].thread_ops[{op_index}]", errors)
            fields(thread_op, ["id", "action", "effect"], f"chapters[{index}].thread_ops[{op_index}]", errors)
            if thread_op.get("id") not in thread_ids:
                error(errors, f"chapters[{index}].thread_ops references unknown story thread {thread_op.get('id')}")
            if thread_op.get("action") not in {"open", "advance", "close", "abandon"}:
                error(errors, f"chapters[{index}].thread_ops has invalid action")
            elif isinstance(number, int):
                thread_history.setdefault(thread_op.get("id", "?"), []).append((number, thread_op["action"]))
        declared_line_ids = item.get("narrative_line_ids") if isinstance(item.get("narrative_line_ids"), list) else []
        line_weights = item.get("line_weights")
        if line_weights is not None:
            if not isinstance(line_weights, dict):
                error(errors, f"chapters[{index}].line_weights must be an object")
            else:
                expected_lines = set(declared_line_ids)
                weight_lines = set(line_weights)
                if weight_lines != expected_lines:
                    error(errors, f"chapters[{index}].line_weights keys must match narrative_line_ids")
                weights = list(line_weights.values())
                if any(not isinstance(value, (int, float)) or value < 0 for value in weights):
                    error(errors, f"chapters[{index}].line_weights must contain non-negative numbers")
                elif weights and abs(sum(weights) - 1.0) > 1e-6:
                    error(errors, f"chapters[{index}].line_weights must sum to 1")
        if len(declared_line_ids) > 1:
            intersection = mapping(item.get("line_intersection"), f"chapters[{index}].line_intersection", errors)
            if intersection.get("is_intersection") is not True:
                error(errors, f"chapters[{index}] multi-line chapter must mark line_intersection.is_intersection=true")
            if set(intersection.get("line_ids", [])) != set(declared_line_ids):
                error(errors, f"chapters[{index}].line_intersection.line_ids must match narrative_line_ids")
        if endings.get(item.get("volume_id")) in array(item.get("anchor_tags"), f"chapters[{index}].anchor_tags", errors):
            ending_chapters.add(item.get("volume_id"))
        if not array(item.get("narrative_line_ids"), f"chapters[{index}].narrative_line_ids", errors):
            error(errors, f"chapters[{index}] needs at least one narrative line")
        if not array(item.get("gocs"), f"chapters[{index}].gocs", errors):
            error(errors, f"chapters[{index}] needs at least one GOCS card")
        if not array(item.get("scene_effects"), f"chapters[{index}].scene_effects", errors):
            error(errors, f"chapters[{index}] needs at least one scene effect")
        for line_id in array(item.get("narrative_line_ids"), f"chapters[{index}].narrative_line_ids", errors):
            if line_id not in line_ids:
                error(errors, f"chapters[{index}] references unknown narrative line {line_id}")
        for scene_index, raw_scene in enumerate(array(item.get("gocs"), f"chapters[{index}].gocs", errors)):
            fields(mapping(raw_scene, f"chapters[{index}].gocs[{scene_index}]", errors), ["goal", "obstacle", "choice", "state_change"], f"chapters[{index}].gocs[{scene_index}]", errors)
        for effect_index, raw_effect in enumerate(array(item.get("scene_effects"), f"chapters[{index}].scene_effects", errors)):
            fields(mapping(raw_effect, f"chapters[{index}].scene_effects[{effect_index}]", errors), ["scene_id", "reader_reaction", "reader_question"], f"chapters[{index}].scene_effects[{effect_index}]", errors)
        for op_index, raw_op in enumerate(array(item.get("foreshadowing_ops"), f"chapters[{index}].foreshadowing_ops", errors)):
            op = mapping(raw_op, f"chapters[{index}].foreshadowing_ops[{op_index}]", errors)
            fields(op, ["id", "action"], f"chapters[{index}].foreshadowing_ops[{op_index}]", errors)
            if op.get("id") not in foreshadowing_ids:
                error(errors, f"chapters[{index}] references unknown foreshadowing")
            if op.get("action") not in operation_order:
                error(errors, f"chapters[{index}] has invalid foreshadowing action")
            elif isinstance(number, int):
                foreshadowing_history.setdefault(op.get("id", "?"), []).append((number, operation_order[op["action"]], op["action"]))

    chapter_offset = root.get("chapter_offset", 0)
    if not isinstance(chapter_offset, int) or chapter_offset < 0:
        error(errors, "root.chapter_offset must be a non-negative integer（全书绝对章号偏移：本批第一章 = offset+1）")
        chapter_offset = 0
    if numbers and numbers != set(range(chapter_offset + 1, chapter_offset + len(numbers) + 1)):
        error(errors, f"chapters.number 必须在本批内从 {chapter_offset + 1} 连续递增（chapter_offset={chapter_offset}）")
    ordered_chapters = sorted((chapter for chapter in chapters if isinstance(chapter, dict)), key=lambda item: item.get("number", 0))
    for previous, current in zip(ordered_chapters, ordered_chapters[1:]):
        previous_delta = previous.get("state_delta", {}) if isinstance(previous.get("state_delta"), dict) else {}
        current_delta = current.get("state_delta", {}) if isinstance(current.get("state_delta"), dict) else {}
        if current_delta.get("continuity_break"):
            continue
        inherited = {str(value).strip() for value in current_delta.get("entry_state", []) if isinstance(value, str) and value.strip()}
        produced = {str(value).strip() for value in [*previous_delta.get("changed_state", []), *previous_delta.get("new_obligations", [])] if isinstance(value, str) and value.strip()}
        if produced and not inherited.intersection(produced):
            error(errors, f"chapters[{current.get('number')}] entry_state does not carry forward chapter {previous.get('number')} changed_state/new_obligations; set continuity_break with reason only for an intentional reset")
    chapter_numbers = {chapter.get("id"): chapter.get("number") for chapter in chapters if isinstance(chapter, dict)}
    chapter_number_by_id = {chapter.get("id"): chapter.get("number") for chapter in chapters if isinstance(chapter, dict) and isinstance(chapter.get("number"), int)}
    inherited_raw = root.get("inherited") if isinstance(root.get("inherited"), dict) else {}
    inherited_threads = {value for value in inherited_raw.get("threads", []) if isinstance(value, str)}
    inherited_foreshadowing = {value for value in inherited_raw.get("foreshadowing", []) if isinstance(value, str)}
    for thread_id in inherited_threads:
        if thread_id not in thread_specs:
            error(errors, f"inherited.threads 声明了未在 story_threads 定义的线程 {thread_id}")
    for foreshadowing_id in inherited_foreshadowing:
        if foreshadowing_id not in foreshadowing_ids:
            error(errors, f"inherited.foreshadowing 声明了未在 foreshadowing 定义的伏笔 {foreshadowing_id}")
    for thread_id, spec in thread_specs.items():
        is_inherited = thread_id in inherited_threads
        opened_id = spec.get("opened_chapter")
        opened_number = chapter_numbers.get(opened_id)
        if opened_number is None and not is_inherited:
            error(errors, f"story_threads[{thread_id}].opened_chapter does not exist")
        planned_id = spec.get("planned_resolution_chapter")
        planned_number = chapter_numbers.get(planned_id) if planned_id else None
        if planned_id and planned_number is None and not is_inherited:
            error(errors, f"story_threads[{thread_id}].planned_resolution_chapter does not exist")
        if isinstance(opened_number, int) and isinstance(planned_number, int) and planned_number < opened_number:
            error(errors, f"story_threads[{thread_id}] planned resolution precedes opening")
        history = sorted(thread_history.get(thread_id, []))
        if not history:
            error(errors, f"story_threads[{thread_id}] has no thread operation")
            continue
        if is_inherited and history[0][1] == "open":
            error(errors, f"story_threads[{thread_id}] 是承接线程（inherited），本批不得重复 open，续写请用 advance")
        if not is_inherited and history[0][1] != "open":
            error(errors, f"story_threads[{thread_id}] must begin with open")
        if isinstance(opened_number, int) and history[0][0] != opened_number:
            error(errors, f"story_threads[{thread_id}] open operation must match opened_chapter")
        seen_terminal = False
        terminal_action = None
        terminal_number = None
        for number, action in history:
            if seen_terminal:
                error(errors, f"story_threads[{thread_id}] has operation after {terminal_action}")
            if action in {"close", "abandon"}:
                if seen_terminal:
                    continue
                seen_terminal = True
                terminal_action, terminal_number = action, number
            elif action == "open" and number != history[0][0]:
                error(errors, f"story_threads[{thread_id}] can only be opened once")
        status = spec.get("status")
        if status == "CLOSED" and terminal_action != "close":
            error(errors, f"story_threads[{thread_id}] status CLOSED requires a close operation")
        if status == "ABANDONED" and terminal_action != "abandon":
            error(errors, f"story_threads[{thread_id}] status ABANDONED requires an abandon operation")
        if status == "OPEN" and terminal_action is not None:
            error(errors, f"story_threads[{thread_id}] status OPEN cannot have a terminal operation")
        actual_id = spec.get("actual_resolution_chapter")
        actual_number = chapter_numbers.get(actual_id) if actual_id else None
        if actual_id and actual_number is None and not is_inherited:
            error(errors, f"story_threads[{thread_id}].actual_resolution_chapter does not exist")
        if status in {"CLOSED", "ABANDONED"} and actual_number != terminal_number:
            error(errors, f"story_threads[{thread_id}] actual resolution must match terminal operation")
    if root.get("outline_scope") == "full" and any(spec.get("status") == "OPEN" for spec in thread_specs.values()):
        error(errors, "full outline cannot leave story_threads OPEN")
    if volumes:
        terminal_volume = max(volumes, key=lambda value: value.get("chapter_end", 0))
        if root.get("outline_scope") == "full" and terminal_volume.get("resolution_id") != ending_proof.get("resolution_id"):
            error(errors, "terminal volume resolution_id must match story_engine.ending_proof.resolution_id")
    if not implicit_volume:
        for volume_id in volume_ids:
            if volume_id not in ending_chapters:
                error(errors, f"{volume_id} has no chapter tagged with its ending anchor")

    for foreshadowing_id, history in foreshadowing_history.items():
        states = [state for _, state, _ in sorted(history)]
        if states != sorted(states):
            error(errors, f"{foreshadowing_id} has an invalid lifecycle order")
    for index, raw in enumerate(foreshadowing):
        item = mapping(raw, f"foreshadowing[{index}]", errors)
        fields(item, ["id", "summary", "type", "importance", "plant_chapter", "harvest_effect", "status"], f"foreshadowing[{index}]", errors)
        if "planned_harvest" not in item:
            error(errors, f"foreshadowing[{index}].planned_harvest key is required (null allowed when not yet scheduled)")
        if item.get("status") not in {"PLANT", "ADVANCE", "HINT", "REAP", "ARCHIVE"}:
            error(errors, f"foreshadowing[{index}].status is invalid")
        if item.get("plant_chapter") not in chapter_ids and item.get("id") not in inherited_foreshadowing:
            error(errors, f"foreshadowing[{index}].plant_chapter does not exist")
        plant_number = next((chapter.get("number") for chapter in chapters if chapter.get("id") == item.get("plant_chapter")), None)
        planned_id = item.get("planned_harvest")
        planned_number = next((chapter.get("number") for chapter in chapters if chapter.get("id") == planned_id), None) if planned_id else None
        if planned_id and planned_number is None:
            error(errors, f"foreshadowing[{index}].planned_harvest does not exist")
        if isinstance(plant_number, int) and isinstance(planned_number, int) and planned_number < plant_number:
            error(errors, f"foreshadowing[{index}].planned_harvest must not precede plant_chapter")
        actual_id = item.get("actual_harvest")
        actual_number = next((chapter.get("number") for chapter in chapters if chapter.get("id") == actual_id), None) if actual_id else None
        if actual_id and actual_number is None:
            error(errors, f"foreshadowing[{index}].actual_harvest does not exist")
        if isinstance(plant_number, int) and isinstance(actual_number, int) and actual_number < plant_number:
            error(errors, f"foreshadowing[{index}].actual_harvest must not precede plant_chapter")
        history = foreshadowing_history.get(item.get("id"), [])
        if isinstance(plant_number, int):
            plant_ops = [number for number, _, action in history if action == "plant"]
            if plant_ops and min(plant_ops) != plant_number:
                error(errors, f"foreshadowing[{index}].plant_chapter must match its plant operation")
            if any(number < plant_number for number, _, _ in history):
                error(errors, f"foreshadowing[{index}] has an operation before plant_chapter")
        reap_numbers = [number for number, _, action in history if action == "reap"]
        if actual_number is not None and actual_number not in reap_numbers:
            error(errors, f"foreshadowing[{index}].actual_harvest must match a reap operation")
        if item.get("status") == "REAP" and not reap_numbers:
            error(errors, f"foreshadowing[{index}] status REAP requires a reap operation")

    for index, raw in enumerate(branches):
        item = mapping(raw, f"branch_nodes[{index}]", errors)
        fields(item, ["id", "chapter_id", "type", "decision", "selected", "alternatives", "selection_reason"], f"branch_nodes[{index}]", errors)
        if item.get("chapter_id") not in chapter_ids:
            error(errors, f"branch_nodes[{index}].chapter_id does not exist")
        if item.get("type") not in {"decision", "turning", "crisis"}:
            error(errors, f"branch_nodes[{index}].type is invalid")
        selected = mapping(item.get("selected"), f"branch_nodes[{index}].selected", errors)
        fields(selected, ["beats", "short_term", "mid_term", "long_term", "risks"], f"branch_nodes[{index}].selected", errors)
        if len(array(item.get("alternatives"), f"branch_nodes[{index}].alternatives", errors)) > 2:
            error(errors, f"branch_nodes[{index}] has more than two alternatives")

    if v13 and contracts is not None:
        vocab = axis_vocab(root, contracts, warnings)
        must_deliver = [str(item) for item in genre_profile.get("must_deliver", []) if isinstance(item, str)]
        check_axis_advance(chapters, ordered_chapters, vocab, must_deliver, chapter_ids, errors, warnings)
        check_genre_rules(
            root, contracts, ordered_chapters, volumes, numbers, foreshadowing, foreshadowing_history, lines, branches, vocab, errors, warnings
        )
        check_entity_ledger(root, ordered_chapters, errors, warnings)
        check_internal_anchors(root, chapter_ids, vocab, errors, warnings)
        check_commercial(root, ordered_chapters, outline_path, errors, warnings)
        check_foreshadowing_triggers(foreshadowing, chapter_ids, chapter_number_by_id, errors)
        check_hook_types(chapters, errors)
        check_break_abuse(ordered_chapters, warnings)

    if errors:
        print("INVALID OUTLINE")
        print("\n".join(f"- {item}" for item in errors))
        for item in warnings:
            print(f"WARN: {item}")
        return 1
    print("VALID OUTLINE")
    for item in warnings:
        print(f"WARN: {item}")
    return 0


if __name__ == "__main__":
    if len(sys.argv) not in {2, 4} or (len(sys.argv) == 4 and sys.argv[2] != "--setting-package"):
        print("Usage: validate_outline.py PATH_TO_01_大纲数据.json [--setting-package PATH_TO_MANIFEST_OR_DIR]")
        raise SystemExit(2)
    raise SystemExit(main(sys.argv[1], sys.argv[3] if len(sys.argv) == 4 else None))

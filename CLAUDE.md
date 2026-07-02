# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

This is a **网文工业化创作 OS** — a complete, 7-step AI-assisted novel writing pipeline optimized for the **Tomato Novel (番茄小说)** platform. 7 core skills + 4 extensions + 3 deterministic scripts form an industrial-grade assembly line.

**Three layers**: 基建层 (steps 0-2: 项目+世界观+宏观结构) → 生产层 (steps 3-4: 细纲+初稿) → 精装层 (steps 5-6: 精修+去AI味).

## Seven-Step Pipeline Architecture

```
┌──────────────────────────────────────────────────────────────┐
│               网文工业化创作 OS · 七步流水线                     │
├────┬───────────────────┬─────────────────────────────────────┤
│步骤│ 技能               │ 核心产出                             │
├────┼───────────────────┼─────────────────────────────────────┤
│ 0  │ 项目初始化师        │ 标准目录结构 + 上下文管理模板           │
│ 1  │ 小说设定架构师      │ 世界观/人设/JSON元数据                │
│ 2  │ 小说大纲构建师      │ 宏观大纲/情绪曲线/核心卖点             │
│ 3  │ 细纲编写技能        │ 逐章细纲/衔接包链/黄金三章（滚动建纲）  │
│ 4  │ 细纲扩写执行系统    │ 初稿·骨架血肉·自检修正                │
│ 5  │ 小说正文精修师      │ 精修·灵魂质感·潜台词·金句·风格注入     │
│ 6  │ 去AI味精修师        │ 深度去AI味·11 Gate系统·确定性脚本兜底  │
├────┼───────────────────┼─────────────────────────────────────┤
│扩展│ 拆文/导入/短篇/审稿  │ 独立于主流水线，任意阶段可调用         │
└────┴───────────────────┴─────────────────────────────────────┘
```

### Layer Architecture

| 层级 | 步骤 | 文件 | 版本 |
|------|------|------|------|
| **项目初始化** | 0 | `00.5_项目初始化.md` | V1.0 |
| **底层基建** | 1 | `00_小说设定架构师.md` | V3.2 |
| **宏观规划** | 2 | `01_小说大纲构建师.md` | V2.2 |
| **中观桥梁** | 3 | `02_细纲编写技能.md` | V4.3 |
| **初稿生产** | 4 | `03_细纲扩写执行系统.md` | V4.3 |
| **后期精装** | 5 | `04_小说正文精修师.md` | V4.3 |
| **人味儿质检** | 6 | `05_去AI味精修师.md` | V1.3 |
| **扩展：拆文** | — | `06_小说拆文师.md` | V2.0 |
| **扩展：导入** | — | `07_小说导入师.md` | V1.0 |
| **扩展：短篇** | — | `08_短篇写作技能.md` | V1.0 |
| **扩展：审稿** | — | `09_多视角审稿师.md` | V2.0 |
| **总控编排** | — | `SKILL.md` | V2.0 |

## Pipeline Flow

```
前置调研（可选）： 06(扫榜+拆文+对标) → 写入 对标/ 目录
一次性准备（全书1次）： 00.5 → 00 → 01 → 02(前10章细纲) → 进入写作
每章循环： 03(扩写) → 04(精修) → 05(去AI味+脚本兜底) → 取下一章细纲
每5章： 02(补纲5-10章) → 继续写作循环
可选扩展： 07(导入) ｜ 08(短篇) ｜ 09(审稿, full/lean/solo)
```

### Key Pipeline Rules

- **Step 3 supports rolling outline**: 先建前10章，每写5章补5-10章（全书≤30章可一次全建）
- **Step 6 has 11 Gate + engineering protection**: 白名单/分级执行/删除上限/确定性脚本兜底
- **Every 5 chapters**: review 衔接包禁止矛盾链 and 伏笔追踪表 for drift

## File Map

| Step | File | Version | When |
|------|------|---------|------|
| 0 | `00.5_项目初始化.md` | V1.0 | Once per book (new) |
| 1 | `00_小说设定架构师.md` | V3.2 | Once per book |
| 2 | `01_小说大纲构建师.md` | V2.2 | Once per book |
| 3 | `02_细纲编写技能.md` | V4.3 | Rolling outline |
| 4 | `03_细纲扩写执行系统.md` | V4.3 | Per chapter |
| 5 | `04_小说正文精修师.md` | V4.3 | Per chapter |
| 6 | `05_去AI味精修师.md` | V1.3 | Per chapter (11 Gate + scripts) |
| — | `06_小说拆文师.md` | V2.0 | Optional, before step 2 (扫榜+对标) |
| — | `07_小说导入师.md` | V1.0 | Optional, import existing work |
| — | `08_短篇写作技能.md` | V1.0 | Short-form (<15K words) |
| — | `09_多视角审稿师.md` | V2.0 | Optional, quality check (full/lean/solo) |
| — | `SKILL.md` | V2.0 | Orchestrator |

### Supporting Directories

- `references/`: 6 language libraries + 统一索引 + 5 detectors + 3 methodology files
- `scripts/`: 3 deterministic Node.js scripts (check-ai-patterns / check-degeneration / normalize-punctuation)
- `hooks/`: 5 PowerShell hooks (session-start / session-end / detect-story-gaps / pre-compact / guard-outline)

## Non-Obvious Contracts

| Contract | Detail |
|----------|--------|
| **衔接包 ownership** | ONLY step 2 (细纲) produces 衔接包. Step 3 (扩写) reads only. No other step modifies. |
| **03/04/05 boundary** | 03 = skeleton+flesh (plot, logic, word count). 04 = soul+texture (subtext, gold sentences, style). 05 = AI-likeness check (11 Gate system + engineering protection). 05 does NOT redo 03/04 work. |
| **JSON metadata** | Step 0 (00.5) produces canonical JSON (character names, etc.). All downstream skills must stay consistent. |
| **Mode switching** | Prefix any skill with `/mode_full`, `/mode_assisted` (default), or `/mode_hardcore` to adjust behavior. |
| **Rolling outline** | Step 3 defaults to rolling outline. Use `/mode_full` for one-shot full outline. |
| **Script precheck** | Step 6 and Step 9 (审稿) run deterministic scripts before LLM review. Blocking findings must be zeroed. |

## Key Constraints (Easy to Miss)

- **Word count**: 3500-4500 Chinese chars/chapter (4000±500)
- **Dialogue ratio**: ≤60%
- **Punctuation limits** (step 5): 省略号≤5, 破折号≤4, 感叹号≤15 per chapter
- **Scenes per chapter**: 3-5, classified as core(1200-1800) / important(800-1200) / transitional(400-800) / accent(200-400)
- **Hook types**: 13 chapter-end + 7 chapter-start. No repeat in 3 consecutive chapters.
- **Sensory priority**: touch/smell > hearing > vision
- **Gate system**: 11 Gates (Gate 1-10 + Gate 11: 解释腔/上帝感/安排感)

## Cross-Platform Support

| 平台 | 配置目录 | Skill 安装位置 | Hook 格式 |
|------|---------|--------------|-----------|
| **OpenCode**（默认） | `.opencode/` | `~/.config/opencode/skills/` | `.ps1` / `.sh` |
| **Claude Code** | `.claude/` | `.claude/skills/` | `.sh`（bash） |
| **Codex** | `.codex/` | `.codex/skills/` | `.sh`（bash） |
| **Trae** | `.trae/` | `.trae/skills/` | `.ps1` / `.sh` |

## Deterministic Scripts (`scripts/`)

| Script | Function | Severity |
|--------|----------|----------|
| `check-ai-patterns.js` | 否定翻转/破折号/碎句号/长段落 | blocking + advisory |
| `check-degeneration.js` | 逐字复读/截断/占位符/工程词泄漏 | blocking + advisory |
| `normalize-punctuation.js` | 标点规范化（省略号/破折号/markdown分隔线） | advisory |

All scripts are **report-only** — they never rewrite text. LLM reads reports and fixes.

## Hooks (`hooks/`)

| File | Type | Trigger |
|------|------|---------|
| `session-start.ps1` | Info | New session start |
| `session-end.ps1` | Info | Session end |
| `detect-story-gaps.ps1` | Inspection | Auto-called by session-start |
| `pre-compact.ps1` | Save | Before context compaction |
| `guard-outline-before-prose.ps1` | **Blocking** | Before writing prose (exit 1 if no outline) |

## Cross-Session Continuity

`上下文管理模板.md` tracks book state across sessions. Update it every session with:
- current chapter progress, character states, active foreshadowing
- next task for resume

## Repo Notes

- **No build/test system** — this is a collection of prompt files + Node.js scripts
- **`.claude/`** directory contains Claude Code local settings
- **Cross-platform**: skill files are platform-agnostic; hooks/settings per platform
- **Language libraries** (`references/`): 6 libraries + 统一索引 + 5 detectors + 3 methodology files

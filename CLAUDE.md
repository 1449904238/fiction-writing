# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

This is a **网文工业化创作 OS** (V5.2) — a complete, 7-step AI-assisted novel writing pipeline optimized for the **Tomato Novel (番茄小说)** platform. 7 core skills (02 拆分为 02a+02b，03 拆分为 03a+03b) + 4 extensions + 9 deterministic scripts + 1 shared module + 6+ hooks form an industrial-grade assembly line.

**Three layers**: 基建层 (steps 0-2: 项目+世界观+宏观结构) → 生产层 (steps 3-4: 细纲+初稿) → 精装层 (steps 5-6: 精修+去AI味).

## Seven-Step Pipeline Architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│               网文工业化创作 OS · 七步流水线 (V5.2)                       │
├────┬───────────────────┬─────────────────────────────────────────────┤
│步骤│ 技能               │ 核心产出                                     │
├────┼───────────────────┼─────────────────────────────────────────────┤
│ 0  │ 项目初始化师        │ 标准目录结构 + 上下文管理模板                   │
│ 1  │ 小说设定架构师      │ 世界观/人设/JSON元数据                        │
│ 2  │ 小说大纲构建师      │ 宏观大纲/情绪曲线/核心卖点/INC 13要素          │
│ 3a │ 细纲生成(02a)       │ 逐章细纲/衔接包链/黄金三章（滚动建纲）          │
│ 3b │ 细纲质检(02b)       │ 大纲五检/7项质量Gate/衔接包P0P1校验           │
│ 4a │ 扩写执行(03a)       │ 初稿·骨架血肉·P0预检+19项终检                 │
│ 4b │ 质量自检(03b)       │ 质检·P1/P2抽查·5维Gate评分·流程路由(每章必执行) │
│ 5  │ 小说正文精修师(04)  │ 精修·灵魂质感·潜台词·金句·风格注入              │
│ 5b │ 深度打磨(04b)       │ 04+05合并单步·7 Gate（/flow_fast, ≥80分时）    │
│ 6  │ 去AI味精修师(05)    │ 深度去AI味·11 Gate系统·确定性脚本兜底           │
├────┼───────────────────┼─────────────────────────────────────────────┤
│扩展│ 拆文/导入/短篇/审稿/反馈│ 独立于主流水线，任意阶段可调用               │
└────┴───────────────────┴─────────────────────────────────────────────┘
```

### Layer Architecture

| 层级 | 步骤 | 文件 | 版本 |
|------|------|------|------|
| **项目初始化** | 0 | `00.5_项目初始化.md` | V1.0 |
| **底层基建** | 1 | `00_小说设定架构师.md` | V2.6 |
| **宏观规划** | 2 | `01_小说大纲构建师.md` | V2.5 |
| **中观桥梁-生成** | 3a | `02a_细纲生成.md` | V5.2.0 |
| **中观桥梁-质检** | 3b | `02b_细纲质检.md` | V5.2.0 |
| **初稿生产** | 4a | `03a_扩写执行.md` | V5.2.0 |
| **初稿质检** | 4b | `03b_质量自检.md` | V5.2.0 |
| **后期精装** | 5 | `04_小说正文精修师.md` | V5.2.0 |
| **快速精装** | 5b | `04b_深度打磨.md` | V5.2.0 |
| **人味儿质检** | 6 | `05_去AI味精修师.md` | V1.7 |
| **扩展：拆文** | — | `06_小说拆文师.md` | V5.1 |
| **扩展：导入** | — | `07_小说导入师.md` | V2.0 |
| **扩展：短篇** | — | `08_短篇写作技能.md` | V2.1 |
| **扩展：审稿** | — | `09_多视角审稿师.md` | V5.2.0 |
| **扩展：读者反馈** | — | `10_读者反馈注入师.md` | V2.0 |
| **总控编排** | — | `SKILL.md` | V5.2.0 |

## Pipeline Flow

```
前置调研（可选）： 06(扫榜+3维度拆文+对标, V5.1手动优先) → 写入 对标/ 目录
一次性准备（全书1次）： 00.5 → 00 → 01(+INC Gate) → 02a(前10章细纲) + 02b(质检) → 进入写作
每章循环（V5.2三种流程）：
  /flow_full:  03a(扩写) → 03b(质检,必执行) → 04(精修V5.2) → 05(去AI味) → 脚本收尾
  /flow_fast:  03a(扩写) → 03b(质检,必执行) → 04b(深度打磨V5.2) → 脚本收尾
  /flow_raw:   03a(扩写) → 03b(质检,必执行) → 05精简版 → 脚本收尾
每3章： 02a(补纲) + 02b(质检) + 09(4-Agent审稿) → 继续写作循环
每卷结束： 02a(卷末归档: 衔接包压缩+伏笔清理+角色状态精简) → 10(读者反馈注入, 可选)
可选扩展： 07(导入) ｜ 08(短篇) ｜ 10(读者反馈)
```

### Key Pipeline Rules

- **V5.2: 02拆分为02a(细纲生成)+02b(细纲质检)**：生成与质检分离到不同上下文，衔接包P0/P1字段分级
- **V5.2: 03b每章必执行**：无论哪种流程，03b均为必经环节，评分决定走快速通道(≥80)还是完整流程(60-79)或重写(<60)
- **V5.2: 审稿频率从每5章改为每3章**：第3/6/9/12...章后触发09多视角审稿
- **Step 3 (02a) supports rolling outline**: 先建前10章，每写3章补5-10章（全书≤30章可一次全建）
- **Step 3 (02a) supports 衔接包归档**: 超10章的旧衔接包自动压缩为摘要，防止上下文膨胀
- **Step 6 (05) has 11 Gate + engineering protection**: 白名单/分级执行/删除上限/确定性脚本兜底
- **Mode switching**: `/mode_full`, `/mode_assisted` (default), `/mode_hardcore` 控制 AI 自主度（行为模式）. `/flow_full` (default), `/flow_fast`, `/flow_raw` 控制流水线步骤数（写作流程）. 两组正交可组合.

## File Map

| Step | File | Version | When |
|------|------|---------|------|
| 0 | `00.5_项目初始化.md` | V1.0 | Once per book (new) |
| 1 | `00_小说设定架构师.md` | V2.6 | Once per book |
| 2 | `01_小说大纲构建师.md` | V2.5 | Once per book (+INC Gate) |
| 3a | `02a_细纲生成.md` | V5.2.0 | Rolling outline (V5.2拆分) |
| 3b | `02b_细纲质检.md` | V5.2.0 | After 02a each batch (V5.2拆分) |
| — | `02_细纲编写技能.md` | 存档 | V5.2由02a+02b替代 |
| 4a | `03a_扩写执行.md` | V5.2.0 | Per chapter (V5.1拆分) |
| 4b | `03b_质量自检.md` | V5.2.0 | Per chapter, **必执行** (V5.2) |
| — | `03_细纲扩写执行系统.md` | 存档 | V5.1由03a+03b替代 |
| 5 | `04_小说正文精修师.md` | V5.2.0 | Per chapter (/flow_full) |
| 5b | `04b_深度打磨.md` | V5.2.0 | Per chapter (/flow_fast, ≥80分) |
| 6 | `05_去AI味精修师.md` | V1.7 | Per chapter (11 Gate + scripts) |
| — | `06_小说拆文师.md` | V5.1 | Optional, before step 2 (扫榜+3维度拆文) |
| — | `07_小说导入师.md` | V2.0 | Optional, import existing work (V5.2机制+JSON Schema对齐) |
| — | `08_短篇写作技能.md` | V2.1 | Short-form (8K-15K) / Mid-form (15K-30K分段) |
| — | `09_多视角审稿师.md` | V5.2.0 | Every 3 chapters (V5.2, 5 Agent mandatory) |
| — | `10_读者反馈注入师.md` | V2.0 | Optional, per-volume (三级降级链+Findings Schema) |
| — | `SKILL.md` | V5.2.0 | Orchestrator |

### Supporting Directories

- `references/`: 6 language libraries + 9 extended libraries + 5 综合文件 + scene-trigger-map(唯一索引) + 3 methodology files
- `scripts/`: 9 deterministic Node.js scripts + `lib/prose-utils.js` (shared module)
- `hooks/`: 6+ hooks (session-start / session-end / detect-story-gaps / pre-compact / guard-outline / check-prose-after-write / chapter-counter)
- `.claude/agents/` + `.trae/agents/`: 5 Agent定义文件双部署 (story-editor / ai-detector / quality-checker / reader-agent / commercial-agent)

## Non-Obvious Contracts

| Contract | Detail |
|----------|--------|
| **衔接包 ownership** | ONLY step 02a (细纲生成) produces 衔接包. Step 03a (扩写) reads only. No other step modifies. P0/P1字段分级(V5.2). |
| **02a/02b/03a/03b/04/04b/05 boundary (V5.2)** | 02a = 细纲生成. 02b = 细纲质检(大纲五检+7项Gate). 03a = skeleton+flesh (plot, logic, word count). 03b = 质量自检(P1/P2+5维评分+流程路由, **每章必执行**). 04 = soul+texture (subtext, gold sentences, style). 04b = 04+05 merged for /flow_fast (7 Gate). 05 = AI-likeness check (11 Gate). 单一责任人制度：心理直给/解释腔→04唯一执行点, 意象重复/信息含金量→03a唯一执行点, 05改为抽样复核. |
| **题材模块选择 (v3.0)** | 00设定架构师根据novel_meta.genre自动启用/禁用设定模块. 非玄幻题材跳过战力矩阵, check-consistency.js动态选择检测模式. |
| **JSON metadata** | Step 0 (00.5) produces canonical JSON (character names, etc.). All downstream skills must stay consistent. |
| **Mode switching (V5.2)** | `/mode_full`, `/mode_assisted` (default), `/mode_hardcore` 控制 AI 自主度（行为模式）. `/flow_full` (default), `/flow_fast`, `/flow_raw` 控制流水线步骤数（写作流程）. 两组正交可组合, 如 `/mode_assisted /flow_fast`. |
| **用户情绪锚点 (V5.1)** | 02细纲新增"用户情绪锚点"字段（大纲五检第6问），03a扩写时须作为情绪工程首要目标，check-emotion-density.js 用 --anchor 参数验证交付. |
| **INC 13要素 (V5.1)** | 01大纲每卷≥6项(终卷≥8项), 02细纲每章≥3项(过场章≥2项). 质量Gate在01/02产出后必检. |
| **Script precheck** | Step 03b, Step 6 and Step 9 (审稿) run deterministic scripts before LLM review. Blocking findings must be zeroed. |

## Key Constraints (Easy to Miss)

- **Word count**: 3500-4500 Chinese chars/chapter (4000±500)
- **Dialogue ratio**: ≤60%
- **Punctuation limits** (step 04): 省略号≤5, 破折号≤4, 感叹号≤15 per chapter
- **Scenes per chapter**: 3-5, classified as core(1200-1800) / important(800-1200) / transitional(400-800) / accent(200-400)
- **Hook types**: 13 chapter-end + 7 chapter-start. No repeat in 3 consecutive chapters.
- **Sensory approach (V4.1 abolished global priority)**: 二分法 — 日常极简白描 / 核心多维叠加. No global priority — visual-only openings flagged as AI-like.
- **Gate system**: 11 Gates (Gate 1-10 + Gate 11: 解释腔/上帝感/安排感)
- **04b Gate system (V5.2)**: 7 Gates (合并04精修+05去AI味核心检测)

## Cross-Platform Support

| 平台 | 配置目录 | Skill 安装位置 | Agent 部署 | Hook 格式 |
|------|---------|--------------|-----------|-----------|
| **OpenCode**（默认） | `.opencode/` | `~/.config/opencode/skills/` | 主线程降级 | `.ps1` / `.sh` |
| **Claude Code** | `.claude/` | `.claude/skills/` | `.claude/agents/`（5个） | `.sh`（bash） |
| **Codex** | `.codex/` | `.codex/skills/` | 主线程降级 | `.sh`（bash） |
| **Trae** | `.trae/` | `.trae/skills/` | `.trae/agents/`（5个，与.claude/对等） | `.ps1` / `.sh` |

## Deterministic Scripts (`scripts/`)

9 scripts + 1 shared module. All scripts are **report-only** — they never rewrite text. LLM reads reports and fixes.

| Script | Function | Severity |
|--------|----------|----------|
| `check-ai-patterns.js` | 否定翻转/破折号/碎句号/长段落/burstiness突发度 | blocking + advisory |
| `check-degeneration.js` | 逐字复读/截断/占位符/工程词泄漏 | blocking + advisory |
| `normalize-punctuation.js` | 标点规范化（省略号/破折号/markdown分隔线） | advisory |
| `check-consistency.js` | 数值一致性/战力链/角色名精确匹配（配置驱动） | blocking + advisory |
| `check-rhythm.js` | 奖励间隔/节奏崩塌/情绪平坦/比例失衡/缺失钩子/句长方差 | advisory |
| `extract-used-patterns.js` | 提取已用句式清单供下章喂入闭环（V5.1） | info |
| `compress-handoff.js` | 超10章旧衔接包自动压缩为摘要（V5.1） | info |
| `sync-versions.js` | 跨文件版本号同步检查（V5.1） | info |
| `check-emotion-density.js` | 情绪锚点密度/情绪词残留/情绪反差（V5.2降级为advisory） | advisory |
| `lib/prose-utils.js` | **共享模块**：公共函数库（V5.2新增，角色名精确匹配） | — |

## Hooks (`hooks/`)

6+ hooks (each has .ps1 and .sh versions):

| File | Type | Trigger |
|------|------|---------|
| `session-start.ps1` | Info | New session start |
| `session-end.ps1` | Info | Session end |
| `detect-story-gaps.ps1` | Inspection | Auto-called by session-start |
| `pre-compact.ps1` | Save | Before context compaction |
| `guard-outline-before-prose.ps1` | **Blocking** | Before writing prose (exit 1 if no outline) |
| `check-prose-after-write.ps1` | **写后兜底** ⭐ | After prose saved (PostToolUse, exit 2 on blocking) |
| `chapter-counter.ps1` | Info | After each chapter (V5.2新增, 触发每3章审稿提醒) |

## Agents (`.claude/agents/` + `.trae/agents/`)

5 independent Agent definitions, dual-deployed to Claude Code and Trae:

| Agent | Role | Scoring |
|-------|------|---------|
| `story-editor.md` | 编辑视角审稿（审美基准：猫腻/烽火戏诸侯） | 0-100 |
| `ai-detector.md` | AI味鉴定（11 Gate检测） | 0-100 |
| `quality-checker.md` | 对抗性质检（V5.2每章必执行） | 0-100 |
| `reader-agent.md` | 读者视角（爽感权重5%→15%） | 0-100 |
| `commercial-agent.md` | 商业化视角（签约/流量/长线价值） | 0-100 |

> Agent unavailable → degrade to main thread solo mode (09's `solo` mode). 评分体系统一为 0-100 分制（V5.2）.

## Cross-Session Continuity

`上下文管理模板.md` tracks book state across sessions. Update it every session with:
- current chapter progress, character states, active foreshadowing
- next task for resume

## Repo Notes

- **No build/test system** — this is a collection of prompt files + Node.js scripts
- **`.claude/`** directory contains Claude Code local settings + 5 Agent definitions
- **Cross-platform (V5.2 Agent双部署)**: skill files are platform-agnostic; hooks/settings per platform; Agents dual-deployed to `.claude/agents/` and `.trae/agents/`
- **Language libraries** (`references/`): 6 libraries + 9 extended + 5 综合文件 + scene-trigger-map(唯一索引) + 3 methodology files
- **V5.1 references合并**: 14个分散文件合并为5个综合文件，scene-trigger-map.md为唯一索引
- **V5.2 references清理**: 删除5个原始检测器文件，scene-trigger-map为唯一索引

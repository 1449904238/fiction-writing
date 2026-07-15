# Hooks 使用指南

> V2.2 — 跨平台 hook parity + 写后自动兜底 + 跨章节奏检测。对标 oh-story-claudecode 的三端 hook 一致性（.sh/.ps1/.py）。
> 本地提供 **8 个 hook × 2 格式（.ps1 Windows / .sh Linux-Mac）+ 1 个 Codex Python 适配器**，零漂移覆盖 OpenCode/Claude Code/Codex/Trae 四端。

## Hook 清单（8 个）

| 文件 | 类型 | 触发时机 | 说明 |
|------|------|---------|------|
| `session-start.ps1/.sh` | 信息型 | 新会话启动时 | 加载上下文模板、输出进度快照、断点续跑检查清单 |
| `session-end.ps1/.sh` | 信息型 | 会话结束时 | 更新上下文模板、追加项目日志 |
| `detect-story-gaps.ps1/.sh` | 巡检型 | 会话启动时（建议随 session-start） | 自动巡检设定缺口、大纲缺失、伏笔断线、细纲覆盖 |
| `pre-compact.ps1/.sh` | 保存型 | 上下文压缩前 | 自动保存进度快照到 `追踪/compact-snapshots/` |
| `guard-outline-before-prose.ps1/.sh` | **阻断型** | 写正文前 | 检查对应章节细纲是否存在，缺则阻止（exit 1） |
| `check-prose-after-write.ps1/.sh` | **写后兜底**（v2.1新增） ⭐**推荐默认启用** | 正文落盘后（PostToolUse） | 自动运行3个确定性脚本，报告 blocking 级 finding（截断/复读/工程词/否定翻转/字数欠账） |
| `check-rhythm-cross-chapter.ps1/.sh` | **跨章节奏**（v2.2新增） | 每5章完成时 | 自动收集最近5章，调用check-rhythm.js检测爽点间隔/节奏塌陷/情绪平坦，报告写入`追踪/节奏检测_第N-M章.md` |
| `chapter-counter.ps1/.sh` | 信息型 | session-start（会话启动时） | 扫描正文目录统计已完成章节数，每3章提醒审稿/补纲，每10章提醒衔接包归档/伏笔检查，输出进度看板 |

> Codex 端用 `.codex/hooks/story_codex_hook.py`（Python 适配器，因 Codex 无 PostToolUse，改用 Stop 触发）。
> `chapter-counter` 为纯 shell 脚本，无外部依赖，可被 session-start 调用或独立运行。
> `check-rhythm-cross-chapter` 可手动调用（`powershell -File hooks/check-rhythm-cross-chapter.ps1 .`），也可配置为每5章自动触发。

---

## ⚠️ 推荐默认启用：check-prose-after-write

> **这是写后质量兜底的关键 hook，建议在项目初始化时立即配置。**
>
> 该 hook 在正文落盘后自动运行 3 个确定性脚本（check-ai-patterns / check-degeneration / normalize-punctuation），能在 AI 写完正文的瞬间拦截截断、复读、工程词、否定翻转、字数欠账等 blocking 级问题。**不配置 = 裸奔写作**，AI 味和质量问题可能积累到后期才发现，返工成本极高。

### 一键启用（三平台最简配置）

复制以下配置到对应平台的 hook 配置文件即可启用，无需额外操作：

**Claude Code**（写入 `.claude/settings.local.json`）：
```json
{
  "hooks": {
    "PostToolUse": "bash fiction-writing/hooks/check-prose-after-write.sh ${PROJECT_PATH} ${TOOL_FILE_PATH}"
  }
}
```

**OpenCode**（写入 `opencode.json`）：
```json
{
  "hooks": {
    "tool.execute.after": ["powershell", "-File", "hooks/check-prose-after-write.ps1", "-ProjectPath", "${PROJECT_PATH}", "-FilePath", "${TOOL_FILE_PATH}"]
  }
}
```

**Trae**（写入 `.trae/config.json`）：
```json
{
  "hooks": {
    "postToolUse": "powershell -File fiction-writing/hooks/check-prose-after-write.ps1 -ProjectPath ${PROJECT_PATH} -FilePath ${TOOL_FILE_PATH}"
  }
}
```

> 配置完成后，每次 AI 写完正文文件自动触发，exit 0 = 无 blocking，exit 2 = 有 blocking 需回 05 去AI味或重新生成。

---

## 📊 章节计数与进度看板：chapter-counter

> **会话启动时自动统计章节数，按节奏提醒审稿/补纲/归档。**
>
> 该 hook 扫描正文目录（优先 `正文/终稿/`，回退 `正文/`），统计已完成章节数，并输出进度看板和阶段性提醒。无外部依赖（纯 shell 脚本，不依赖 node.js），可被 session-start 调用或独立运行。

### 功能说明

| 触发条件 | 提醒内容 |
|---------|---------|
| 章节数为 3 的倍数（3, 6, 9, 12...） | 09 多视角审稿 / 02a 补纲 / 02b 细纲质检 |
| 章节数为 10 的倍数（10, 20, 30...） | 额外提醒：衔接包归档 / 伏笔追踪表检查 |

进度看板输出示例：
```
📊 项目进度看板
├── 已完成章节：12 章
├── 当前卷：第2卷（根据 12/10 估算）
├── 距下次审稿：0 章
└── 细纲存量：3 章（细纲 15 - 正文 12）
```

### 配置方式

与 session-start hook 相同的配置方式，可独立配置或被 session-start 调用：

**Claude Code**（`.claude/settings.local.json`）：
```json
{
  "hooks": {
    "SessionStart": "powershell -File fiction-writing/hooks/chapter-counter.ps1 -ProjectPath ${PROJECT_PATH}"
  }
}
```

**OpenCode**（`opencode.json`）：
```json
{
  "hooks": {
    "session-start": ["powershell", "-File", "hooks/chapter-counter.ps1", "-ProjectPath", "${PROJECT_PATH}"]
  }
}
```

**Trae**（`.trae/config.json`）：
```json
{
  "hooks": {
    "session-start": "powershell -File fiction-writing/hooks/chapter-counter.ps1 -ProjectPath ${PROJECT_PATH}"
  }
}
```

> **不与 session-start 冲突**：chapter-counter 是独立脚本，可单独配置为 SessionStart hook，也可在 session-start 脚本中通过调用方式串联（类似 session-start 调用 detect-story-gaps 的模式）。
> **正文目录不存在时静默退出**（exit 0），不报错，不影响其他 hook。

---

## 跨平台 Hook Parity（v2.1 新增）

不同平台 hook 触发机制不同，本 skill 提供一致性兜底：

| 平台 | 写后兜底触发 | SessionStart | PreCompact | 配置目录 |
|------|------------|-------------|-----------|---------|
| **OpenCode** | `tool.execute.after` | ✅ | ✅ | `.opencode/` |
| **Claude Code** | `PostToolUse`（最强） | ✅ | ✅ | `.claude/settings.local.json` |
| **Codex** | `Stop`（无 PostToolUse，对 git 改动正文兜底） | ✅ | ✅ | `.codex/hooks/` |
| **Trae** | `.ps1`/`.sh` hook | ✅ | ✅ | `.trae/` |

**降级链**：平台不支持自动 hook → 手动调用脚本（见下方方式A）。

## 使用方式

### 方式A：手动调用（所有平台通用）

**会话启动**（建议连续执行三个）：
```powershell
# Windows
.\hooks\session-start.ps1 -ProjectPath "C:\Users\xxx\Desktop\小说\书名"
.\hooks\detect-story-gaps.ps1 -ProjectPath "C:\Users\xxx\Desktop\小说\书名"
.\hooks\chapter-counter.ps1 -ProjectPath "C:\Users\xxx\Desktop\小说\书名"
```
```bash
# Linux/Mac
./hooks/session-start.sh --project-path "/path/to/书名"
./hooks/detect-story-gaps.sh --project-path "/path/to/书名"
./hooks/chapter-counter.sh --project-path "/path/to/书名"
```

**写正文前**（阻断型）：
```powershell
.\hooks\guard-outline-before-prose.ps1 -ProjectPath "..." -Chapter 5
```
- 第5章细纲存在 → exit 0，继续写作
- 第5章细纲缺失 → exit 1，阻止写作

**正文落盘后**（写后兜底，v2.1新增）：
```powershell
.\hooks\check-prose-after-write.ps1 -ProjectPath "..." -FilePath "正文/第005章_章名.md"
```
```bash
./hooks/check-prose-after-write.sh "/path/to/project" "正文/第005章_章名.md"
```
- exit 0：无 blocking
- exit 2：有 blocking（否定翻转/破折号/复读/截断/工程词），建议回 05 去AI味或重新生成

### 方式B：平台 Hook 集成（自动触发）

**Claude Code**（`.claude/settings.local.json`，推荐 PostToolUse）：
```json
{
  "hooks": {
    "PostToolUse": "bash fiction-writing/hooks/check-prose-after-write.sh ${PROJECT_PATH} ${TOOL_FILE_PATH}",
    "SessionStart": "bash fiction-writing/hooks/session-start.sh --project-path ${PROJECT_PATH}",
    "PreCompact": "bash fiction-writing/hooks/pre-compact.sh --project-path ${PROJECT_PATH}"
  }
}
```

**OpenCode**（opencode.json）：
```json
{
  "hooks": {
    "session-start": ["powershell", "-File", "hooks/session-start.ps1", "-ProjectPath", "${PROJECT_PATH}"],
    "tool.execute.after": ["powershell", "-File", "hooks/check-prose-after-write.ps1", "-ProjectPath", "${PROJECT_PATH}", "-FilePath", "${TOOL_FILE_PATH}"]
  }
}
```

**Codex**（`.codex/config.toml`，用 Python 适配器）：
```toml
[hooks]
SessionStart = ".codex/hooks/story_codex_hook.py --event session-start --project-path ${PROJECT_PATH}"
Stop = ".codex/hooks/story_codex_hook.py --event stop --project-path ${PROJECT_PATH}"
PreCompact = ".codex/hooks/story_codex_hook.py --event pre-compact --project-path ${PROJECT_PATH}"
```

**Trae**（`.trae/config.json`）：
```json
{
  "hooks": {
    "session-start": "powershell -File fiction-writing/hooks/session-start.ps1 -ProjectPath ${PROJECT_PATH}"
  }
}
```

> **chapter-counter 集成提示**：chapter-counter 可通过以下方式与 session-start 串联：
> - **方式1（推荐）**：在 session-start 脚本末尾追加调用 chapter-counter（类似 session-start 已调用 detect-story-gaps 的模式）
> - **方式2**：将 SessionStart 命令改为链式调用，如 `bash session-start.sh --project-path ${PROJECT_PATH}; bash chapter-counter.sh --project-path ${PROJECT_PATH}`
> - **方式3**：独立配置为单独的 hook 条目（如平台支持多个 SessionStart hook）

## 跨平台规则

1. 所有 skill 文件（.md）是平台无关的纯 prompt，任何 IDE 都可直接加载
2. hooks 按平台格式提供：Windows 用 `.ps1`，Linux/Mac 用 `.sh`，Codex 用 `.py`
3. `.codex/`、`.trae/`、`.claude/` 部署说明见各自目录下的 `skills/README.md`
4. settings 文件不跨平台覆盖——部署时只写当前平台的配置，保留用户已有配置
5. `check-prose-after-write` **推荐默认启用**（见上方"一键启用"章节），需手动配置到平台 hook 系统才生效；未配置时不影响其他 hook 的正常运行
6. `chapter-counter` 无外部依赖（纯 shell），正文目录不存在时静默退出（exit 0），可安全地被 session-start 调用或独立运行，不与其他 hook 冲突

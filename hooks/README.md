# Hooks 使用指南

> V2.1 — 跨平台 hook parity + 写后自动兜底。对标 oh-story-claudecode 的三端 hook 一致性（.sh/.ps1/.py）。
> 本地提供 **6 个 hook × 2 格式（.ps1 Windows / .sh Linux-Mac）+ 1 个 Codex Python 适配器**，零漂移覆盖 OpenCode/Claude Code/Codex/Trae 四端。

## Hook 清单（6 个）

| 文件 | 类型 | 触发时机 | 说明 |
|------|------|---------|------|
| `session-start.ps1/.sh` | 信息型 | 新会话启动时 | 加载上下文模板、输出进度快照、断点续跑检查清单 |
| `session-end.ps1/.sh` | 信息型 | 会话结束时 | 更新上下文模板、追加项目日志 |
| `detect-story-gaps.ps1/.sh` | 巡检型 | 会话启动时（建议随 session-start） | 自动巡检设定缺口、大纲缺失、伏笔断线、细纲覆盖 |
| `pre-compact.ps1/.sh` | 保存型 | 上下文压缩前 | 自动保存进度快照到 `追踪/compact-snapshots/` |
| `guard-outline-before-prose.ps1/.sh` | **阻断型** | 写正文前 | 检查对应章节细纲是否存在，缺则阻止（exit 1） |
| `check-prose-after-write.ps1/.sh` | **写后兜底**（v2.1新增） | 正文落盘后（PostToolUse） | 自动运行3个确定性脚本，报告 blocking 级 finding（截断/复读/工程词/否定翻转/字数欠账） |

> Codex 端用 `.codex/hooks/story_codex_hook.py`（Python 适配器，因 Codex 无 PostToolUse，改用 Stop 触发）。

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

**会话启动**（建议连续执行两个）：
```powershell
# Windows
.\hooks\session-start.ps1 -ProjectPath "C:\Users\xxx\Desktop\小说\书名"
.\hooks\detect-story-gaps.ps1 -ProjectPath "C:\Users\xxx\Desktop\小说\书名"
```
```bash
# Linux/Mac
./hooks/session-start.sh --project-path "/path/to/书名"
./hooks/detect-story-gaps.sh --project-path "/path/to/书名"
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

## 跨平台规则

1. 所有 skill 文件（.md）是平台无关的纯 prompt，任何 IDE 都可直接加载
2. hooks 按平台格式提供：Windows 用 `.ps1`，Linux/Mac 用 `.sh`，Codex 用 `.py`
3. `.codex/`、`.trae/`、`.claude/` 部署说明见各自目录下的 `skills/README.md`
4. settings 文件不跨平台覆盖——部署时只写当前平台的配置，保留用户已有配置
5. `check-prose-after-write` 默认不自动启用，需手动配置到平台 hook 系统才生效

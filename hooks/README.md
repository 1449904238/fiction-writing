# Hooks 使用指南

> V2.0 — 会话钩子 + 状态自动化 + 阻断型检查。对标 oh-story-claudecode 的 7 个自动化 Hook。

## Hook 清单

| 文件 | 类型 | 触发时机 | 说明 |
|------|------|---------|------|
| `session-start.ps1` | 信息型 | 新会话启动时 | 加载上下文模板、输出进度快照、断点续跑检查清单 |
| `session-end.ps1` | 信息型 | 会话结束时 | 更新上下文模板、追加项目日志 |
| `detect-story-gaps.ps1` | 巡检型 | 会话启动时（建议随 session-start 一起执行） | 自动巡检设定缺口、大纲缺失、伏笔断线、细纲覆盖 |
| `pre-compact.ps1` | 保存型 | 上下文压缩前 | 自动保存进度快照到 `追踪/compact-snapshots/` |
| `guard-outline-before-prose.ps1` | **阻断型** | 写正文前 | 检查对应章节细纲是否存在，缺则阻止（exit 1） |

## 使用方式

### 方式A：手动调用（推荐）

**会话启动**（建议连续执行两个）：
```powershell
.\hooks\session-start.ps1 -ProjectPath "C:\Users\xxx\Desktop\小说\书名"
.\hooks\detect-story-gaps.ps1 -ProjectPath "C:\Users\xxx\Desktop\小说\书名"
```

**上下文压缩前**：
```powershell
.\hooks\pre-compact.ps1 -ProjectPath "C:\Users\xxx\Desktop\小说\书名"
```

**写正文前**（阻断型）：
```powershell
.\hooks\guard-outline-before-prose.ps1 -ProjectPath "C:\Users\xxx\Desktop\小说\书名" -Chapter 5
```
- 如果第5章细纲存在 → exit 0，可以继续写作
- 如果第5章细纲缺失 → exit 1，阻止写作

**会话结束**：
```powershell
.\hooks\session-end.ps1 -ProjectPath "C:\Users\xxx\Desktop\小说\书名" -CompletedTask "完成了Ch.3初稿" -NextTask "从Ch.4精修开始" -CurrentChapter "第3章"
```

### 方式B：平台 Hook 集成

**OpenCode**（opencode.json）：
```json
{
  "hooks": {
    "session-start": ["powershell", "-File", "hooks/session-start.ps1", "-ProjectPath", "${PROJECT_PATH}"],
    "session-end": ["powershell", "-File", "hooks/session-end.ps1", "-ProjectPath", "${PROJECT_PATH}"]
  }
}
```

**Claude Code**（.claude/settings.local.json）：
```json
{
  "hooks": {
    "session-start": ["bash", "hooks/session-start.sh", "--project-path", "${PROJECT_PATH}"]
  }
}
```

> 跨平台：Linux/Mac 用 `.sh` 版本，Windows 用 `.ps1` 版本。

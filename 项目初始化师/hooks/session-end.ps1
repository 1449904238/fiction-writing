# session-end.ps1
# 会话结束钩子：自动保存进度到上下文管理模板和项目日志
# 在每次结束 OpenCode 会话前执行

param(
    [string]$ProjectPath = "",
    [string]$CompletedTask = "",
    [string]$NextTask = "",
    [string]$CurrentChapter = ""
)

if (-not $ProjectPath) {
    Write-Host "Usage: .\session-end.ps1 -ProjectPath `"C:\path\to\project`" [-CompletedTask `"完成了Ch.3初稿`"] [-NextTask `"从Ch.4精修开始`"] [-CurrentChapter `"第3章`"]"
    exit 1
}

$ContextFile = Join-Path -Path $ProjectPath -ChildPath "追踪\上下文管理模板.md"
$ProjectLog = Join-Path -Path $ProjectPath -ChildPath "项目日志.md"

# 上下文模板缺失 → 跳过进度更新，但会话日志仍照常追加（与 .sh 版本一致）
if (Test-Path -LiteralPath $ContextFile) {
    # 读取当前上下文
    $context = Get-Content -LiteralPath $ContextFile -Raw

    # 更新字段
    if ($CurrentChapter) {
        $context = $context -replace '(当前进度\s*\|\s*).+?(\s*\|)', "`$1$CurrentChapter`$2"
    }
    if ($CompletedTask) {
        $context = $context -replace '(上次会话结束状态\s*\|\s*).+?(\s*\|)', "`$1$CompletedTask`$2"
    }
    if ($NextTask) {
        $context = $context -replace '(下次会话起始任务\s*\|\s*).+?(\s*\|)', "`$1$NextTask`$2"
    }

    # 写入更新后的上下文
    $context | Set-Content -LiteralPath $ContextFile -NoNewline
    Write-Host "上下文管理模板已更新。"
} else {
    Write-Host "⚠️ 未找到 追踪/上下文管理模板.md，跳过进度更新（会话日志仍会追加）"
}

# 追加项目日志
$logEntry = @"
---

## 会话记录 $(Get-Date -Format 'yyyy-MM-dd HH:mm')

| 项目 | 内容 |
|------|------|
| 完成任务 | $CompletedTask |
| 当前章节 | $CurrentChapter |
| 下一步 | $NextTask |

"@

$logEntry | Out-File -FilePath $ProjectLog -Append

Write-Host "=== 会话结束：$(Get-Date -Format 'yyyy-MM-dd HH:mm') ==="
Write-Host "项目日志已追加。"
Write-Host "下次会话将从以下状态恢复："
Write-Host "  - 当前进度：$CurrentChapter"
Write-Host "  - 已完成：$CompletedTask"
Write-Host "  - 下一步：$NextTask"
exit 0

# session-start.ps1
# 会话启动钩子：自动加载上下文管理模板
# 在每次启动 OpenCode 新会话时执行

param(
    [string]$ProjectPath = ""
)

if (-not $ProjectPath) {
    Write-Host "Usage: .\session-start.ps1 -ProjectPath `"C:\path\to\project`""
    exit 1
}

$ContextFile = Join-Path -Path $ProjectPath -ChildPath "追踪\上下文管理模板.md"
$ProjectLog = Join-Path -Path $ProjectPath -ChildPath "项目日志.md"

# 1. 检查上下文管理模板是否存在
if (Test-Path -LiteralPath $ContextFile) {
    Write-Host "=== 会话启动：$(Get-Date -Format 'yyyy-MM-dd HH:mm') ===" | Out-File -FilePath $ProjectLog -Append
    Write-Host "已加载上下文管理模板：$ContextFile"
    
    # 输出模板摘要
    $context = Get-Content -LiteralPath $ContextFile -Raw
    Write-Host "`n--- 当前项目状态 ---"
    
    # 提取基本信息
    if ($context -match '书名\s*\|\s*(.+?)\s*\|') {
        Write-Host "书名：$($matches[1])"
    }
    if ($context -match '当前进度\s*\|\s*(.+?)\s*\|') {
        Write-Host "进度：$($matches[1])"
    }
    if ($context -match '上次会话结束状态\s*\|\s*(.+?)\s*\|') {
        Write-Host "上次状态：$($matches[1])"
    }
    if ($context -match '下次会话起始任务\s*\|\s*(.+?)\s*\|') {
        Write-Host "下一步：$($matches[1])"
    }
} else {
    Write-Host "警告：未找到上下文管理模板。"
    Write-Host "请先运行 00.5_项目初始化师 创建项目结构。"
}

Write-Host "`n=== 断点续跑检查清单 ==="
Write-Host "□ 当前章节状态检查了吗？"
Write-Host "□ 角色状态同步了吗？"
Write-Host "□ 伏笔追踪表更新了吗？"
Write-Host "□ 衔接包链完整吗？"

# 2. 自动调用 detect-story-gaps 巡检
Write-Host "`n=== 自动巡检 Story Gaps ==="
$gapScript = Join-Path -Path (Split-Path -Parent $MyInvocation.MyCommand.Path) -ChildPath "detect-story-gaps.ps1"
if (Test-Path -LiteralPath $gapScript) {
    & $gapScript -ProjectPath $ProjectPath
} else {
    Write-Host "提示：detect-story-gaps.ps1 不存在，跳过自动巡检"
}

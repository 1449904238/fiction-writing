# chapter-counter.ps1
# 章节计数钩子：扫描正文目录，统计已完成章节数，触发审稿/补纲/归档提醒
# 触发时机：session-start（会话启动时自动运行）或独立运行
# 依赖：无外部依赖（纯 PowerShell 脚本，不依赖 node.js）
#
# 配置方式（与 session-start hook 相同，可被 session-start 调用或独立运行）：
#   Claude Code (.claude/settings.local.json):
#     "SessionStart": "powershell -File fiction-writing/hooks/chapter-counter.ps1 -ProjectPath ${PROJECT_PATH}"
#   OpenCode (opencode.json):
#     "session-start": ["powershell", "-File", "hooks/chapter-counter.ps1", "-ProjectPath", "${PROJECT_PATH}"]
#   Trae (.trae/config.json):
#     "session-start": "powershell -File fiction-writing/hooks/chapter-counter.ps1 -ProjectPath ${PROJECT_PATH}"
#   手动调用:
#     .\hooks\chapter-counter.ps1 -ProjectPath "C:\path\to\project"
#
# 退出码约定：0=正常（含正文目录不存在时静默退出），2=扫描失败

param(
    [string]$ProjectPath = ""
)

if (-not $ProjectPath) {
    Write-Host "Usage: .\chapter-counter.ps1 -ProjectPath `"C:\path\to\project`""
    exit 1
}

# ── 1. 定位正文目录：优先 正文/终稿/，回退 正文/ ──
$proseFinalDir = Join-Path -Path $ProjectPath -ChildPath "正文\终稿"
$proseDir = Join-Path -Path $ProjectPath -ChildPath "正文"

$scanDir = $null
if (Test-Path -LiteralPath $proseFinalDir) {
    $scanDir = $proseFinalDir
} elseif (Test-Path -LiteralPath $proseDir) {
    $scanDir = $proseDir
} else {
    # 正文目录不存在，静默退出
    exit 0
}

# ── 2. 扫描 .md 文件，统计匹配章节命名的文件数 ──
# 匹配规则：第\d+章 | chapter | Ch\d+（同时支持中文"第1章"和英文"chapter_001"/"Ch001"命名）
$chapterCount = 0
try {
    $mdFiles = Get-ChildItem -LiteralPath $scanDir -Filter "*.md" -ErrorAction Stop
    foreach ($f in $mdFiles) {
        if ($f.Name -match '第\d+章|[Cc]hapter|[Cc]h\d+') {
            $chapterCount++
        }
    }
} catch {
    Write-Host "[chapter-counter] 扫描失败：$_" -ForegroundColor Red
    exit 2
}

# ── 3. 扫描细纲目录，计算细纲存量 ──
$outlineDir = Join-Path -Path $ProjectPath -ChildPath "细纲"
$outlineCount = 0
if (Test-Path -LiteralPath $outlineDir) {
    $outlineFiles = Get-ChildItem -LiteralPath $outlineDir -Filter "*.md" -ErrorAction SilentlyContinue
    foreach ($f in $outlineFiles) {
        if ($f.Name -match '第\d+章|[Cc]hapter|[Cc]h\d+') {
            $outlineCount++
        }
    }
}
$outlineStock = [math]::Max(0, $outlineCount - $chapterCount)

# ── 4. 计算进度信息 ──
# 当前卷：根据 N/10 估算（ceil(N/10)）
if ($chapterCount -gt 0) {
    $currentVolume = [int][math]::Ceiling($chapterCount / 10.0)
} else {
    $currentVolume = 0
}

# 距下次审稿：3的倍数触发，计算还需多少章到达下一个3的倍数
$chaptersToNextAudit = (3 - ($chapterCount % 3)) % 3

# ── 5. 输出进度看板 ──
Write-Host ""
Write-Host "📊 项目进度看板"
Write-Host "├── 已完成章节：$chapterCount 章"
if ($currentVolume -gt 0) {
    Write-Host "├── 当前卷：第${currentVolume}卷（根据 $chapterCount/10 估算）"
} else {
    Write-Host "├── 当前卷：尚未开始"
}
Write-Host "├── 距下次审稿：$chaptersToNextAudit 章"
Write-Host "└── 细纲存量：$outlineStock 章（细纲 $outlineCount - 正文 $chapterCount）"
Write-Host ""

# ── 6. 触发提醒：3的倍数（3, 6, 9, 12...）──
if ($chapterCount -gt 0 -and ($chapterCount % 3) -eq 0) {
    Write-Host "⚠️ 已写 $chapterCount 章，建议执行："
    Write-Host "  1. 09 多视角审稿（每3章必执行）"
    Write-Host "  2. 02a 补纲（如细纲不足5章存量）"
    Write-Host "  3. 02b 细纲质检（补纲后必执行）"
    Write-Host ""
}

# ── 7. 触发提醒：10的倍数（10, 20, 30...）──
if ($chapterCount -gt 0 -and ($chapterCount % 10) -eq 0) {
    Write-Host "⚠️ 已写 $chapterCount 章，额外建议："
    Write-Host "  4. 衔接包归档（compress-handoff.js 压缩旧衔接包）"
    Write-Host "  5. 伏笔追踪表检查（超20章未回收的伏笔需关注）"
    Write-Host ""
}

exit 0

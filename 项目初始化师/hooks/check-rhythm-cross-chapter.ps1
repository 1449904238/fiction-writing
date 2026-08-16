#!/usr/bin/env pwsh
# check-rhythm-cross-chapter.ps1 — 跨章节奏检测hook（V1.0新增，V2.0更新触发逻辑）
# 触发条件（V2.0更新）：当前章节数 - 上次检测章节数 >= 5 时触发（基于追踪记录差值，非总数取模）
# 执行逻辑：收集最近5章文件，按章节号排序，传入check-rhythm.js
# 输出：节奏检测报告写入 追踪/节奏检测_第N-M章.md
#
# 用法（手动触发）：powershell -File hooks/check-rhythm-cross-chapter.ps1 [项目根目录]

param(
    [string]$ProjectPath = "."
)

$ErrorActionPreference = "Stop"

# 定位正文/初稿目录
$DraftDir = Join-Path $ProjectPath "正文\初稿"
if (-not (Test-Path $DraftDir)) {
    # 尝试其他常见目录名
    $DraftDir = Join-Path $ProjectPath "正文"
    if (-not (Test-Path $DraftDir)) {
        Write-Host "[check-rhythm] 未找到正文目录（正文/初稿/ 或 正文/），跳过跨章节奏检测" -ForegroundColor Gray
        exit 0
    }
}

# 收集章节文件
$ChapterFiles = Get-ChildItem -Path $DraftDir -Filter "*.md" | Where-Object {
    $_.Name -match "第\d+章|chapter|正文" -or $_.Name -match "^\d+"
} | Sort-Object Name

$TotalChapters = $ChapterFiles.Count
if ($TotalChapters -lt 5) {
    Write-Host "[check-rhythm] 章节数 $TotalChapters < 5，无需跨章节奏检测" -ForegroundColor Gray
    exit 0
}

# ===== 触发条件检查（V2.0：基于追踪记录差值，非总数取模） =====
# 读取 追踪/rhythm-check-tracker.json 获取上次检测时的章节号
# 如果 当前章节号 - 上次检测章节号 >= 5，则触发检测并更新记录
# 如果没有追踪记录，默认从第5章开始触发

# 定义追踪目录和追踪文件（提前定义，后续报告写入也复用）
$TrackDir = Join-Path $ProjectPath "追踪"
if (-not (Test-Path $TrackDir)) {
    New-Item -ItemType Directory -Path $TrackDir -Force | Out-Null
}
$TrackerFile = Join-Path $TrackDir "rhythm-check-tracker.json"

# 读取上次检测的章节号
$LastCheckedChapter = 0
if (Test-Path $TrackerFile) {
    try {
        $TrackerData = Get-Content $TrackerFile -Raw -Encoding UTF8 | ConvertFrom-Json
        $LastCheckedChapter = [int]$TrackerData.last_checked_chapter
    } catch {
        Write-Host "[check-rhythm] 追踪记录格式异常，重置为0" -ForegroundColor Yellow
        $LastCheckedChapter = 0
    }
}

# 差值判断：当前章节数 - 上次检测章节数
$ChapterDelta = $TotalChapters - $LastCheckedChapter
if ($ChapterDelta -lt 5) {
    Write-Host "[check-rhythm] 当前 $TotalChapters 章 - 上次检测 $LastCheckedChapter 章 = $ChapterDelta < 5，跳过（每写完5章触发一次）" -ForegroundColor Gray
    exit 0
}

# 取最近5章
$RecentChapters = $ChapterFiles | Select-Object -Last 5
$ChapterPaths = $RecentChapters | ForEach-Object { $_.FullName }

$StartChapter = $RecentChapters[0].BaseName
$EndChapter = $RecentChapters[-1].BaseName

Write-Host "[check-rhythm] 检测第 $StartChapter ~ $EndChapter 章（共5章）的跨章节奏..." -ForegroundColor Cyan

# 定位node和脚本
$Node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $Node) {
    Write-Host "⚠ 警告：未检测到 node.js，跨章节奏检测被跳过" -ForegroundColor Yellow
    exit 0
}

$ScriptsDir = Join-Path $ProjectPath "fiction-writing\scripts"
if (-not (Test-Path $ScriptsDir)) {
    $ScriptsDir = Join-Path $ProjectPath "scripts"
}
$RhythmScript = Join-Path $ScriptsDir "check-rhythm.js"

if (-not (Test-Path $RhythmScript)) {
    Write-Host "[check-rhythm] 未找到 check-rhythm.js，跳过" -ForegroundColor Gray
    exit 0
}

# 执行检测
$Output = & $Node $RhythmScript --check $ChapterPaths 2>&1
$ExitCode = $LASTEXITCODE

# 输出结果
Write-Host ""
Write-Host "========== 跨章节奏检测报告 ==========" -ForegroundColor Cyan
Write-Host "范围：第 $StartChapter ~ $EndChapter 章" -ForegroundColor Cyan
Write-Host "=======================================" -ForegroundColor Cyan
Write-Host ""

if ($Output) {
    $Output | ForEach-Object { Write-Host $_ }
}

# 检查是否有blocking问题
$HasBlocking = $false
if ($Output -match "blocking") {
    $HasBlocking = $true
}

# 写入报告文件（$TrackDir 已在触发条件检查时创建）
$ReportFile = Join-Path $TrackDir "节奏检测_${StartChapter}-${EndChapter}.md"
$ReportContent = @"
# 跨章节奏检测报告

**检测时间**：$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')
**检测范围**：第 $StartChapter ~ $EndChapter 章（共5章）

## 检测结果

$($Output -join "`n")

## 结论

$(if ($HasBlocking) { "⚠ 发现 blocking 级问题，需要修复节奏问题后再继续写作。" } else { "✅ 无 blocking 级问题。advisory 项可选择性优化。" })
"@

$ReportContent | Out-File -FilePath $ReportFile -Encoding UTF8
Write-Host ""
Write-Host "[check-rhythm] 报告已写入：$ReportFile" -ForegroundColor Green

# 更新追踪记录（记录本次检测的章节号，用于下次触发的差值判断）
$NewTracker = @{
    last_checked_chapter = $TotalChapters
    last_checked_at = (Get-Date -Format 'yyyy-MM-ddTHH:mm:ssZ')
} | ConvertTo-Json
$NewTracker | Out-File -FilePath $TrackerFile -Encoding UTF8
Write-Host "[check-rhythm] 追踪记录已更新：last_checked_chapter = $TotalChapters" -ForegroundColor Green

if ($HasBlocking) {
    Write-Host "[check-rhythm] ⚠ 发现 blocking 级节奏问题！" -ForegroundColor Red
    exit 2  # blocking但非致命，exit 2提醒用户关注
}

exit 0

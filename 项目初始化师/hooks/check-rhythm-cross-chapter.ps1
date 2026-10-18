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

# 收集正文/初稿章节文件（只收章节命名 .md，与 .sh 版本一致）
$ChapterFiles = Get-ChildItem -Path $DraftDir -Filter "*.md" | Where-Object {
    $_.Name -match "第\d+章|chapter|正文|^\d+"
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

$StartChapter = $RecentChapters[0].BaseName
$EndChapter = $RecentChapters[-1].BaseName

Write-Host "[check-rhythm-cross-chapter] 检测第 $StartChapter ~ $EndChapter 章（共5章）的跨章节奏..." -ForegroundColor Cyan

# 明确降级：check-rhythm.js 不存在于任何技能（跨章节奏检测已并入 02b细纲质检/正文终稿打磨师）。
# 家族约定：脚本缺失 → 明确提示并跳过（不静默、不假装阻断）。
Write-Host ""
Write-Host "========================================" -ForegroundColor Yellow
Write-Host "  未找到 check-rhythm.js" -ForegroundColor Yellow
Write-Host "  跨章节奏检测已并入 02b细纲质检 / 正文终稿打磨师，本 hook 仅提示，跳过。" -ForegroundColor Yellow
Write-Host "  如需节奏检测：在 02b细纲质检 / 正文终稿打磨 环节对最近章节做跨章节奏评审。" -ForegroundColor Yellow
Write-Host "========================================" -ForegroundColor Yellow
Write-Host ""

# 更新追踪记录（提示已发出即视为完成本轮巡检，避免每次触发重复打扰）
$NewTracker = @{
    last_checked_chapter = $TotalChapters
    last_checked_at = (Get-Date -Format 'yyyy-MM-ddTHH:mm:ssZ')
} | ConvertTo-Json
$NewTracker | Out-File -FilePath $TrackerFile -Encoding UTF8

exit 0

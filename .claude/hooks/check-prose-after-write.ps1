# check-prose-after-write.ps1 — 写后自动兜底 hook (Windows/PowerShell)
# 对标 oh-story-claudecode 的 check-prose-after-write.sh (PostToolUse)
# 触发时机：正文落盘后（PostToolUse / Write/Edit 之后）
# 作用：自动运行 3 个确定性脚本，报告 blocking 级 finding，防止落盘失败/截断/复读/工程词泄漏

param(
    [Parameter(Mandatory=$true)]
    [string]$ProjectPath,
    [Parameter(Mandatory=$true)]
    [string]$FilePath
)

$ErrorActionPreference = "SilentlyContinue"

# 定位 scripts 目录（相对 hook 文件位置）
$HookDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ScriptsDir = Join-Path $HookDir "..\scripts"

if (-not (Test-Path $FilePath)) {
    Write-Host "[check-prose-after-write] 文件不存在: $FilePath" -ForegroundColor Yellow
    exit 0  # 文件不存在不阻断（可能是删除操作）
}

# 只检查正文文件（.md 且在 正文/ 目录下，或用户指定）
$fileName = Split-Path -Leaf $FilePath
if ($fileName -notmatch "第\d+章|正文|chapter") {
    # 非正文文件，跳过
    exit 0
}

$Node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $Node) {
    Write-Host ""
    Write-Host "========================================" -ForegroundColor Yellow
    Write-Host "  ⚠ 警告：未检测到 node.js" -ForegroundColor Yellow
    Write-Host "  写后质量兜底检测已被跳过！" -ForegroundColor Yellow
    Write-Host "  请安装 node.js 以启用确定性脚本检测。" -ForegroundColor Yellow
    Write-Host "  下载：https://nodejs.org/" -ForegroundColor Gray
    Write-Host "========================================" -ForegroundColor Yellow
    Write-Host ""
    exit 0  # 放行但不静默——用户需知晓检测被跳过
}

$blocking = 0
$advisory = 0

# 1. check-ai-patterns.js（使用 --fail-on=blocking 退出码判定，非字符串匹配）
$script1 = Join-Path $ScriptsDir "check-ai-patterns.js"
if (Test-Path $script1) {
    $out1 = & $Node $script1 --check --fail-on=blocking $FilePath 2>&1
    $exitCode1 = $LASTEXITCODE
    if ($exitCode1 -eq 1) {
        $blocking++
        Write-Host "[check-prose-after-write] BLOCKING (ai-patterns): 否定翻转/破折号超标/碎句号/长段落" -ForegroundColor Red
        $out1 | Select-Object -First 5 | ForEach-Object { Write-Host "  $_" -ForegroundColor Gray }
    } elseif ($out1) {
        $advisory++
    }
}

# 2. check-degeneration.js（使用 --fail-on=blocking 退出码判定）
$script2 = Join-Path $ScriptsDir "check-degeneration.js"
if (Test-Path $script2) {
    $out2 = & $Node $script2 --check --fail-on=blocking $FilePath 2>&1
    $exitCode2 = $LASTEXITCODE
    if ($exitCode2 -eq 1) {
        $blocking++
        Write-Host "[check-prose-after-write] BLOCKING (degeneration): 逐字复读/截断/工程词泄漏" -ForegroundColor Red
        $out2 | Select-Object -First 5 | ForEach-Object { Write-Host "  $_" -ForegroundColor Gray }
    } elseif ($out2) {
        $advisory++
    }
}

# 3. normalize-punctuation.js (report-only，不加 --write)
$script3 = Join-Path $ScriptsDir "normalize-punctuation.js"
if (Test-Path $script3) {
    $out3 = & $Node $script3 $FilePath 2>&1
    if ($out3 -match "发现.*处标点问题") {
        $advisory++
        Write-Host "[check-prose-after-write] ADVISORY (punctuation): 标点规范化建议（report-only）" -ForegroundColor Yellow
        $out3 | Select-Object -First 5 | ForEach-Object { Write-Host "  $_" -ForegroundColor Gray }
    }
}

# 4. 字数欠账粗检（正文文件）
$content = Get-Content $FilePath -Raw -Encoding UTF8
$charCount = ($content -replace '\s', '').Length
if ($charCount -lt 3500) {
    $advisory++
    Write-Host "[check-prose-after-write] ADVISORY: 字数 $charCount < 3500（规则下限），疑似欠字/截断" -ForegroundColor Yellow
}

# 汇总
Write-Host "[check-prose-after-write] $fileName : blocking=$blocking advisory=$advisory 字数=$charCount" -ForegroundColor Cyan

# blocking>0 时返回非零（可被平台 hook 系统捕获），但不强制阻断——由 LLM 根据报告决定
if ($blocking -gt 0) {
    Write-Host "  ⚠️ 发现 blocking 级问题，建议回 05 去AI味或重新生成受影响段落" -ForegroundColor Red
    exit 2  # 退出码2表示有 blocking（非致命，平台可配置是否阻断）
}

exit 0

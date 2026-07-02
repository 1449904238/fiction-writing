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
    Write-Host "[check-prose-after-write] node 未安装，跳过确定性兜底" -ForegroundColor Yellow
    exit 0
}

$blocking = 0
$advisory = 0

# 1. check-ai-patterns.js
$script1 = Join-Path $ScriptsDir "check-ai-patterns.js"
if (Test-Path $script1) {
    $out1 = & $Node $script1 --check $FilePath 2>&1
    if ($out1 -match "blocking" -or $out1 -match "not-is-comparison" -or $out1 -match "em-dash") {
        $blocking++
        Write-Host "[check-prose-after-write] BLOCKING (ai-patterns): 否定翻转/破折号未清理" -ForegroundColor Red
        $out1 | Select-Object -First 5 | ForEach-Object { Write-Host "  $_" -ForegroundColor Gray }
    }
}

# 2. check-degeneration.js
$script2 = Join-Path $ScriptsDir "check-degeneration.js"
if (Test-Path $script2) {
    $out2 = & $Node $script2 --check $FilePath 2>&1
    if ($out2 -match "blocking") {
        $blocking++
        Write-Host "[check-prose-after-write] BLOCKING (degeneration): 逐字复读/截断/工程词泄漏" -ForegroundColor Red
        $out2 | Select-Object -First 5 | ForEach-Object { Write-Host "  $_" -ForegroundColor Gray }
    } elseif ($out2 -match "advisory") {
        $advisory++
    }
}

# 3. 字数欠账粗检（正文文件）
$content = Get-Content $FilePath -Raw -Encoding UTF8
$charCount = ($content -replace '\s', '').Length
if ($charCount -lt 3000) {
    $advisory++
    Write-Host "[check-prose-after-write] ADVISORY: 字数 $charCount < 3000，疑似欠字/截断" -ForegroundColor Yellow
}

# 汇总
Write-Host "[check-prose-after-write] $fileName : blocking=$blocking advisory=$advisory 字数=$charCount" -ForegroundColor Cyan

# blocking>0 时返回非零（可被平台 hook 系统捕获），但不强制阻断——由 LLM 根据报告决定
if ($blocking -gt 0) {
    Write-Host "  ⚠️ 发现 blocking 级问题，建议回 05 去AI味或重新生成受影响段落" -ForegroundColor Red
    exit 2  # 退出码2表示有 blocking（非致命，平台可配置是否阻断）
}

exit 0

# check-prose-after-write.ps1 — 写后自动兜底 hook (Windows/PowerShell)
# 对标 oh-story-claudecode 的 check-prose-after-write.sh (PostToolUse)
# 触发时机：正文落盘后（PostToolUse / Write/Edit 之后）
# 作用：自动运行 3 个确定性脚本，报告 blocking 级 finding，防止落盘失败/截断/复读/工程词泄漏
#
# 跨平台语义说明（V5.4 新增）：
#   exit 0 = 无 blocking 问题（与 .sh 版本一致）
#   exit 1 = node.js 不可用且未设置 SKIP_PROSE_CHECK=1（阻断，与 .sh 版本一致）
#   exit 2 = 发现 blocking 级问题（需回 05 去AI味，与 .sh 版本一致）
#   exit 0 + SKIP_PROSE_CHECK=1 = 用户手动跳过检测（与 .sh 版本一致）
# 平台差异：Trae/Claude Code 的 hook 系统对 exit 2 的阻断行为不同，
#   参考 hooks/README.md 的"跨平台 Hook Parity"章节获取各平台配置说明。

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
if ($fileName -notmatch "第\d+章|正文|chapter|ch\d+") {
    # 非正文文件，跳过
    exit 0
}

$Node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $Node) {
    Write-Host ""
    Write-Host "========================================" -ForegroundColor Red
    Write-Host "  [BLOCKING] 未检测到 node.js" -ForegroundColor Red
    Write-Host "  写后质量兜底检测无法执行！" -ForegroundColor Red
    Write-Host "  这将阻断正文落盘——确定性脚本检测是质量底线。" -ForegroundColor Red
    Write-Host "  请安装 node.js 后重试：https://nodejs.org/" -ForegroundColor Gray
    Write-Host "  如需跳过检测（不推荐），请手动设置 SKIP_PROSE_CHECK=1" -ForegroundColor Gray
    Write-Host "========================================" -ForegroundColor Red
    Write-Host ""
    # V5.3.1: node不可用时从exit 0(静默放行)改为exit 1(警告并阻断)
    # 确定性脚本检测是质量底线，不应静默跳过
    if ($env:SKIP_PROSE_CHECK -eq "1") {
        Write-Host "[check-prose-after-write] SKIP_PROSE_CHECK=1 已设置，跳过检测" -ForegroundColor Yellow
        exit 0
    }
    exit 1  # 阻断：node不可用时不应静默放行
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

# 4. 字数欠账粗检（正文文件）— V5.3.1: 只计中日韩字符+字母数字，去除标点和空白
$content = Get-Content $FilePath -Raw -Encoding UTF8
# 只计中日韩统一表意文字 + 平假名/片假名 + 字母数字（排除标点、空格、markdown符号）
$cjkAlphaNum = [regex]::Matches($content, '[\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ffa-zA-Z0-9]')
$charCount = $cjkAlphaNum.Count
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

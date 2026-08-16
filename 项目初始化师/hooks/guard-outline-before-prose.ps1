# guard-outline-before-prose.ps1
# 阻断型 Hook：写正文前检查对应章节细纲是否存在
# 对标 oh-story-claudecode 的 guard-outline-before-prose hook
# 
# 用法：.\guard-outline-before-prose.ps1 -ProjectPath "..." -Chapter 5
# 如果第5章细纲不存在，exit code = 1（阻断正文写作）
#
# 跨平台语义说明（V5.4 新增）：
#   exit 0 = 细纲存在或 -Force 指定（放行，与 .sh 版本一致）
#   exit 1 = 细纲缺失或目录不存在（阻断正文写作，与 .sh 版本一致）
#   exit 2 = 参数错误（-ProjectPath 缺失或 -Chapter <= 0，与 .sh 版本一致）
# 平台差异：部分平台（如 Codex）可能不支持 PreToolUse hook，
#   参考 hooks/README.md 的"跨平台 Hook Parity"章节获取降级方案。

param(
    [string]$ProjectPath = "",
    [int]$Chapter = 0,
    [switch]$Force
)

# -Force：跳过检查直接放行
if ($Force) {
    Write-Host "⏭️ -Force 已指定，跳过细纲检查"
    exit 0
}

if (-not $ProjectPath) {
    Write-Host "Usage: .\guard-outline-before-prose.ps1 -ProjectPath `"C:\path\to\project`" -Chapter <number>"
    exit 2
}

if ($Chapter -le 0) {
    Write-Host "错误：必须指定章节号（-Chapter <number>）"
    exit 2
}

# V5.3.1: 细纲目录名从硬编码"细纲"改为支持多种命名（细纲/outline/详细大纲）
$detailDir = $null
$candidateDirs = Get-ChildItem -Path $ProjectPath -Directory -ErrorAction SilentlyContinue | Where-Object { $_.Name -match '细纲|outline|详细大纲' }
if ($candidateDirs) {
    $detailDir = $candidateDirs | Select-Object -First 1 | Select-Object -ExpandProperty FullName
}

# 检查细纲目录是否存在
if (-not $detailDir -or -not (Test-Path -LiteralPath $detailDir)) {
    Write-Host "❌ 阻断：细纲目录不存在！（已搜索：细纲|outline|详细大纲）"
    Write-Host ""
    Write-Host "请先运行 02_细纲编写技能 创建细纲，然后再开始正文写作。"
    Write-Host "SKILL.md 规定：不可在无细纲的情况下写正文（防止'裸奔写作'）。"
    exit 1
}

# 查找对应章节的细纲文件
$chapStr = "{0:D3}" -f $Chapter  # 格式化为 001, 002, 003...
$chapStr2 = "{0}" -f $Chapter     # 原始格式 1, 2, 3...

$found = $false
$files = Get-ChildItem -LiteralPath $detailDir -Filter "*.md" -ErrorAction SilentlyContinue

foreach ($f in $files) {
    # 尝试多种命名格式：001_xxx.md, 第1章_xxx.md, Ch001_xxx.md
    if ($f.BaseName -match "(^|[^0-9])$chapStr([^0-9]|$)" -or 
        $f.BaseName -match "(^|[^0-9])$chapStr2([^0-9]|$)" -or
        $f.BaseName -match "第${chapStr2}章") {
        $found = $true
        Write-Host "✅ 第${Chapter}章细纲已就绪：$($f.Name)"
        break
    }
}

if (-not $found) {
    Write-Host "❌ 阻断：第${Chapter}章缺少细纲！"
    Write-Host ""
    Write-Host "细纲目录中未找到第${Chapter}章对应的细纲文件。"
    Write-Host "请先执行以下操作之一："
    Write-Host "  1. 运行 02_细纲编写技能 补充第${Chapter}章细纲"
    Write-Host "  2. 如果是滚动建纲模式，触发'补纲'流程"
    Write-Host ""
    Write-Host "SKILL.md 规定：不可在无细纲的情况下写正文。"
    Write-Host "如需强制跳过，请在调用时添加 -Force 参数。"
    exit 1
}

# 检查细纲内容是否为空
$outlineContent = Get-Content -LiteralPath (Join-Path $detailDir $f.Name) -Raw
if ($outlineContent.Length -lt 50) {
    Write-Host "⚠️ 警告：第${Chapter}章细纲内容过少（$($outlineContent.Length) 字符）"
    Write-Host "建议补充完整细纲后再开始写作。"
}

Write-Host "✅ guard-outline 检查通过，可以开始第${Chapter}章正文写作。"
exit 0

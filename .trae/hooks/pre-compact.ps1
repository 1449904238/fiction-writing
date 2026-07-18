# pre-compact.ps1
# 上下文压缩前自动保存进度快照
# 在用户选择"压缩上下文"时执行，确保关键信息不丢失

param(
    [string]$ProjectPath = ""
)

if (-not $ProjectPath) {
    Write-Host "Usage: .\pre-compact.ps1 -ProjectPath `"C:\path\to\project`""
    exit 1
}

$timestamp = Get-Date -Format 'yyyyMMdd_HHmmss'
$snapshotDir = Join-Path -Path $ProjectPath -ChildPath "追踪\compact-snapshots"
$snapshotFile = Join-Path -Path $snapshotDir -ChildPath "snapshot_$timestamp.md"

# 确保快照目录存在
if (-not (Test-Path -LiteralPath $snapshotDir)) {
    New-Item -ItemType Directory -Path $snapshotDir -Force | Out-Null
}

Write-Host "=== 上下文压缩前快照 ===" 
Write-Host "保存位置：$snapshotFile"

# 收集关键文件内容
$snapshot = @()
$snapshot += "# 进度快照 — $timestamp"
$snapshot += ""

# 1. 上下文管理模板
$contextFile = Join-Path -Path $ProjectPath -ChildPath "追踪\上下文管理模板.md"
if (Test-Path -LiteralPath $contextFile) {
    $snapshot += "## 上下文管理模板"
    $snapshot += ""
    $snapshot += (Get-Content -LiteralPath $contextFile -Raw)
    $snapshot += ""
}

# 2. 伏笔追踪表
$foreshadowFile = Join-Path -Path $ProjectPath -ChildPath "追踪\伏笔.md"
if (Test-Path -LiteralPath $foreshadowFile) {
    $snapshot += "## 伏笔追踪表"
    $snapshot += ""
    $snapshot += (Get-Content -LiteralPath $foreshadowFile -Raw)
    $snapshot += ""
}

# 3. 角色状态
$charStateFile = Join-Path -Path $ProjectPath -ChildPath "追踪\角色状态.md"
if (Test-Path -LiteralPath $charStateFile) {
    $snapshot += "## 角色状态"
    $snapshot += ""
    $snapshot += (Get-Content -LiteralPath $charStateFile -Raw)
    $snapshot += ""
}

# 4. 时间线
$timelineFile = Join-Path -Path $ProjectPath -ChildPath "追踪\时间线.md"
if (Test-Path -LiteralPath $timelineFile) {
    $snapshot += "## 时间线"
    $snapshot += ""
    $snapshot += (Get-Content -LiteralPath $timelineFile -Raw)
    $snapshot += ""
}

# 5. 最近的细纲（前10章）
$outlineDir = Join-Path -Path $ProjectPath -ChildPath "细纲"
if (Test-Path -LiteralPath $outlineDir) {
    $outlineFiles = Get-ChildItem -LiteralPath $outlineDir -Filter "*.md" | Sort-Object Name | Select-Object -First 10
    $snapshot += "## 最近细纲摘要"
    $snapshot += ""
    foreach ($f in $outlineFiles) {
        $snapshot += "### $($f.Name)"
        $content = Get-Content -LiteralPath $f.FullName -Raw
        # 只取前20行作为摘要
        $lines = ($content -split "`n") | Select-Object -First 20
        $snapshot += ($lines -join "`n")
        $snapshot += ""
    }
}

$snapshot | Out-File -FilePath $snapshotFile -Encoding utf8

Write-Host ""
Write-Host "快照已保存。压缩后可通过以下命令恢复："
Write-Host "  Get-Content `"$snapshotFile`" | Write-Host"
Write-Host ""
Write-Host "=== 快照内容摘要 ==="
Write-Host "文件大小：$((Get-Item $snapshotFile).Length) bytes"
Write-Host "包含：上下文模板、伏笔表、角色状态、时间线、细纲摘要"

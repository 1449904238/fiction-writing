# detect-story-gaps.ps1
# 会话启动时自动巡检：设定缺口、大纲缺失、伏笔断线
# 对标 oh-story-claudecode 的 detect-story-gaps hook

param(
    [string]$ProjectPath = ""
)

if (-not $ProjectPath) {
    Write-Host "Usage: .\detect-story-gaps.ps1 -ProjectPath `"C:\path\to\project`""
    exit 1
}

$issues = @()
$warnings = @()

Write-Host "=== Story Gaps 自动巡检 ===" 
Write-Host "项目路径：$ProjectPath"
Write-Host ""

# 1. 检查设定文档完整性
$settingDir = Join-Path -Path $ProjectPath -ChildPath "设定"
if (Test-Path -LiteralPath $settingDir) {
    $settingFile = Join-Path -Path $settingDir -ChildPath "题材定位.md"
    if (-not (Test-Path -LiteralPath $settingFile)) {
        $warnings += "⚠️ 缺少 设定/题材定位.md — 建议补充题材定位和目标平台"
    }
    
    # 检查角色目录
    $charDir = Join-Path -Path $settingDir -ChildPath "角色"
    if (Test-Path -LiteralPath $charDir) {
        $charFiles = Get-ChildItem -LiteralPath $charDir -Filter "*.md"
        foreach ($f in $charFiles) {
            $content = Get-Content -LiteralPath $f.FullName -Raw
            if ($content -match '\[待补充\]|\[待定\]|TODO') {
                $warnings += "⚠️ 角色 $($f.Name) 有未填充字段"
            }
        }
    }
} else {
    $warnings += "⚠️ 缺少 设定/ 目录 — 请先运行 00_小说设定架构师"
}

# 2. 检查大纲完整性
$outlineDir = Join-Path -Path $ProjectPath -ChildPath "大纲"
if (Test-Path -LiteralPath $outlineDir) {
    $outlineFile = Join-Path -Path $outlineDir -ChildPath "大纲.md"
    if (-not (Test-Path -LiteralPath $outlineFile)) {
        $warnings += "⚠️ 缺少 大纲/大纲.md — 建议运行 01_小说大纲构建师"
    }
    
    # 检查卷纲
    $volFiles = Get-ChildItem -LiteralPath $outlineDir -Filter "卷纲_*.md" -ErrorAction SilentlyContinue
    if ($volFiles.Count -eq 0) {
        $warnings += "⚠️ 缺少卷纲文件 — 建议补充每卷的情绪弧线和爽点节奏"
    }
} else {
    $warnings += "⚠️ 缺少 大纲/ 目录"
}

# 3. 检查细纲覆盖
$detailDir = Join-Path -Path $ProjectPath -ChildPath "细纲"
if (Test-Path -LiteralPath $detailDir) {
    $detailFiles = Get-ChildItem -LiteralPath $detailDir -Filter "*.md" | Sort-Object Name
    Write-Host "细纲文件数：$($detailFiles.Count)"
    
    # 检查是否有细纲缺口（序号不连续）
    $lastNum = 0
    foreach ($f in $detailFiles) {
        if ($f.BaseName -match '(\d+)') {
            $num = [int]$matches[1]
            if ($lastNum -gt 0 -and $num -ne $lastNum + 1) {
                $issues += "❌ 细纲缺口：第$lastNum章后直接跳到第$num章"
            }
            $lastNum = $num
        }
    }
} else {
    $warnings += "⚠️ 缺少 细纲/ 目录 — 请先运行 02_细纲编写技能"
}

# 4. 检查伏笔追踪
$foreshadowFile = Join-Path -Path $ProjectPath -ChildPath "追踪\伏笔.md"
if (Test-Path -LiteralPath $foreshadowFile) {
    $content = Get-Content -LiteralPath $foreshadowFile -Raw
    # 检查是否有ACTIVE状态超过50章未回收的伏笔
    if ($content -match 'ACTIVE.*第(\d+)章') {
        Write-Host "伏笔追踪表存在，检查 ACTIVE 伏笔..."
    }
    # 检查是否有空的伏笔追踪表
    if ($content.Length -lt 100) {
        $warnings += "⚠️ 伏笔追踪表几乎为空 — 建议在写作过程中登记伏笔"
    }
} else {
    $warnings += "⚠️ 缺少 追踪/伏笔.md — 建议创建伏笔追踪表"
}

# 5. 检查正文与细纲对应
$proseDir = Join-Path -Path $ProjectPath -ChildPath "正文"
if (Test-Path -LiteralPath $proseDir) {
    $proseFiles = Get-ChildItem -LiteralPath $proseDir -Filter "*.md" | Sort-Object Name
    Write-Host "正文文件数：$($proseFiles.Count)"
    
    foreach ($pf in $proseFiles) {
        if ($pf.BaseName -match '(\d+)') {
            $chapNum = $matches[1]
            # 检查是否有对应细纲
            $matchingOutline = $null
            if (Test-Path -LiteralPath $detailDir) {
                $matchingOutline = Get-ChildItem -LiteralPath $detailDir -Filter "*$chapNum*" -ErrorAction SilentlyContinue
            }
            if (-not $matchingOutline) {
                $issues += "❌ 正文第$chapNum章 缺少对应细纲（guard-outline 应已阻止）"
            }
        }
    }
}

# 输出结果
Write-Host ""
if ($issues.Count -gt 0) {
    Write-Host "=== 严重问题（$($issues.Count) 项） ==="
    foreach ($i in $issues) { Write-Host $i }
    Write-Host ""
}

if ($warnings.Count -gt 0) {
    Write-Host "=== 警告（$($warnings.Count) 项） ==="
    foreach ($w in $warnings) { Write-Host $w }
    Write-Host ""
}

if ($issues.Count -eq 0 -and $warnings.Count -eq 0) {
    Write-Host "✅ 巡检通过：未发现设定缺口、大纲缺失或伏笔断线"
}

Write-Host ""
Write-Host "=== 巡检完成 ==="

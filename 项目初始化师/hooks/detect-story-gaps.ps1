# detect-story-gaps.ps1
# 会话启动时自动巡检：设定缺口、大纲缺失、细纲断线、伏笔超期
# 对标 oh-story-claudecode 的 detect-story-gaps hook
#
# 说明（2026-09 修复误报口径）：
#   - 各环节产物命名由对应下游技能决定，本 hook 只做"目录下有无所属产物"的宽匹配，
#     不再绑定旧命名（题材定位.md / 大纲.md / 卷纲_*.md 均已废弃）。
#   - 环节未产出只提示"X 未就位（可能尚未执行对应环节），请人工确认"，不构成缺口告警；
#     真正的缺口是"正文已写但没有细纲产物"这类流程性矛盾。

param(
    [string]$ProjectPath = ""
)

if (-not $ProjectPath) {
    Write-Host "Usage: .\detect-story-gaps.ps1 -ProjectPath `"C:\path\to\project`""
    exit 1
}

$issues = @()
$warnings = @()
$hints = @()

Write-Host "=== Story Gaps 自动巡检 ===" 
Write-Host "项目路径：$ProjectPath"
Write-Host ""

# ── 1. 检查设定是否就位 ────────────────────────────────
# 00 设定架构师实际产出为 设定包/（00_创作简报.md / 01_设定元数据.json / 02_写作约束.json / manifest.json）；
# 旧骨架可能在 设定/ 下。两处都查，任一处存在 .md/.json 即视为已执行。
$settingRoots = @()
foreach ($cand in @("设定", "设定包")) {
    $d = Join-Path $ProjectPath $cand
    if (Test-Path -LiteralPath $d) { $settingRoots += $d }
}

if ($settingRoots.Count -eq 0) {
    $hints += "提示：设定未就位 — 未发现 设定/ 或 设定包/（可能尚未执行 00 小说设定架构师），请人工确认"
} else {
    $hasSetting = $false
    foreach ($sd in $settingRoots) {
        $found = Get-ChildItem -LiteralPath $sd -Recurse -File -ErrorAction SilentlyContinue |
            Where-Object { $_.Extension -in @(".md", ".json") }
        if ($found) { $hasSetting = $true; break }
    }
    if (-not $hasSetting) {
        $hints += "提示：设定未就位 — 设定/设定包 目录已建但无产出文件（可能尚未执行 00 小说设定架构师），请人工确认"
    }

    # 角色子目录：若存在则检查未填充字段（仅提示，不阻断）
    foreach ($sd in $settingRoots) {
        $charDir = Join-Path $sd "角色"
        if (Test-Path -LiteralPath $charDir) {
            $charFiles = Get-ChildItem -LiteralPath $charDir -Filter "*.md" -ErrorAction SilentlyContinue
            foreach ($f in $charFiles) {
                $content = Get-Content -LiteralPath $f.FullName -Raw -ErrorAction SilentlyContinue
                if ($content -match '\[待补充\]|\[待定\]|TODO') {
                    $warnings += "⚠️ 角色 $($f.Name) 有未填充字段"
                }
            }
        }
    }
}

# ── 2. 检查大纲是否就位 ────────────────────────────────
# 01 大纲构建师核心机器产出为 01_大纲数据.json（另有 00_大纲简报.md / 03_审计回执.json）；
# 可能写入 大纲/ 下，也可能在项目根。宽匹配：两处存在任意 .md/.json 即视为已执行。
$outlineDir = Join-Path $ProjectPath "大纲"
$hasOutline = $false
if (Test-Path -LiteralPath $outlineDir) {
    $outlineFiles = Get-ChildItem -LiteralPath $outlineDir -Recurse -File -ErrorAction SilentlyContinue |
        Where-Object { $_.Extension -in @(".md", ".json") }
    if ($outlineFiles) { $hasOutline = $true }
}
if (-not $hasOutline) {
    # 项目根下直接放 01_大纲数据.json 的兜底检查
    $rootOutline = Get-ChildItem -LiteralPath $ProjectPath -File -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -match '^(01_大纲数据|00_大纲简报|大纲数据).*\.(json|md)$' }
    if ($rootOutline) { $hasOutline = $true }
}
if (-not $hasOutline) {
    $hints += "提示：大纲未就位 — 大纲/ 下或项目根未发现 01_大纲数据.json 等产出（可能尚未执行 01 小说大纲构建师），请人工确认"
}

# ── 3. 检查细纲是否就位 ────────────────────────────────
# 02a 细纲产物形态：卷聚合（卷X_delta.json + 卷X_细纲与衔接.md）、
# 逐章（*_细纲.md / *_衔接包.md / chapter_delta_ChX.json / *handoff*.json）等。
$detailDir = Join-Path $ProjectPath "细纲"
$hasDetail = $false
if (Test-Path -LiteralPath $detailDir) {
    $detailFiles = Get-ChildItem -LiteralPath $detailDir -Recurse -File -ErrorAction SilentlyContinue
    $detailProducts = $detailFiles | Where-Object {
        $_.Name -match '_delta\.json$|细纲|衔接包|衔接|handoff'
    }
    if ($detailProducts) { $hasDetail = $true }
    Write-Host "细纲文件数：$(@($detailFiles).Count)"
}
if (-not $hasDetail) {
    $hints += "提示：细纲未就位 — 细纲/ 下未发现 卷X_细纲与衔接.md / delta.json 等产物（可能尚未执行 02a 细纲生成），请人工确认"
}

# ── 4. 检查伏笔追踪（存在则查 ACTIVE 超期；阈值 25 章，与 chapter-counter 口径一致） ──
$foreshadowFile = Join-Path -Path $ProjectPath -ChildPath "追踪\伏笔追踪表.md"
if (-not (Test-Path -LiteralPath $foreshadowFile)) {
    # 兼容旧命名 伏笔.md
    $altForeshadow = Join-Path -Path $ProjectPath -ChildPath "追踪\伏笔.md"
    if (Test-Path -LiteralPath $altForeshadow) { $foreshadowFile = $altForeshadow }
}

if (Test-Path -LiteralPath $foreshadowFile) {
    $content = Get-Content -LiteralPath $foreshadowFile -Raw
    Write-Host "伏笔追踪表存在，检查 ACTIVE 伏笔超期..."

    # 计算当前章节号（取 正文/ 递归下最大章节号，回退到 细纲/ 最大章节号）
    $currentChapter = 0
    $proseDirCur = Join-Path -Path $ProjectPath -ChildPath "正文"
    if (Test-Path -LiteralPath $proseDirCur) {
        $proseFilesCur = Get-ChildItem -LiteralPath $proseDirCur -Recurse -File -Filter "*.md" -ErrorAction SilentlyContinue
        foreach ($p in $proseFilesCur) {
            if ($p.BaseName -match '(\d+)') { $n = [int]$matches[1]; if ($n -gt $currentChapter) { $currentChapter = $n } }
        }
    }
    if ($currentChapter -eq 0 -and (Test-Path -LiteralPath $detailDir)) {
        $detailFilesCur = Get-ChildItem -LiteralPath $detailDir -Recurse -File -ErrorAction SilentlyContinue
        foreach ($d in $detailFilesCur) {
            if ($d.BaseName -match '(\d+)') { $n = [int]$matches[1]; if ($n -gt $currentChapter) { $currentChapter = $n } }
        }
    }

    # 解析每条 ACTIVE 伏笔的起始章节号，检测超期（>25 章未回收）
    # 启发式解析：优先匹配 起始/埋设/埋下 关键字后的 第N章 或 Ch.N，否则取该行第一个 第N章/Ch.N/裸数字
    $foreshadowLines = $content -split "`r?`n"
    foreach ($line in $foreshadowLines) {
        if ($line -notmatch 'ACTIVE|active|planted|reinforced') { continue }
        $startChapter = 0
        if ($line -match '(?:起始|埋设|埋下|开始).*?(?:第(\d+)章|Ch\.?\s*(\d+))') {
            $startChapter = if ($matches[1]) { [int]$matches[1] } elseif ($matches[2]) { [int]$matches[2] } else { 0 }
        } elseif ($line -match '(?:第(\d+)章|Ch\.?\s*(\d+))') {
            $startChapter = if ($matches[1]) { [int]$matches[1] } elseif ($matches[2]) { [int]$matches[2] } else { 0 }
        }
        if ($startChapter -gt 0 -and $currentChapter -gt 0) {
            $gap = $currentChapter - $startChapter
            if ($gap -gt 25) {
                $warnings += "⚠️ 伏笔超期：ACTIVE 伏笔（第${startChapter}章埋设）已 ${gap} 章未回收（当前第${currentChapter}章，阈值25）"
            }
        }
    }

    # 检查是否有空的伏笔追踪表
    if ($content.Length -lt 100) {
        $warnings += "⚠️ 伏笔追踪表几乎为空 — 建议在写作过程中登记伏笔"
    }
} else {
    $hints += "提示：未发现 追踪/伏笔追踪表.md（写作中再登记即可，当前不阻断）"
}

# ── 5. 检查正文与细纲协调 ──────────────────────────────
# 正文骨架为 正文/ 下含 初稿/、终稿/ 子目录；旧布局可能直接放 正文/ 顶层。
# 只收集章节命名 .md，避免把 README/模板 计入。
$proseDir = Join-Path $ProjectPath "正文"
if (Test-Path -LiteralPath $proseDir) {
    $proseFiles = @(Get-ChildItem -LiteralPath $proseDir -Recurse -File -Filter "*.md" -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -match "第\d+章|chapter|Ch\d+|^[\d０-９]+[章回]?|初稿|终稿" })
    Write-Host "正文章节文件数：$($proseFiles.Count)"

    # 正文已写但细纲完全无产物 → 真缺口（guard-outline 应已阻止）
    if ($proseFiles.Count -gt 0 -and -not $hasDetail) {
        $issues += "❌ 正文已有 $($proseFiles.Count) 个章节文件，但 细纲/ 下未发现细纲产物 — 疑似绕过 02a 细纲直接写作（guard-outline 应已阻止），请人工确认"
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

if ($hints.Count -gt 0) {
    Write-Host "=== 提示（$($hints.Count) 项，多为尚未执行对应环节，不构成缺口） ==="
    foreach ($h in $hints) { Write-Host $h }
    Write-Host ""
}

if ($issues.Count -eq 0 -and $warnings.Count -eq 0) {
    Write-Host "✅ 巡检通过：未发现设定缺口、大纲缺失或伏笔断线"
}

Write-Host ""
Write-Host "=== 巡检完成 ==="

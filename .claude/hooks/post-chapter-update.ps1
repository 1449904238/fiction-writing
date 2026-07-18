# post-chapter-update.ps1 — 章节终稿后上下文更新 hook (Windows/PowerShell)
# 对标 post-chapter-update.sh 的 PowerShell 版本
#
# 触发时机：每章终稿后自动执行（05 去AI味完成、脚本收尾之后）
# 作用：
#   1. 读取最近修改的衔接包 JSON 文件（schemas/handoff-package.schema.json 格式）
#   2. 从正文中提取角色状态变化（简化版：搜索角色名+状态关键词）
#   3. 更新 追踪/上下文管理模板.md 中的角色状态表和伏笔追踪表
#   4. 生成断点快照（当前章号、角色状态、活跃伏笔、下一步任务）
#   5. 找不到衔接包 JSON 时输出降级提示
#
# 用法：
#   .\post-chapter-update.ps1 -ProjectPath "C:\小说项目" [-ChapterFile "正文/第1章.md"] [-HandoffFile "细纲/handoff-01.json"]
#
# 参数说明：
#   -ProjectPath   项目根目录（必填）
#   -ChapterFile   本章正文路径（可选，自动检测最近修改的 正文/ 目录 .md 文件）
#   -HandoffFile   衔接包 JSON 路径（可选，自动检测 细纲/ 或 追踪/ 下最近修改的 *handoff*.json）
#
# 依赖：无（纯 PowerShell，UTF-8 处理中文）
# 注意：本脚本只更新 追踪/ 下的跟踪文件，不修改正文

param(
    [Parameter(Mandatory=$true)]
    [string]$ProjectPath,
    [Parameter(Mandatory=$false)]
    [string]$ChapterFile = "",
    [Parameter(Mandatory=$false)]
    [string]$HandoffFile = ""
)

$ErrorActionPreference = "SilentlyContinue"

# 强制控制台使用 UTF-8 输出（处理中文）
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

# ──────────────────────────────────────────────────────────
#  辅助函数
# ──────────────────────────────────────────────────────────

# 写带颜色的日志
function Write-Log([string]$msg, [string]$color = "Gray") {
    Write-Host "[post-chapter-update] $msg" -ForegroundColor $color
}

# UTF-8 安全读取文件
function Read-FileUtf8([string]$path) {
    if (-not (Test-Path $path)) { return $null }
    return [System.IO.File]::ReadAllText($path, [System.Text.Encoding]::UTF8)
}

# UTF-8 安全写入文件
function Write-FileUtf8([string]$path, [string]$content) {
    $dir = Split-Path -Parent $path
    if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    [System.IO.File]::WriteAllText($path, $content, (New-Object System.Text.UTF8Encoding($true)))
}

# ──────────────────────────────────────────────────────────
#  0. 校验项目路径
# ──────────────────────────────────────────────────────────

if (-not (Test-Path $ProjectPath -PathType Container)) {
    Write-Log "项目路径不存在: $ProjectPath" "Red"
    exit 1
}

$TrackDir = Join-Path $ProjectPath "追踪"
$ContextFile = Join-Path $TrackDir "上下文管理模板.md"
$SnapshotDir = Join-Path $TrackDir "snapshots"

Write-Log "项目路径: $ProjectPath" "Cyan"
Write-Log "追踪目录: $TrackDir" "Cyan"

# 确保 追踪/ 目录存在
if (-not (Test-Path $TrackDir)) {
    Write-Log "追踪/ 目录不存在，尝试创建" "Yellow"
    New-Item -ItemType Directory -Path $TrackDir -Force | Out-Null
}

# ──────────────────────────────────────────────────────────
#  1. 定位衔接包 JSON 文件
# ──────────────────────────────────────────────────────────

$handoffData = $null
$handoffPath = $HandoffFile

if ([string]::IsNullOrEmpty($handoffPath)) {
    # 自动检测：在 细纲/ 和 追踪/ 目录下搜索最近修改的 *handoff*.json
    $searchDirs = @(
        (Join-Path $ProjectPath "细纲"),
        (Join-Path $ProjectPath "追踪"),
        $ProjectPath
    )
    $candidates = @()
    foreach ($dir in $searchDirs) {
        if (Test-Path $dir) {
            $found = Get-ChildItem -Path $dir -Recurse -Filter "*handoff*.json" -File -ErrorAction SilentlyContinue
            if ($found) { $candidates += $found }
        }
    }
    if ($candidates.Count -gt 0) {
        # 取最近修改的
        $latest = $candidates | Sort-Object LastWriteTime -Descending | Select-Object -First 1
        $handoffPath = $latest.FullName
    }
}

if (-not [string]::IsNullOrEmpty($handoffPath) -and (Test-Path $handoffPath)) {
    Write-Log "找到衔接包 JSON: $handoffPath" "Green"
    $raw = Read-FileUtf8 $handoffPath
    try {
        $handoffData = $raw | ConvertFrom-Json
        Write-Log "衔接包解析成功（章号: $($handoffData.chapter_no)）" "Green"
    } catch {
        Write-Log "衔接包 JSON 解析失败: $($_.Exception.Message)" "Yellow"
        $handoffData = $null
    }
}

# ──────────────────────────────────────────────────────────
#  2. 定位本章正文文件
# ──────────────────────────────────────────────────────────

$chapterContent = $null
$chapterPath = $ChapterFile

if ([string]::IsNullOrEmpty($chapterPath)) {
    # 自动检测：在 正文/ 目录下搜索最近修改的 .md 文件
    $proseDir = Join-Path $ProjectPath "正文"
    if (Test-Path $proseDir) {
        $latestChapter = Get-ChildItem -Path $proseDir -Filter "*.md" -File -ErrorAction SilentlyContinue |
            Sort-Object LastWriteTime -Descending | Select-Object -First 1
        if ($latestChapter) { $chapterPath = $latestChapter.FullName }
    }
}

if (-not [string]::IsNullOrEmpty($chapterPath) -and (Test-Path $chapterPath)) {
    Write-Log "找到本章正文: $chapterPath" "Green"
    $chapterContent = Read-FileUtf8 $chapterPath
}

# ──────────────────────────────────────────────────────────
#  3. 降级处理：找不到衔接包 JSON
# ──────────────────────────────────────────────────────────

if ($null -eq $handoffData) {
    Write-Log "" "Yellow"
    Write-Log "========================================" "Yellow"
    Write-Log "  降级提示：未找到衔接包 JSON 文件" "Yellow"
    Write-Log "  请手动更新上下文管理模板：" "Yellow"
    Write-Log "    - 更新 追踪/上下文管理模板.md 中的角色状态表" "Yellow"
    Write-Log "    - 更新 追踪/上下文管理模板.md 中的伏笔追踪表" "Yellow"
    Write-Log "    - 记录当前章号、角色状态、活跃伏笔、下一步任务" "Yellow"
    Write-Log "========================================" "Yellow"
    Write-Log "" "Yellow"

    # 即使没有衔接包，也尝试从正文中提取角色状态（简化版）
    if ($chapterContent) {
        $extractedStates = Extract-CharacterStatesFromProse $chapterContent
        if ($extractedStates.Count -gt 0) {
            Write-Log "（降级）从正文提取到 $($extractedStates.Count) 个角色状态变化提示：" "Cyan"
            foreach ($s in $extractedStates) {
                Write-Log "  - $s" "Gray"
            }
        }
    }
    exit 0
}

# ──────────────────────────────────────────────────────────
#  4. 从正文中提取角色状态变化（简化版）
# ──────────────────────────────────────────────────────────

# 角色状态关键词（简化版检测）
$STATE_KEYWORDS = @(
    '受伤', '骨折', '昏迷', '苏醒', '突破', '升级', '恢复', '死亡', '消失',
    '获得', '失去', '夺', '吞', '服', '进入', '离开', '到达', '发现', '得知',
    '愤怒', '震惊', '悲伤', '恐惧', '狂喜', '绝望', '犹豫', '决意', '心动'
)

function Extract-CharacterStatesFromProse([string]$text) {
    # 简化版：从衔接包角色表 + 正文搜索角色名附近的状态关键词
    $results = @()
    $charNames = @()

    # 从衔接包获取角色名
    if ($handoffData.p0_fields.character_states) {
        foreach ($cs in $handoffData.p0_fields.character_states) {
            if ($cs.name) { $charNames += $cs.name }
        }
    }

    foreach ($name in $charNames) {
        # 查找角色名出现的位置，检查附近是否有状态关键词
        $idx = 0
        $searchText = $text
        while ($idx -lt $searchText.Length) {
            $pos = $searchText.IndexOf($name, $idx)
            if ($pos -lt 0) { break }
            # 截取角色名前后 30 字符的窗口
            $start = [Math]::Max(0, $pos - 30)
            $end = [Math]::Min($searchText.Length, $pos + $name.Length + 30)
            $window = $searchText.Substring($start, $end - $start)
            foreach ($kw in $STATE_KEYWORDS) {
                if ($window.Contains($kw)) {
                    $excerpt = $window.Trim()
                    if ($excerpt.Length -gt 60) { $excerpt = $excerpt.Substring(0, 60) + "..." }
                    $results += "$name -> $kw （$excerpt）"
                    break  # 每个角色名每次出现只记录一个关键词
                }
            }
            $idx = $pos + $name.Length
        }
    }
    return $results
}

$proseStateChanges = @()
if ($chapterContent) {
    $proseStateChanges = Extract-CharacterStatesFromProse $chapterContent
    if ($proseStateChanges.Count -gt 0) {
        Write-Log "从正文提取到 $($proseStateChanges.Count) 个角色状态变化提示" "Cyan"
    }
}

# ──────────────────────────────────────────────────────────
#  5. 更新 追踪/上下文管理模板.md
# ──────────────────────────────────────────────────────────

$now = Get-Date
$timestamp = $now.ToString("yyyy-MM-dd HH:mm:ss")
$chapterNo = if ($handoffData.chapter_no) { [int]$handoffData.chapter_no } else { 0 }

# 构建角色状态表 Markdown
$charTableMd = "| 角色 | 位置 | 身体状态 | 心理状态 | 知识边界 | 更新章 |`n"
$charTableMd += "|------|------|----------|----------|----------|--------|`n"

if ($handoffData.p0_fields.character_states) {
    foreach ($cs in $handoffData.p0_fields.character_states) {
        $name = if ($cs.name) { $cs.name } else { "-" }
        $loc = if ($cs.location) { $cs.location } else { "-" }
        $phy = if ($cs.physical_state) { $cs.physical_state } else { "-" }
        $men = if ($cs.mental_state) { $cs.mental_state } else { "-" }
        $kb = if ($cs.knowledge_boundary) { $cs.knowledge_boundary } else { "-" }
        $charTableMd += "| $name | $loc | $phy | $men | $kb | Ch.$chapterNo |`n"
    }
} else {
    $charTableMd += "| （无角色状态数据） | - | - | - | - | - |`n"
}

# 构建伏笔追踪表 Markdown
$foreshadowMd = "| ID | 伏笔名称 | 埋设章 | 计划回收 | 当前状态 | 更新时间 |`n"
$foreshadowMd += "|----|----------|--------|----------|----------|----------|`n"

$activeForeshadows = @()
if ($handoffData.foreshadowing) {
    foreach ($fs in $handoffData.foreshadowing) {
        $id = if ($fs.id) { $fs.id } else { "-" }
        $nm = if ($fs.name) { $fs.name } else { "-" }
        $pc = if ($fs.plant_chapter) { "Ch.$($fs.plant_chapter)" } else { "-" }
        $ph = if ($fs.planned_harvest) { $fs.planned_harvest } else { "-" }
        $st = if ($fs.current_status) { $fs.current_status } else { "unknown" }
        $foreshadowMd += "| $id | $nm | $pc | $ph | $st | $timestamp |`n"
        # 收集活跃伏笔（用于快照）
        if ($st -in @("planted", "active", "reinforced")) {
            $activeForeshadows += "$nm (ID:$id, 状态:$st)"
        }
    }
} else {
    $foreshadowMd += "| （无伏笔数据） | - | - | - | - | - |`n"
}

# 构建禁止矛盾清单
$forbiddenMd = ""
if ($handoffData.p0_fields.forbidden_contradictions) {
    $forbiddenMd += "`n### 禁止矛盾清单（Ch.$chapterNo）`n`n"
    foreach ($fc in $handoffData.p0_fields.forbidden_contradictions) {
        $forbiddenMd += "- [ ] $fc`n"
    }
}

# 构建正文提取的状态变化提示
$proseMd = ""
if ($proseStateChanges.Count -gt 0) {
    $proseMd += "`n### 正文状态变化提示（Ch.$chapterNo 自动提取）`n`n"
    foreach ($s in $proseStateChanges) {
        $proseMd += "- $s`n"
    }
}

# 组装更新区块
$updateBlock = @"
<!-- post-chapter-update 自动更新 @ $timestamp -->
## 章节进度更新 — Ch.$chapterNo

> 更新时间: $timestamp
> 数据来源: 衔接包 JSON + 正文关键词提取

### 角色状态表（Ch.$chapterNo）

$charTableMd
### 伏笔追踪表（Ch.$chapterNo）

$foreshadowMd$forbiddenMd$proseMd
<!-- /post-chapter-update -->
"@

# 读取或创建上下文管理模板
$existingContent = ""
if (Test-Path $ContextFile) {
    $existingContent = Read-FileUtf8 $ContextFile
}

# 替换旧的自动更新区块（如果有），否则追加
$pattern = '(?s)<!-- post-chapter-update 自动更新.*?/post-chapter-update -->'
if ($existingContent -match $pattern) {
    $newContent = [regex]::Replace($existingContent, $pattern, $updateBlock.Trim())
} else {
    if ([string]::IsNullOrEmpty($existingContent)) {
        $newContent = "# 上下文管理模板`n`n本项目跨会话状态跟踪文件，由 post-chapter-update hook 自动维护。`n`n---`n`n$updateBlock`n"
    } else {
        $newContent = $existingContent.TrimEnd() + "`n`n---`n`n$updateBlock`n"
    }
}

Write-FileUtf8 $ContextFile $newContent
Write-Log "已更新上下文管理模板: $ContextFile" "Green"

# ──────────────────────────────────────────────────────────
#  6. 生成断点快照
# ──────────────────────────────────────────────────────────

if (-not (Test-Path $SnapshotDir)) {
    New-Item -ItemType Directory -Path $SnapshotDir -Force | Out-Null
}

$nextTask = "Ch.$($chapterNo + 1) 细纲生成（02a）+ 扩写（03a）"
if ($chapterNo -gt 0) {
    # 根据当前章数推断下一步
    $mod3 = $chapterNo % 3
    if ($mod3 -eq 0) {
        $nextTask = "每3章审稿（09 多视角审稿，4-Agent 必执行）+ 补纲 5-10 章（02a 滚动建纲）"
    }
}

$activeFsMd = if ($activeForeshadows.Count -gt 0) {
    ($activeForeshadows | ForEach-Object { "- $_" }) -join "`n"
} else {
    "（无活跃伏笔）"
}

$charSummaryMd = if ($handoffData.p0_fields.character_states) {
    ($handoffData.p0_fields.character_states | ForEach-Object {
        $n = if ($_.name) { $_.name } else { "?" }
        $l = if ($_.location) { $_.location } else { "?" }
        $p = if ($_.physical_state) { $_.physical_state } else { "?" }
        "  - ${n}: 位置=${l}, 身体=${p}"
    }) -join "`n"
} else {
    "  （无角色状态）"
}

$snapshot = @"
# 断点快照 — Ch.$chapterNo

> 生成时间: $timestamp
> 由 post-chapter-update.ps1 自动生成

## 当前进度
- 当前章号: Ch.$chapterNo
- 下一步任务: $nextTask

## 角色状态摘要
$charSummaryMd

## 活跃伏笔
$activeFsMd

## 恢复指引
1. 读取本快照恢复上下文
2. 读取 追踪/上下文管理模板.md 获取完整状态
3. 读取最近衔接包 JSON 获取 P0/P1 字段
4. 执行 $nextTask
"@

$snapshotFile = Join-Path $SnapshotDir "snapshot-ch$('{0:D3}' -f $chapterNo).md"
Write-FileUtf8 $snapshotFile $snapshot
Write-Log "断点快照已生成: $snapshotFile" "Green"

# ──────────────────────────────────────────────────────────
#  7. 汇总输出
# ──────────────────────────────────────────────────────────

Write-Log "" "Cyan"
Write-Log "========================================" "Cyan"
Write-Log "  章节更新完成 (Ch.$chapterNo)" "Cyan"
Write-Log "========================================" "Cyan"
Write-Log "  角色状态: $(if($handoffData.p0_fields.character_states){$handoffData.p0_fields.character_states.Count}else{0}) 个角色" "Cyan"
Write-Log "  伏笔追踪: $(if($handoffData.foreshadowing){$handoffData.foreshadowing.Count}else{0}) 条（活跃 $($activeForeshadows.Count) 条）" "Cyan"
Write-Log "  正文状态提示: $($proseStateChanges.Count) 条" "Cyan"
Write-Log "  上下文模板: $ContextFile" "Cyan"
Write-Log "  断点快照: $snapshotFile" "Cyan"
Write-Log "  下一步: $nextTask" "Cyan"
Write-Log "========================================" "Cyan"

exit 0

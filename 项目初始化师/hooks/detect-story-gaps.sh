#!/usr/bin/env bash
# detect-story-gaps.sh — 会话启动自动巡检 (Linux/Mac/bash)
# 巡检：设定缺口、大纲缺失、细纲断线、伏笔超期
# 与 detect-story-gaps.ps1 功能对齐
#
# 说明（2026-09 修复误报口径）：
#   - 各环节产物命名由对应下游技能决定，本 hook 只做"目录下有无所属产物"的宽匹配，
#     不再绑定旧命名（题材定位.md / 大纲.md / 卷纲_*.md 均已废弃）。
#   - 环节未产出只提示"X 未就位（可能尚未执行对应环节），请人工确认"，不构成缺口告警；
#     真正的缺口是"正文已写但没有细纲产物"这类流程性矛盾。

set -u
PROJECT_PATH=""
while [ $# -gt 0 ]; do
    case "$1" in
        --project-path) PROJECT_PATH="$2"; shift 2 ;;
        *) shift ;;
    esac
done
[ -z "$PROJECT_PATH" ] && PROJECT_PATH="$(pwd)"

echo "=== Story Gaps 自动巡检 ==="
echo "项目路径：$PROJECT_PATH"
echo ""

issues=0
warnings=0
hints=0

note()  { echo "[gap] $1"; }
warn()  { echo "[gap] $1"; warnings=$((warnings+1)); }
issue() { echo "[gap] $1"; issues=$((issues+1)); }

# ── 1. 检查设定是否就位 ────────────────────────────────
# 00 设定架构师实际产出为 设定包/（00_创作简报.md / 01_设定元数据.json / 02_写作约束.json / manifest.json）；
# 旧骨架可能在 设定/ 下。两处都查，任一处存在 .md/.json 即视为已执行。
SETTING_ROOTS=""
for cand in "设定" "设定包"; do
    d="$PROJECT_PATH/$cand"
    [ -d "$d" ] && SETTING_ROOTS="$SETTING_ROOTS $d"
done

if [ -z "$SETTING_ROOTS" ]; then
    note "提示：设定未就位 — 未发现 设定/ 或 设定包/（可能尚未执行 00 小说设定架构师），请人工确认"
    hints=$((hints+1))
else
    has_setting=""
    for sd in $SETTING_ROOTS; do
        if find "$sd" -type f \( -name '*.md' -o -name '*.json' \) 2>/dev/null | grep -q .; then
            has_setting=1
            break
        fi
    done
    if [ -z "$has_setting" ]; then
        note "提示：设定未就位 — 设定/设定包 目录已建但无产出文件（可能尚未执行 00 小说设定架构师），请人工确认"
        hints=$((hints+1))
    fi

    # 角色子目录：若存在则检查未填充字段（仅提示，不阻断）
    for sd in $SETTING_ROOTS; do
        CHAR_DIR="$sd/角色"
        if [ -d "$CHAR_DIR" ]; then
            for cf in "$CHAR_DIR"/*.md; do
                [ -e "$cf" ] || continue
                if grep -qE '\[待补充\]|\[待定\]|TODO' "$cf" 2>/dev/null; then
                    warn "⚠️ 角色 $(basename "$cf") 有未填充字段"
                fi
            done
        fi
    done
fi

# ── 2. 检查大纲是否就位 ────────────────────────────────
# 01 大纲构建师核心机器产出为 01_大纲数据.json（另有 00_大纲简报.md / 03_审计回执.json）；
# 可能写入 大纲/ 下，也可能在项目根。宽匹配：两处存在任意 .md/.json 即视为已执行。
has_outline=""
OUTLINE="$PROJECT_PATH/大纲"
if [ -d "$OUTLINE" ]; then
    if find "$OUTLINE" -type f \( -name '*.md' -o -name '*.json' \) 2>/dev/null | grep -q .; then
        has_outline=1
    fi
fi
if [ -z "$has_outline" ]; then
    # 项目根下直接放 01_大纲数据.json 的兜底检查
    if ls "$PROJECT_PATH"/01_大纲数据.json "$PROJECT_PATH"/00_大纲简报.md "$PROJECT_PATH"/大纲数据.* 2>/dev/null | grep -q .; then
        has_outline=1
    fi
fi
if [ -z "$has_outline" ]; then
    note "提示：大纲未就位 — 大纲/ 下或项目根未发现 01_大纲数据.json 等产出（可能尚未执行 01 小说大纲构建师），请人工确认"
    hints=$((hints+1))
fi

# ── 3. 检查细纲是否就位 ────────────────────────────────
# 02a 细纲产物形态：卷聚合（卷X_delta.json + 卷X_细纲与衔接.md）、
# 逐章（*_细纲.md / *_衔接包.md / chapter_delta_ChX.json / *handoff*.json）等。
DETAIL="$PROJECT_PATH/细纲"
has_detail=""
detail_count=0
if [ -d "$DETAIL" ]; then
    detail_count=$(find "$DETAIL" -type f 2>/dev/null | wc -l | tr -d ' ')
    if find "$DETAIL" -type f \( -name '*_delta.json' -o -name '*细纲*' -o -name '*衔接*' -o -name '*handoff*' \) 2>/dev/null | grep -q .; then
        has_detail=1
    fi
    echo "[gap] 细纲文件数：$detail_count"
fi
if [ -z "$has_detail" ]; then
    note "提示：细纲未就位 — 细纲/ 下未发现 卷X_细纲与衔接.md / delta.json 等产物（可能尚未执行 02a 细纲生成），请人工确认"
    hints=$((hints+1))
fi

# ── 4. 检查伏笔追踪（存在则查 ACTIVE 超期；阈值 25 章，与 chapter-counter 口径一致） ──
FORESHADOW="$PROJECT_PATH/追踪/伏笔追踪表.md"
if [ ! -f "$FORESHADOW" ]; then
    FORESHADOW="$PROJECT_PATH/追踪/伏笔.md"
fi
if [ -f "$FORESHADOW" ]; then
    echo "[gap] 伏笔追踪表存在，检查 ACTIVE 伏笔超期..."

    # 计算当前章节号（取 正文/ 递归下最大章节号，回退到 细纲/ 最大章节号）
    current_chapter=0
    PROSE_CUR="$PROJECT_PATH/正文"
    if [ -d "$PROSE_CUR" ]; then
        for f in $(find "$PROSE_CUR" -type f -name '*.md' 2>/dev/null); do
            base=$(basename "$f")
            num=$(echo "$base" | grep -oE '[0-9]+' | head -1)
            if [ -n "$num" ]; then
                num=$((10#$num))
                [ "$num" -gt "$current_chapter" ] && current_chapter=$num
            fi
        done
    fi
    if [ "$current_chapter" -eq 0 ] && [ -d "$DETAIL" ]; then
        for f in $(find "$DETAIL" -type f 2>/dev/null); do
            base=$(basename "$f")
            num=$(echo "$base" | grep -oE '[0-9]+' | head -1)
            if [ -n "$num" ]; then
                num=$((10#$num))
                [ "$num" -gt "$current_chapter" ] && current_chapter=$num
            fi
        done
    fi

    # 解析每条 ACTIVE 伏笔的起始章节号，检测超期（>25 章未回收）
    # 启发式解析：优先匹配 起始/埋设/埋下 关键字后的 第N章 或 Ch.N，否则取该行第一个 第N章/Ch.N
    while IFS= read -r line; do
        [ -z "$line" ] && continue
        if ! echo "$line" | grep -qE 'ACTIVE|active|planted|reinforced'; then
            continue
        fi
        start_chapter=0
        if echo "$line" | grep -qE '(起始|埋设|埋下|开始)'; then
            seg=$(echo "$line" | grep -oE '(起始|埋设|埋下|开始).*')
        else
            seg="$line"
        fi
        m=$(echo "$seg" | grep -oE '第[0-9]+章|Ch\.?[ ]?[0-9]+' | head -1)
        if [ -n "$m" ]; then
            start_chapter=$(echo "$m" | grep -oE '[0-9]+' | head -1)
            start_chapter=$((10#$start_chapter))
        fi
        if [ "$start_chapter" -gt 0 ] && [ "$current_chapter" -gt 0 ]; then
            gap=$((current_chapter - start_chapter))
            if [ "$gap" -gt 25 ]; then
                warn "⚠️ 伏笔超期：ACTIVE 伏笔（第${start_chapter}章埋设）已 ${gap} 章未回收（当前第${current_chapter}章，阈值25）"
            fi
        fi
    done < "$FORESHADOW"

    # 检查是否有空的伏笔追踪表
    fsz=$(wc -c < "$FORESHADOW" | tr -d ' ')
    if [ "${fsz:-0}" -lt 100 ]; then
        warn "⚠️ 伏笔追踪表几乎为空 — 建议在写作过程中登记伏笔"
    fi
else
    note "提示：未发现 追踪/伏笔追踪表.md（写作中再登记即可，当前不阻断）"
    hints=$((hints+1))
fi

# ── 5. 检查正文与细纲协调 ──────────────────────────────
# 正文骨架为 正文/ 下含 初稿/、终稿/ 子目录；旧布局可能直接放 正文/ 顶层。
# 只收集章节命名 .md，避免把 README/模板 计入。
PROSE="$PROJECT_PATH/正文"
prose_files=""
if [ -d "$PROSE" ]; then
    # 逐文件判断（bash3 兼容），名称含 第N章/chapter/ChN/初稿/终稿 视为章节文件
    while IFS= read -r pf; do
        [ -z "$pf" ] && continue
        bname=$(basename "$pf")
        if echo "$bname" | grep -qE '第[0-9]+章|chapter|Ch[0-9]+|初稿|终稿'; then
            prose_files="$prose_files
$pf"
        fi
    done < <(find "$PROSE" -type f -name '*.md' 2>/dev/null)
    prose_count=$(echo "$prose_files" | grep -c . 2>/dev/null || echo 0)
    echo "[gap] 正文章节文件数：$prose_count"

    # 正文已写但细纲完全无产物 → 真缺口（guard-outline 应已阻止）
    if [ "$prose_count" -gt 0 ] && [ -z "$has_detail" ]; then
        issue "❌ 正文已有 $prose_count 个章节文件，但 细纲/ 下未发现细纲产物 — 疑似绕过 02a 细纲直接写作（guard-outline 应已阻止），请人工确认"
    fi
fi

# 输出结果
echo ""
if [ "$issues" -gt 0 ]; then
    echo "=== 严重问题（$issues 项） ==="
fi
if [ "$warnings" -gt 0 ]; then
    echo "=== 警告（$warnings 项） ==="
fi
if [ "$hints" -gt 0 ]; then
    echo "=== 提示（$hints 项，多为尚未执行对应环节，不构成缺口） ==="
fi
if [ "$issues" -eq 0 ] && [ "$warnings" -eq 0 ]; then
    echo "[detect-story-gaps] ✅ 巡检通过：未发现设定缺口、大纲缺失或伏笔断线"
else
    echo "[detect-story-gaps] ⚠️ 发现 $issues 个严重问题，$warnings 个警告，$hints 个提示"
fi
echo ""
echo "=== 巡检完成 ==="
exit 0

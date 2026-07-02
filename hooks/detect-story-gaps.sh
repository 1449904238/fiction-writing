#!/usr/bin/env bash
# detect-story-gaps.sh — 设定缺口巡检 hook (Linux/Mac)
# 巡检：设定完整性、大纲完整性、细纲覆盖与连续性、伏笔追踪表存在性
# 与 detect-story-gaps.ps1 功能对齐
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

# 1. 检查设定文档完整性
SETTING="$PROJECT_PATH/设定"
if [ -d "$SETTING" ]; then
    setting_file="$SETTING/题材定位.md"
    if [ ! -f "$setting_file" ] || [ ! -s "$setting_file" ]; then
        echo "[gap] ⚠️ 缺少或为空 设定/题材定位.md — 建议补充题材定位和目标平台"
        warnings=$((warnings+1))
    fi
    # 检查角色目录
    CHAR_DIR="$SETTING/角色"
    if [ -d "$CHAR_DIR" ]; then
        for cf in "$CHAR_DIR"/*.md; do
            [ -e "$cf" ] || continue
            if grep -qE '\[待补充\]|\[待定\]|TODO' "$cf" 2>/dev/null; then
                echo "[gap] ⚠️ 角色 $(basename "$cf") 有未填充字段"
                warnings=$((warnings+1))
            fi
        done
    fi
else
    echo "[gap] ⚠️ 缺少 设定/ 目录 — 请先运行 00_小说设定架构师"
    warnings=$((warnings+1))
fi

# 2. 检查大纲完整性
OUTLINE="$PROJECT_PATH/大纲"
if [ -d "$OUTLINE" ]; then
    outline_file="$OUTLINE/大纲.md"
    if [ ! -f "$outline_file" ] || [ ! -s "$outline_file" ]; then
        echo "[gap] ⚠️ 缺少或为空 大纲/大纲.md — 建议运行 01_小说大纲构建师"
        warnings=$((warnings+1))
    fi
    # 检查卷纲
    vol_count=$(find "$OUTLINE" -maxdepth 1 -name "卷纲_*.md" 2>/dev/null | wc -l | tr -d ' ')
    if [ "$vol_count" -eq 0 ]; then
        echo "[gap] ⚠️ 缺少卷纲文件 — 建议补充每卷的情绪弧线和爽点节奏"
        warnings=$((warnings+1))
    fi
else
    echo "[gap] ⚠️ 缺少 大纲/ 目录"
    warnings=$((warnings+1))
fi

# 3. 检查细纲覆盖与序号连续性
DETAIL="$PROJECT_PATH/细纲"
if [ -d "$DETAIL" ]; then
    detail_files=$(find "$DETAIL" -maxdepth 1 -name "*.md" 2>/dev/null | sort)
    detail_count=$(echo "$detail_files" | grep -c . 2>/dev/null || echo 0)
    echo "[gap] 细纲文件数：$detail_count"
    # 检查序号连续性
    last_num=0
    while IFS= read -r f; do
        [ -z "$f" ] && continue
        base=$(basename "$f" .md)
        num=$(echo "$base" | grep -oE '[0-9]+' | head -1)
        if [ -n "$num" ]; then
            num=$((10#$num))
            if [ "$last_num" -gt 0 ] && [ "$num" -ne $((last_num+1)) ]; then
                echo "[gap] ❌ 细纲缺口：第${last_num}章后直接跳到第${num}章"
                issues=$((issues+1))
            fi
            last_num=$num
        fi
    done <<< "$detail_files"
else
    echo "[gap] ⚠️ 缺少 细纲/ 目录 — 请先运行 02_细纲编写技能"
    warnings=$((warnings+1))
fi

# 4. 检查正文与细纲对应
PROSE="$PROJECT_PATH/正文"
if [ -d "$PROSE" ]; then
    prose_files=$(find "$PROSE" -maxdepth 1 -name "*.md" 2>/dev/null | sort)
    prose_count=$(echo "$prose_files" | grep -c . 2>/dev/null || echo 0)
    echo "[gap] 正文文件数：$prose_count"
    while IFS= read -r pf; do
        [ -z "$pf" ] && continue
        base=$(basename "$pf" .md)
        chap=$(echo "$base" | grep -oE '[0-9]+' | head -1)
        if [ -n "$chap" ] && [ -d "$DETAIL" ]; then
            match=$(find "$DETAIL" -maxdepth 1 -name "*${chap}*" 2>/dev/null | head -1)
            if [ -z "$match" ]; then
                echo "[gap] ❌ 正文第${chap}章 缺少对应细纲（guard-outline 应已阻止）"
                issues=$((issues+1))
            fi
        fi
    done <<< "$prose_files"
fi

# 5. 检查伏笔追踪表
FORESHADOW="$PROJECT_PATH/追踪/伏笔追踪表.md"
if [ ! -f "$FORESHADOW" ]; then
    FORESHADOW="$PROJECT_PATH/追踪/伏笔.md"
fi
if [ -f "$FORESHADOW" ]; then
    fsz=$(wc -c < "$FORESHADOW" | tr -d ' ')
    if [ "${fsz:-0}" -lt 100 ]; then
        echo "[gap] ⚠️ 伏笔追踪表几乎为空 — 建议在写作过程中登记伏笔"
        warnings=$((warnings+1))
    fi
else
    echo "[gap] ⚠️ 缺少 追踪/伏笔追踪表.md — 建议创建伏笔追踪表"
    warnings=$((warnings+1))
fi

# 输出结果
echo ""
if [ "$issues" -gt 0 ]; then
    echo "=== 严重问题（$issues 项） ==="
fi
if [ "$warnings" -gt 0 ]; then
    echo "=== 警告（$warnings 项） ==="
fi
if [ "$issues" -eq 0 ] && [ "$warnings" -eq 0 ]; then
    echo "[detect-story-gaps] ✅ 巡检通过：未发现设定缺口、大纲缺失或伏笔断线"
else
    echo "[detect-story-gaps] ⚠️ 发现 $issues 个严重问题，$warnings 个警告，建议补齐后再写作"
fi
echo ""
echo "=== 巡检完成 ==="
exit 0

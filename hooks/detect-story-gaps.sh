#!/usr/bin/env bash
# detect-story-gaps.sh — 设定缺口巡检 hook (Linux/Mac)
set -u
PROJECT_PATH=""
while [ $# -gt 0 ]; do
    case "$1" in
        --project-path) PROJECT_PATH="$2"; shift 2 ;;
        *) shift ;;
    esac
done
[ -z "$PROJECT_PATH" ] && PROJECT_PATH="$(pwd)"

echo "=== fiction-writing 设定缺口巡检 ==="
gaps=0

# 检查设定文件
SETTING="$PROJECT_PATH/设定"
[ ! -d "$SETTING" ] && { echo "[gap] ⚠️ 设定目录缺失"; gaps=$((gaps+1)); }

# 检查大纲
OUTLINE="$PROJECT_PATH/大纲"
[ ! -d "$OUTLINE" ] && { echo "[gap] ⚠️ 大纲目录缺失"; gaps=$((gaps+1)); }

# 检查细纲覆盖（正文 vs 细纲）
PROSE="$PROJECT_PATH/正文"
if [ -d "$PROSE" ] && [ -d "$OUTLINE" ]; then
    prose_count=$(ls "$PROSE" 2>/dev/null | grep -cE "第[0-9]+章" || echo 0)
    outline_count=$(ls "$OUTLINE" 2>/dev/null | grep -cE "细纲" || echo 0)
    echo "[gap] 正文章数=$prose_count 细纲数=$outline_count"
    if [ "$prose_count" -gt "$outline_count" ]; then
        echo "[gap] ⚠️ 正文章数 > 细纲数，有章节缺细纲（违反 guard-outline）"
        gaps=$((gaps+1))
    fi
fi

# 检查伏笔追踪
FORESHADOW="$PROJECT_PATH/追踪/伏笔.md"
[ ! -f "$FORESHADOW" ] && echo "[gap] ℹ️ 伏笔追踪表缺失（可选）"

if [ "$gaps" -eq 0 ]; then
    echo "[detect-story-gaps] ✅ 未发现关键缺口"
else
    echo "[detect-story-gaps] ⚠️ 发现 $gaps 个缺口，建议补齐后再写作"
fi
exit 0

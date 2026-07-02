#!/usr/bin/env bash
# guard-outline-before-prose.sh — 阻断型 hook (Linux/Mac)
# 写正文前检查对应章节细纲是否存在，缺则阻止（exit 1）
set -u
PROJECT_PATH=""
CHAPTER=""
while [ $# -gt 0 ]; do
    case "$1" in
        --project-path) PROJECT_PATH="$2"; shift 2 ;;
        --chapter) CHAPTER="$2"; shift 2 ;;
        *) shift ;;
    esac
done
[ -z "$PROJECT_PATH" ] && PROJECT_PATH="$(pwd)"

if [ -z "$CHAPTER" ]; then
    echo "[guard-outline] 未指定 --chapter，跳过检查"
    exit 0
fi

OUTLINE="$PROJECT_PATH/大纲"
# 查找该章细纲（支持 细纲_第N章.md / 第N章 等命名）
num=$(echo "$CHAPTER" | grep -oE "[0-9]+")
found=$(find "$OUTLINE" -maxdepth 2 -type f \( -name "*细纲*${num}*" -o -name "*第${num}章*" \) 2>/dev/null | head -1)

if [ -n "$found" ]; then
    echo "[guard-outline] ✅ 第${num}章细纲已找到: $found"
    exit 0
else
    echo "[guard-outline] ❌ 第${num}章细纲缺失，阻止写正文"
    echo "[guard-outline] 请先在 02 细纲编写技能中补建第${num}章细纲"
    exit 1
fi

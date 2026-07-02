#!/usr/bin/env bash
# guard-outline-before-prose.sh — 阻断型 hook (Linux/Mac)
# 写正文前检查对应章节细纲是否存在，缺则阻止（exit 1）
# 用法：./guard-outline-before-prose.sh --project-path "..." --chapter 5 [--force|-f]
set -u
PROJECT_PATH=""
CHAPTER=""
FORCE=0
while [ $# -gt 0 ]; do
    case "$1" in
        --project-path) PROJECT_PATH="$2"; shift 2 ;;
        --chapter) CHAPTER="$2"; shift 2 ;;
        --force|-f) FORCE=1; shift ;;
        *) shift ;;
    esac
done
[ -z "$PROJECT_PATH" ] && PROJECT_PATH="$(pwd)"

# --force / -f：跳过检查直接放行
if [ "$FORCE" -eq 1 ]; then
    echo "[guard-outline] ⏭️ --force 已指定，跳过细纲检查"
    exit 0
fi

if [ -z "$CHAPTER" ]; then
    echo "[guard-outline] 未指定 --chapter，跳过检查"
    exit 0
fi

DETAIL="$PROJECT_PATH/细纲"

# 检查细纲目录是否存在（与 .ps1 版本一致，在 细纲/ 目录查找）
if [ ! -d "$DETAIL" ]; then
    echo "[guard-outline] ❌ 阻断：细纲目录不存在！"
    echo "[guard-outline]"
    echo "[guard-outline] 请先运行 02_细纲编写技能 创建细纲，然后再开始正文写作。"
    echo "[guard-outline] SKILL.md 规定：不可在无细纲的情况下写正文（防止'裸奔写作'）。"
    exit 1
fi

num=$(echo "$CHAPTER" | grep -oE "[0-9]+" | head -1)
# 查找该章细纲（支持 细纲_第N章.md / 第N章 等命名）
found=$(find "$DETAIL" -maxdepth 2 -type f \( -name "*细纲*${num}*" -o -name "*第${num}章*" \) 2>/dev/null | head -1)

if [ -n "$found" ]; then
    echo "[guard-outline] ✅ 第${num}章细纲已找到: $found"
    # 检查细纲内容是否过少
    content_size=$(wc -c < "$found" 2>/dev/null | tr -d ' ')
    if [ "${content_size:-0}" -lt 50 ]; then
        echo "[guard-outline] ⚠️ 警告：第${num}章细纲内容过少（${content_size} 字节）"
        echo "[guard-outline] 建议补充完整细纲后再开始写作。"
    fi
    exit 0
else
    echo "[guard-outline] ❌ 阻断：第${num}章缺少细纲！"
    echo "[guard-outline]"
    echo "[guard-outline] 细纲目录中未找到第${num}章对应的细纲文件。"
    echo "[guard-outline] 请先执行以下操作之一："
    echo "[guard-outline]   1. 运行 02_细纲编写技能 补充第${num}章细纲"
    echo "[guard-outline]   2. 如果是滚动建纲模式，触发'补纲'流程"
    echo "[guard-outline]"
    echo "[guard-outline] 如需强制跳过，请在调用时添加 --force 或 -f 参数。"
    exit 1
fi

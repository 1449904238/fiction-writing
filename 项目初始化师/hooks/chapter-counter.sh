#!/usr/bin/env bash
# chapter-counter.sh — 章节计数钩子 (Linux/Mac)
# 扫描正文目录，统计已完成章节数，触发审稿/补纲/归档提醒
# 与 chapter-counter.ps1 功能对齐
# 触发时机：session-start（会话启动时自动运行）或独立运行
# 依赖：无外部依赖（纯 shell 脚本，不依赖 node.js）
#
# 配置方式（与 session-start hook 相同，可被 session-start 调用或独立运行）：
#   Claude Code (.claude/settings.local.json):
#     "SessionStart": "bash fiction-writing/hooks/chapter-counter.sh --project-path ${PROJECT_PATH}"
#   OpenCode (opencode.json):
#     "session-start": ["bash", "hooks/chapter-counter.sh", "--project-path", "${PROJECT_PATH}"]
#   手动调用:
#     ./hooks/chapter-counter.sh --project-path "/path/to/project"
#
# 退出码约定：0=正常（含正文目录不存在时静默退出），2=扫描失败

set -u

PROJECT_PATH=""
while [ $# -gt 0 ]; do
    case "$1" in
        --project-path) PROJECT_PATH="$2"; shift 2 ;;
        *) shift ;;
    esac
done
[ -z "$PROJECT_PATH" ] && PROJECT_PATH="$(pwd)"

# ── 1. 定位正文目录：优先 正文/终稿/，回退 正文/ ──
PROSE_FINAL="$PROJECT_PATH/正文/终稿"
PROSE_DIR="$PROJECT_PATH/正文"

SCAN_DIR=""
if [ -d "$PROSE_FINAL" ]; then
    SCAN_DIR="$PROSE_FINAL"
elif [ -d "$PROSE_DIR" ]; then
    SCAN_DIR="$PROSE_DIR"
else
    # 正文目录不存在，静默退出
    exit 0
fi

# ── 2. 扫描 .md 文件，统计匹配章节命名的文件数 ──
# 匹配规则：第\d+章 | chapter | Ch\d+（同时支持中文"第1章"和英文"chapter_001"/"Ch001"命名）
chapter_count=0
for f in "$SCAN_DIR"/*.md; do
    [ -e "$f" ] || continue  # 无 .md 文件时 glob 不展开，跳过
    fname="$(basename "$f")"
    if echo "$fname" | grep -qE '第[0-9]+章|[Cc]hapter|[Cc]h[0-9]+'; then
        chapter_count=$((chapter_count+1))
    fi
done

# ── 3. 扫描细纲目录，计算细纲存量 ──
OUTLINE_DIR="$PROJECT_PATH/细纲"
outline_count=0
if [ -d "$OUTLINE_DIR" ]; then
    for f in "$OUTLINE_DIR"/*.md; do
        [ -e "$f" ] || continue
        fname="$(basename "$f")"
        if echo "$fname" | grep -qE '第[0-9]+章|[Cc]hapter|[Cc]h[0-9]+'; then
            outline_count=$((outline_count+1))
        fi
    done
fi
if [ "$outline_count" -ge "$chapter_count" ]; then
    outline_stock=$((outline_count - chapter_count))
else
    outline_stock=0
fi

# ── 4. 计算进度信息 ──
# 当前卷：根据 N/10 估算（ceil(N/10) = (N + 9) / 10 整数除法）
if [ "$chapter_count" -gt 0 ]; then
    current_volume=$(( (chapter_count + 9) / 10 ))
else
    current_volume=0
fi

# 距下次审稿：3的倍数触发，计算还需多少章到达下一个3的倍数
chapters_to_next_audit=$(( (3 - (chapter_count % 3)) % 3 ))

# ── 5. 输出进度看板 ──
echo ""
echo "📊 项目进度看板"
echo "├── 已完成章节：${chapter_count} 章"
if [ "$current_volume" -gt 0 ]; then
    echo "├── 当前卷：第${current_volume}卷（根据 ${chapter_count}/10 估算）"
else
    echo "├── 当前卷：尚未开始"
fi
echo "├── 距下次审稿：${chapters_to_next_audit} 章"
echo "└── 细纲存量：${outline_stock} 章（细纲 ${outline_count} - 正文 ${chapter_count}）"
echo ""

# ── 6. 触发提醒：3的倍数（3, 6, 9, 12...）──
if [ "$chapter_count" -gt 0 ] && [ $((chapter_count % 3)) -eq 0 ]; then
    echo "⚠️ 已写 ${chapter_count} 章，建议执行："
    echo "  1. 09 多视角审稿（每3章必执行）"
    echo "  2. 02a 补纲（如细纲不足5章存量）"
    echo "  3. 02b 细纲质检（补纲后必执行）"
    echo ""
fi

# ── 7. 触发提醒：10的倍数（10, 20, 30...）──
if [ "$chapter_count" -gt 0 ] && [ $((chapter_count % 10)) -eq 0 ]; then
    echo "⚠️ 已写 ${chapter_count} 章，额外建议："
    echo "  4. 衔接包归档（compress-handoff.js 压缩旧衔接包）"
    echo "  5. 伏笔追踪表检查（超20章未回收的伏笔需关注）"
    echo ""
fi

exit 0

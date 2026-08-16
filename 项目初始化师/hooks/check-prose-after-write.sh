#!/usr/bin/env bash
# check-prose-after-write.sh — 写后自动兜底 hook (Linux/Mac/bash)
# 对标 oh-story-claudecode 的 check-prose-after-write.sh (PostToolUse)
# 触发时机：正文落盘后（PostToolUse / Write/Edit 之后）
# 作用：自动运行 3 个确定性脚本，报告 blocking 级 finding

set -u

PROJECT_PATH="${1:-}"
FILE_PATH="${2:-}"

if [ -z "$FILE_PATH" ] || [ ! -f "$FILE_PATH" ]; then
    echo "[check-prose-after-write] 文件不存在或未指定: $FILE_PATH"
    exit 0
fi

# 定位 scripts 目录
HOOK_DIR="$(cd "$(dirname "$0")" && pwd)"
SCRIPTS_DIR="$HOOK_DIR/../scripts"

# 只检查正文文件
FILE_NAME="$(basename "$FILE_PATH")"
if ! echo "$FILE_NAME" | grep -qE "第[0-9]+章|正文|chapter|ch[0-9]+"; then
    exit 0
fi

NODE="$(command -v node || true)"
if [ -z "$NODE" ]; then
    echo ""
    echo "========================================"
    echo "  [BLOCKING] 未检测到 node.js"
    echo "  写后质量兜底检测无法执行！"
    echo "  这将阻断正文落盘——确定性脚本检测是质量底线。"
    echo "  请安装 node.js 后重试：https://nodejs.org/"
    echo "  如需跳过检测（不推荐），请设置 SKIP_PROSE_CHECK=1"
    echo "========================================"
    echo ""
    # V5.3.1: node不可用时从exit 0(静默放行)改为exit 1(警告并阻断)
    if [ "${SKIP_PROSE_CHECK:-}" = "1" ]; then
        echo "[check-prose-after-write] SKIP_PROSE_CHECK=1 已设置，跳过检测"
        exit 0
    fi
    exit 1  # 阻断：node不可用时不应静默放行
fi

blocking=0
advisory=0

# 1. check-ai-patterns.js（使用 --fail-on=blocking 退出码判定，非字符串匹配）
SCRIPT1="$SCRIPTS_DIR/check-ai-patterns.js"
if [ -f "$SCRIPT1" ]; then
    out1=$("$NODE" "$SCRIPT1" --check --fail-on=blocking "$FILE_PATH" 2>&1)
    exit_code1=$?
    if [ "$exit_code1" -eq 1 ]; then
        blocking=$((blocking+1))
        echo "[check-prose-after-write] BLOCKING (ai-patterns): 否定翻转/破折号超标/碎句号/长段落"
        echo "$out1" | head -5 | sed 's/^/  /'
    elif [ -n "$out1" ]; then
        advisory=$((advisory+1))
    fi
fi

# 2. check-degeneration.js（使用 --fail-on=blocking 退出码判定）
SCRIPT2="$SCRIPTS_DIR/check-degeneration.js"
if [ -f "$SCRIPT2" ]; then
    out2=$("$NODE" "$SCRIPT2" --check --fail-on=blocking "$FILE_PATH" 2>&1)
    exit_code2=$?
    if [ "$exit_code2" -eq 1 ]; then
        blocking=$((blocking+1))
        echo "[check-prose-after-write] BLOCKING (degeneration): 逐字复读/截断/工程词泄漏"
        echo "$out2" | head -5 | sed 's/^/  /'
    elif [ -n "$out2" ]; then
        advisory=$((advisory+1))
    fi
fi

# 3. normalize-punctuation.js (report-only，不加 --write)
SCRIPT3="$SCRIPTS_DIR/normalize-punctuation.js"
if [ -f "$SCRIPT3" ]; then
    out3=$("$NODE" "$SCRIPT3" "$FILE_PATH" 2>&1)
    if echo "$out3" | grep -qE "发现.*处标点问题"; then
        advisory=$((advisory+1))
        echo "[check-prose-after-write] ADVISORY (punctuation): 标点规范化建议（report-only）"
        echo "$out3" | head -5 | sed 's/^/  /'
    fi
fi

# 4. 字数欠账粗检 — V5.3.1: 只计中日韩字符+字母数字，去除标点和空白
# 使用 perl 提取 CJK + 字母数字（兼容 Linux/Mac）
char_count=$(perl -CSpe 'my $c=0; while(<STDIN>){ $c += scalar(() = /[\x{4e00}-\x{9fff}\x{3040}-\x{309f}\x{30a0}-\x{30ff}a-zA-Z0-9]/g); } print $c' < "$FILE_PATH" 2>/dev/null || tr -d '[:space:]' < "$FILE_PATH" | wc -m)
if [ "$char_count" -lt 3500 ]; then
    advisory=$((advisory+1))
    echo "[check-prose-after-write] ADVISORY: 字数 $char_count < 3500（规则下限），疑似欠字/截断"
fi

echo "[check-prose-after-write] $FILE_NAME : blocking=$blocking advisory=$advisory 字数=$char_count"

if [ "$blocking" -gt 0 ]; then
    echo "  ⚠️ 发现 blocking 级问题，建议回 05 去AI味或重新生成受影响段落"
    exit 2
fi

exit 0

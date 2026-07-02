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
if ! echo "$FILE_NAME" | grep -qE "第[0-9]+章|正文|chapter"; then
    exit 0
fi

NODE="$(command -v node || true)"
if [ -z "$NODE" ]; then
    echo "[check-prose-after-write] node 未安装，跳过确定性兜底"
    exit 0
fi

blocking=0
advisory=0

# 1. check-ai-patterns.js
SCRIPT1="$SCRIPTS_DIR/check-ai-patterns.js"
if [ -f "$SCRIPT1" ]; then
    out1=$("$NODE" "$SCRIPT1" --check "$FILE_PATH" 2>&1)
    if echo "$out1" | grep -qE "blocking|not-is-comparison|em-dash"; then
        blocking=$((blocking+1))
        echo "[check-prose-after-write] BLOCKING (ai-patterns): 否定翻转/破折号未清理"
        echo "$out1" | head -5 | sed 's/^/  /'
    fi
fi

# 2. check-degeneration.js
SCRIPT2="$SCRIPTS_DIR/check-degeneration.js"
if [ -f "$SCRIPT2" ]; then
    out2=$("$NODE" "$SCRIPT2" --check "$FILE_PATH" 2>&1)
    if echo "$out2" | grep -q "blocking"; then
        blocking=$((blocking+1))
        echo "[check-prose-after-write] BLOCKING (degeneration): 逐字复读/截断/工程词泄漏"
        echo "$out2" | head -5 | sed 's/^/  /'
    elif echo "$out2" | grep -q "advisory"; then
        advisory=$((advisory+1))
    fi
fi

# 3. 字数欠账粗检
char_count=$(tr -d '[:space:]' < "$FILE_PATH" | wc -m)
if [ "$char_count" -lt 3000 ]; then
    advisory=$((advisory+1))
    echo "[check-prose-after-write] ADVISORY: 字数 $char_count < 3000，疑似欠字/截断"
fi

echo "[check-prose-after-write] $FILE_NAME : blocking=$blocking advisory=$advisory 字数=$char_count"

if [ "$blocking" -gt 0 ]; then
    echo "  ⚠️ 发现 blocking 级问题，建议回 05 去AI味或重新生成受影响段落"
    exit 2
fi

exit 0

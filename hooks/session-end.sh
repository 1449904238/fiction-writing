#!/usr/bin/env bash
# session-end.sh — 会话结束 hook (Linux/Mac)
set -u
PROJECT_PATH=""
COMPLETED=""
NEXT=""
CHAPTER=""
while [ $# -gt 0 ]; do
    case "$1" in
        --project-path) PROJECT_PATH="$2"; shift 2 ;;
        --completed-task) COMPLETED="$2"; shift 2 ;;
        --next-task) NEXT="$2"; shift 2 ;;
        --current-chapter) CHAPTER="$2"; shift 2 ;;
        *) shift ;;
    esac
done
[ -z "$PROJECT_PATH" ] && PROJECT_PATH="$(pwd)"

echo "=== fiction-writing 会话结束 ==="
LOG="$PROJECT_PATH/追踪/session-log.txt"
mkdir -p "$(dirname "$LOG")"
TS="$(date '+%Y-%m-%d %H:%M:%S')"
{
    echo "[$TS] chapter=$CHAPTER completed=$COMPLETED next=$NEXT"
} >> "$LOG"
echo "[session-end] 会话日志已追加到 $LOG"
exit 0

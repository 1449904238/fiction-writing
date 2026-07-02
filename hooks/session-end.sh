#!/usr/bin/env bash
# session-end.sh — 会话结束 hook (Linux/Mac)
# 更新上下文管理模板进度，并追加格式化会话日志到 追踪/session-log.txt
# 与 session-end.ps1 功能对齐
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

TRACKING="$PROJECT_PATH/追踪"
CTX="$TRACKING/上下文管理模板.md"
TS="$(date '+%Y-%m-%d %H:%M:%S')"

# 更新表格字段值（行格式 ...| 字段 | 值 |...）
update_field() {
    local key="$1" val="$2"
    # 转义替换串中的 sed 特殊字符 & \ /
    local esc_val
    esc_val=$(printf '%s' "$val" | sed -e 's/[&\\\/]/\\&/g')
    # 替换含 key 的行中第 2 个 |...| 区间为 | 新值 |（兼容 GNU/BSD sed）
    sed -i.bak -E "/${key}/s/(\|)[^|]*(\|)/\1 ${esc_val} \2/2" "$CTX" && rm -f "${CTX}.bak"
}

echo "=== fiction-writing 会话结束 ==="

# 1. 读取并更新上下文管理模板（如果存在）
if [ -f "$CTX" ]; then
    [ -n "$CHAPTER" ]   && update_field "当前进度" "$CHAPTER"
    [ -n "$COMPLETED" ] && update_field "上次会话结束状态" "$COMPLETED"
    [ -n "$NEXT" ]      && update_field "下次会话起始任务" "$NEXT"
    echo "[session-end] 上下文管理模板已更新：$CTX"
else
    echo "[session-end] ⚠️ 未找到 追踪/上下文管理模板.md，跳过进度更新"
fi

# 2. 追加格式化会话日志（包含时间戳、章节号、完成状态、下次任务）
LOG="$TRACKING/session-log.txt"
mkdir -p "$TRACKING"
{
    echo "[$TS] chapter=$CHAPTER completed=$COMPLETED next=$NEXT"
} >> "$LOG"
echo "[session-end] 会话日志已追加到 $LOG"
echo ""
echo "下次会话将从以下状态恢复："
echo "  - 当前进度：$CHAPTER"
echo "  - 已完成：$COMPLETED"
echo "  - 下一步：$NEXT"
exit 0

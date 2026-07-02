#!/usr/bin/env bash
# session-start.sh — 会话启动 hook (Linux/Mac)
set -u
PROJECT_PATH=""
while [ $# -gt 0 ]; do
    case "$1" in
        --project-path) PROJECT_PATH="$2"; shift 2 ;;
        *) shift ;;
    esac
done
[ -z "$PROJECT_PATH" ] && PROJECT_PATH="$(pwd)"

echo "=== fiction-writing 会话启动 ==="
echo "项目: $PROJECT_PATH"

# 加载上下文管理模板
CTX="$PROJECT_PATH/上下文管理模板.md"
if [ -f "$CTX" ]; then
    echo "[session-start] 上下文模板已找到，建议读取恢复进度"
else
    echo "[session-start] ⚠️ 未找到 上下文管理模板.md"
fi

# 进度快照
TRACKING="$PROJECT_PATH/追踪"
if [ -d "$TRACKING" ]; then
    echo "[session-start] 追踪目录存在，可用快照:"
    ls -1 "$TRACKING" 2>/dev/null | head -5 | sed 's/^/  /'
fi

# 建议运行 detect-story-gaps
echo "[session-start] 建议运行: ./hooks/detect-story-gaps.sh --project-path \"$PROJECT_PATH\""
exit 0

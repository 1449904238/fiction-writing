#!/usr/bin/env bash
# pre-compact.sh — 上下文压缩前保存快照 (Linux/Mac)
set -u
PROJECT_PATH=""
while [ $# -gt 0 ]; do
    case "$1" in
        --project-path) PROJECT_PATH="$2"; shift 2 ;;
        *) shift ;;
    esac
done
[ -z "$PROJECT_PATH" ] && PROJECT_PATH="$(pwd)"

SNAP_DIR="$PROJECT_PATH/追踪/compact-snapshots"
mkdir -p "$SNAP_DIR"
TS="$(date '+%Y%m%d_%H%M%S')"
SNAP="$SNAP_DIR/snapshot_$TS.md"

{
    echo "# 上下文压缩前快照 $TS"
    echo ""
    echo "## 当前进度"
    if [ -f "$PROJECT_PATH/上下文管理模板.md" ]; then
        echo "（来源：上下文管理模板.md）"
        head -50 "$PROJECT_PATH/上下文管理模板.md"
    fi
    echo ""
    echo "## 正文章数"
    ls "$PROJECT_PATH/正文" 2>/dev/null | grep -cE "第[0-9]+章" | sed 's/^/  章数: /'
} > "$SNAP"

echo "[pre-compact] 进度快照已保存到 $SNAP"
echo "[pre-compact] 压缩后建议读取此快照恢复上下文"
exit 0

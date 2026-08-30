#!/usr/bin/env bash
# pre-compact.sh — 上下文压缩前保存快照 (Linux/Mac)
# 收集 5 类关键文件写入时间戳快照到 追踪/compact-snapshots/，防止压缩后关键信息丢失
# 与 pre-compact.ps1 功能对齐
set -u
PROJECT_PATH=""
while [ $# -gt 0 ]; do
    case "$1" in
        --project-path) PROJECT_PATH="$2"; shift 2 ;;
        *) shift ;;
    esac
done
[ -z "$PROJECT_PATH" ] && PROJECT_PATH="$(pwd)"

TRACKING="$PROJECT_PATH/追踪"
SNAP_DIR="$TRACKING/compact-snapshots"
mkdir -p "$SNAP_DIR"
TS="$(date '+%Y%m%d_%H%M%S')"
SNAP="$SNAP_DIR/snapshot_$TS.md"

echo "=== 上下文压缩前快照 ==="
echo "保存位置：$SNAP"

{
    echo "# 进度快照 — $TS"
    echo ""

    # 1. 上下文管理模板
    CTX="$TRACKING/上下文管理模板.md"
    if [ -f "$CTX" ]; then
        echo "## 上下文管理模板"
        echo ""
        cat "$CTX"
        echo ""
    fi

    # 2. 伏笔追踪表（兼容旧命名 伏笔.md）
    FORE="$TRACKING/伏笔追踪表.md"
    [ ! -f "$FORE" ] && FORE="$TRACKING/伏笔.md"
    if [ -f "$FORE" ]; then
        echo "## 伏笔追踪表"
        echo ""
        cat "$FORE"
        echo ""
    fi

    # 3. 角色状态
    CHAR="$TRACKING/角色状态.md"
    if [ -f "$CHAR" ]; then
        echo "## 角色状态"
        echo ""
        cat "$CHAR"
        echo ""
    fi

    # 4. 时间线
    TL="$TRACKING/时间线.md"
    if [ -f "$TL" ]; then
        echo "## 时间线"
        echo ""
        cat "$TL"
        echo ""
    fi

    # 5. 最近细纲摘要（前 10 个）
    DETAIL="$PROJECT_PATH/细纲"
    if [ -d "$DETAIL" ]; then
        echo "## 最近细纲摘要"
        echo ""
        n=0
        while IFS= read -r f; do
            [ -z "$f" ] && continue
            n=$((n+1))
            [ "$n" -gt 10 ] && break
            echo "### $(basename "$f")"
            head -20 "$f" 2>/dev/null
            echo ""
        done < <(find "$DETAIL" -maxdepth 1 -name "*.md" 2>/dev/null | sort)
    fi
} > "$SNAP"

echo ""
echo "快照已保存。压缩后可通过以下命令恢复："
echo "  cat \"$SNAP\""
echo ""
echo "=== 快照内容摘要 ==="
size=$(wc -c < "$SNAP" | tr -d ' ')
echo "文件大小：$size bytes"
echo "包含：上下文模板、伏笔表、角色状态、时间线、细纲摘要"
exit 0

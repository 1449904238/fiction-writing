#!/usr/bin/env bash
# session-start.sh — 会话启动 hook (Linux/Mac)
# 自动加载上下文管理模板，输出断点续跑检查清单，并调用 detect-story-gaps 巡检
# 与 session-start.ps1 功能对齐
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
echo ""

# 1. 加载上下文管理模板
CTX="$PROJECT_PATH/追踪/上下文管理模板.md"
if [ -f "$CTX" ]; then
    echo "[session-start] 已加载上下文管理模板：$CTX"
    echo ""
    echo "--- 当前项目状态 ---"
    grep -E "书名|当前进度|上次会话结束状态|下次会话起始任务" "$CTX" 2>/dev/null | sed 's/^/  /'
    echo ""
else
    echo "[session-start] ⚠️ 未找到 追踪/上下文管理模板.md"
    echo "[session-start] 请先运行 00.5_项目初始化 创建项目结构。"
    echo ""
fi

# 2. 断点续跑检查清单（4 项）
echo "=== 断点续跑检查清单 ==="
echo "□ 当前章节状态检查了吗？"
echo "□ 角色状态同步了吗？"
echo "□ 伏笔追踪表更新了吗？"
echo "□ 衔接包链完整吗？"
echo ""

# 3. 追踪目录快照
TRACKING="$PROJECT_PATH/追踪"
if [ -d "$TRACKING" ]; then
    echo "[session-start] 追踪目录存在，可用快照:"
    ls -1 "$TRACKING" 2>/dev/null | head -5 | sed 's/^/  /'
    echo ""
fi

# 4. 自动调用 detect-story-gaps.sh 巡检
echo "=== 自动巡检 Story Gaps ==="
GAP_SCRIPT="$(cd "$(dirname "$0")" && pwd)/detect-story-gaps.sh"
if [ -f "$GAP_SCRIPT" ]; then
    bash "$GAP_SCRIPT" --project-path "$PROJECT_PATH"
else
    echo "[session-start] 提示：detect-story-gaps.sh 不存在，跳过自动巡检"
fi

exit 0

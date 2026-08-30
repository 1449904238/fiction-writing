#!/usr/bin/env bash
# check-rhythm-cross-chapter.sh — 跨章节奏检测hook（V1.0新增，V2.0更新触发逻辑）
# 触发条件（V2.0更新）：当前章节数 - 上次检测章节数 >= 5 时触发（基于追踪记录差值，非总数取模）
# 执行逻辑：收集最近5章文件，按章节号排序，传入check-rhythm.js
# 输出：节奏检测报告写入 追踪/节奏检测_第N-M章.md
#
# 用法（手动触发）：bash hooks/check-rhythm-cross-chapter.sh [项目根目录]

set -u

PROJECT_PATH="${1:-.}"

# 定位正文/初稿目录
DRAFT_DIR=""
for candidate in "正文/初稿" "正文" "drafts"; do
    if [ -d "$PROJECT_PATH/$candidate" ]; then
        DRAFT_DIR="$PROJECT_PATH/$candidate"
        break
    fi
done

if [ -z "$DRAFT_DIR" ]; then
    echo "[check-rhythm] 未找到正文目录（正文/初稿/ 或 正文/），跳过跨章节奏检测"
    exit 0
fi

# 收集章节文件（匹配 第N章/chapter/数字开头 的.md文件）
CHAPTER_FILES=()
while IFS= read -r -d '' file; do
    CHAPTER_FILES+=("$file")
done < <(find "$DRAFT_DIR" -maxdepth 1 -name "*.md" -print0 | sort -z)

TOTAL_CHAPTERS=${#CHAPTER_FILES[@]}
if [ "$TOTAL_CHAPTERS" -lt 5 ]; then
    echo "[check-rhythm] 章节数 $TOTAL_CHAPTERS < 5，无需跨章节奏检测"
    exit 0
fi

# ===== 触发条件检查（V2.0：基于追踪记录差值，非总数取模） =====
# 读取 追踪/rhythm-check-tracker.json 获取上次检测时的章节号
# 如果 当前章节号 - 上次检测章节号 >= 5，则触发检测并更新记录
# 如果没有追踪记录，默认从第5章开始触发

# 定义追踪目录和追踪文件（提前定义，后续报告写入也复用）
TRACK_DIR="$PROJECT_PATH/追踪"
mkdir -p "$TRACK_DIR"
TRACKER_FILE="$TRACK_DIR/rhythm-check-tracker.json"

# 读取上次检测的章节号
LAST_CHECKED_CHAPTER=0
if [ -f "$TRACKER_FILE" ]; then
    LAST_CHECKED_CHAPTER=$(grep -o '"last_checked_chapter"[[:space:]]*:[[:space:]]*[0-9]*' "$TRACKER_FILE" | grep -o '[0-9]*$' 2>/dev/null || echo 0)
    if [ -z "$LAST_CHECKED_CHAPTER" ]; then
        LAST_CHECKED_CHAPTER=0
    fi
fi

# 差值判断：当前章节数 - 上次检测章节数
CHAPTER_DELTA=$((TOTAL_CHAPTERS - LAST_CHECKED_CHAPTER))
if [ "$CHAPTER_DELTA" -lt 5 ]; then
    echo "[check-rhythm] 当前 $TOTAL_CHAPTERS 章 - 上次检测 $LAST_CHECKED_CHAPTER 章 = $CHAPTER_DELTA < 5，跳过（每写完5章触发一次）"
    exit 0
fi

# 取最近5章
START_IDX=$((TOTAL_CHAPTERS - 5))
RECENT_CHAPTERS=()
for ((i = START_IDX; i < TOTAL_CHAPTERS; i++)); do
    RECENT_CHAPTERS+=("${CHAPTER_FILES[$i]}")
done

START_CHAPTER=$(basename "${RECENT_CHAPTERS[0]}" .md)
END_CHAPTER=$(basename "${RECENT_CHAPTERS[-1]}" .md)

echo "[check-rhythm] 检测第 $START_CHAPTER ~ $END_CHAPTER 章（共5章）的跨章节奏..."

# 定位node和脚本
NODE="$(command -v node || true)"
if [ -z "$NODE" ]; then
    echo "⚠ 警告：未检测到 node.js，跨章节奏检测被跳过"
    exit 0
fi

SCRIPTS_DIR=""
for candidate in "$PROJECT_PATH/fiction-writing/scripts" "$PROJECT_PATH/scripts"; do
    if [ -d "$candidate" ]; then
        SCRIPTS_DIR="$candidate"
        break
    fi
done

if [ -z "$SCRIPTS_DIR" ]; then
    echo "[check-rhythm] 未找到 scripts 目录，跳过"
    exit 0
fi

RHYTHM_SCRIPT="$SCRIPTS_DIR/check-rhythm.js"
if [ ! -f "$RHYTHM_SCRIPT" ]; then
    echo "[check-rhythm] 未找到 check-rhythm.js，跳过"
    exit 0
fi

# 执行检测
OUTPUT=$("$NODE" "$RHYTHM_SCRIPT" --check "${RECENT_CHAPTERS[@]}" 2>&1)
EXIT_CODE=$?

# 输出结果
echo ""
echo "========== 跨章节奏检测报告 =========="
echo "范围：第 $START_CHAPTER ~ $END_CHAPTER 章"
echo "======================================="
echo ""

if [ -n "$OUTPUT" ]; then
    echo "$OUTPUT"
fi

# 检查是否有blocking问题
HAS_BLOCKING=false
if echo "$OUTPUT" | grep -q "blocking"; then
    HAS_BLOCKING=true
fi

# 写入报告文件（TRACK_DIR 已在触发条件检查时创建）
REPORT_FILE="$TRACK_DIR/节奏检测_${START_CHAPTER}-${END_CHAPTER}.md"
cat > "$REPORT_FILE" << EOF
# 跨章节奏检测报告

**检测时间**：$(date '+%Y-%m-%d %H:%M:%S')
**检测范围**：第 $START_CHAPTER ~ $END_CHAPTER 章（共5章）

## 检测结果

$OUTPUT

## 结论

$(if [ "$HAS_BLOCKING" = true ]; then echo "⚠ 发现 blocking 级问题，需要修复节奏问题后再继续写作。"; else echo "✅ 无 blocking 级问题。advisory 项可选择性优化。"; fi)
EOF

echo ""
echo "[check-rhythm] 报告已写入：$REPORT_FILE"

# 更新追踪记录（记录本次检测的章节号，用于下次触发的差值判断）
cat > "$TRACKER_FILE" << EOF
{
  "last_checked_chapter": $TOTAL_CHAPTERS,
  "last_checked_at": "$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
}
EOF
echo "[check-rhythm] 追踪记录已更新：last_checked_chapter = $TOTAL_CHAPTERS"

if [ "$HAS_BLOCKING" = true ]; then
    echo "[check-rhythm] ⚠ 发现 blocking 级节奏问题！"
    exit 2  # blocking但非致命，exit 2提醒用户关注
fi

exit 0

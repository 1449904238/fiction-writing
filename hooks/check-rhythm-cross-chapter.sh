#!/usr/bin/env bash
# check-rhythm-cross-chapter.sh — 跨章节奏检测hook（V1.0新增）
# 触发条件：当正文/初稿/目录下有5的倍数个章节文件时触发
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

# 检查是否为5的倍数
if [ $((TOTAL_CHAPTERS % 5)) -ne 0 ]; then
    echo "[check-rhythm] 章节数 $TOTAL_CHAPTERS 非5的倍数，跳过（每5章触发一次）"
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

# 写入报告文件
TRACK_DIR="$PROJECT_PATH/追踪"
mkdir -p "$TRACK_DIR"

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

if [ "$HAS_BLOCKING" = true ]; then
    echo "[check-rhythm] ⚠ 发现 blocking 级节奏问题！"
    exit 2  # blocking但非致命，exit 2提醒用户关注
fi

exit 0

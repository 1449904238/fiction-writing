#!/usr/bin/env bash
# post-chapter-update.sh — 章节终稿后上下文更新 hook (Linux/Mac/bash)
# 对标 post-chapter-update.ps1 的 Bash 版本
#
# 触发时机：每章终稿后自动执行（05 去AI味完成、脚本收尾之后）
# 作用：
#   1. 读取最近修改的衔接包 JSON 文件（schemas/handoff-package.schema.json 格式）
#   2. 从正文中提取角色状态变化（简化版：搜索角色名+状态关键词）
#   3. 更新 追踪/上下文管理模板.md 中的角色状态表和伏笔追踪表
#   4. 生成断点快照（当前章号、角色状态、活跃伏笔、下一步任务）
#   5. 找不到衔接包 JSON 时输出降级提示
#
# 用法：
#   ./post-chapter-update.sh <项目根目录> [本章正文路径] [衔接包JSON路径]
#
# 参数说明：
#   $1  项目根目录（必填）
#   $2  本章正文路径（可选，自动检测最近修改的 正文/ 目录 .md 文件）
#   $3  衔接包 JSON 路径（可选，自动检测 细纲/ 或 追踪/ 下最近修改的 *handoff*.json）
#
# 依赖：
#   - bash 4.0+（关联数组）
#   - node.js（用于解析 JSON；与 .ps1 版本的 ConvertFrom-Json 对齐）
#   - 可选：node 缺失时降级为 grep 粗提取
# 注意：本脚本只更新 追踪/ 下的跟踪文件，不修改正文

set -u

PROJECT_PATH="${1:-}"
CHAPTER_FILE_ARG="${2:-}"
HANDOFF_FILE_ARG="${3:-}"

# ──────────────────────────────────────────────────────────
#  辅助函数
# ──────────────────────────────────────────────────────────

log() {
    # $1=消息, $2=颜色级别(info/warn/error)
    local msg="$1"
    local level="${2:-info}"
    local prefix="[post-chapter-update]"
    case "$level" in
        error) printf '%s %s\n' "$prefix" "$msg" >&2 ;;
        warn)  printf '%s %s\n' "$prefix" "$msg" ;;
        *)     printf '%s %s\n' "$prefix" "$msg" ;;
    esac
}

# 检测可用的 JSON 解析工具
# 优先级：node > none（node.js 与 .ps1 版本的 ConvertFrom-Json 对齐）
detect_json_tool() {
    if command -v node >/dev/null 2>&1; then
        echo "node"
    else
        echo "none"
    fi
}

# 用 node 提取 JSON 字段
# 用法: json_get <json_string> <jq风格path>
# 支持 jq 的 | length 语法、[N] 数组索引、[] 数组迭代
# 与 .ps1 版本的 ConvertFrom-Json + 属性访问完全对齐
json_get() {
    local json="$1"
    local path="$2"
    local tool
    tool="$(detect_json_tool)"
    case "$tool" in
        node)
            echo "$json" | NODE_JSON_PATH="$path" node -e '
const fs = require("fs");
const raw = fs.readFileSync(0, "utf8").replace(/^\uFEFF/, "");
const data = JSON.parse(raw);
let p = (process.env.NODE_JSON_PATH || "").replace(/^\./, "");
let wantLength = false;
const pipeIdx = p.indexOf("|");
if (pipeIdx >= 0) {
    const after = p.substring(pipeIdx + 1).trim();
    if (after === "length") { wantLength = true; }
    p = p.substring(0, pipeIdx).trim();
}
const tokens = [];
let i = 0;
while (i < p.length) {
    if (p[i] === ".") { i++; continue; }
    if (p[i] === "[") {
        const j = p.indexOf("]", i);
        const c = p.substring(i + 1, j);
        if (c === "") { tokens.push({t: "iter"}); }
        else { tokens.push({t: "idx", v: parseInt(c, 10)}); }
        i = j + 1;
    } else {
        let j = i;
        while (j < p.length && p[j] !== "." && p[j] !== "[") { j++; }
        tokens.push({t: "key", v: p.substring(i, j)});
        i = j;
    }
}
function resolve(obj, n) {
    if (n >= tokens.length) { return [obj]; }
    const tok = tokens[n];
    if (tok.t === "key") {
        if (obj == null || typeof obj !== "object") { return []; }
        return resolve(obj[tok.v], n + 1);
    } else if (tok.t === "idx") {
        if (!Array.isArray(obj)) { return []; }
        return resolve(obj[tok.v], n + 1);
    } else if (tok.t === "iter") {
        if (!Array.isArray(obj)) { return []; }
        let res = [];
        for (const item of obj) { res = res.concat(resolve(item, n + 1)); }
        return res;
    }
    return [];
}
const results = resolve(data, 0);
if (wantLength) {
    if (results.length > 0 && Array.isArray(results[0])) { console.log(results[0].length); }
    else if (results.length > 0 && typeof results[0] === "object" && results[0] !== null) { console.log(Object.keys(results[0]).length); }
    else { console.log(0); }
} else {
    for (const r of results) {
        if (r === undefined) { continue; }
        if (r === null) { console.log("null"); }
        else if (typeof r === "object") { console.log(JSON.stringify(r)); }
        else { console.log(r); }
    }
}
' 2>/dev/null
            ;;
        *)
            echo ""
            ;;
    esac
}

# UTF-8 安全写文件
write_file() {
    local path="$1"
    local content="$2"
    local dir
    dir="$(dirname "$path")"
    [ -d "$dir" ] || mkdir -p "$dir"
    printf '%s' "$content" > "$path"
}

# ──────────────────────────────────────────────────────────
#  0. 校验项目路径
# ──────────────────────────────────────────────────────────

if [ -z "$PROJECT_PATH" ] || [ ! -d "$PROJECT_PATH" ]; then
    log "项目路径不存在或未指定: $PROJECT_PATH" "error"
    echo "用法: $0 <项目根目录> [本章正文路径] [衔接包JSON路径]"
    exit 1
fi

TRACK_DIR="$PROJECT_PATH/追踪"
CONTEXT_FILE="$TRACK_DIR/上下文管理模板.md"
SNAPSHOT_DIR="$TRACK_DIR/snapshots"

log "项目路径: $PROJECT_PATH"
log "追踪目录: $TRACK_DIR"

# 确保 追踪/ 目录存在
[ -d "$TRACK_DIR" ] || mkdir -p "$TRACK_DIR"

# ──────────────────────────────────────────────────────────
#  1. 定位衔接包 JSON 文件
# ──────────────────────────────────────────────────────────

HANDOFF_PATH="$HANDOFF_FILE_ARG"
HANDOFF_DATA=""
HANDOFF_PARSED=""

if [ -z "$HANDOFF_PATH" ]; then
    # 自动检测：在 细纲/ 和 追踪/ 目录下搜索最近修改的 *handoff*.json
    for subdir in "细纲" "追踪" "."; do
        search_dir="$PROJECT_PATH/$subdir"
        if [ -d "$search_dir" ]; then
            found="$(find "$search_dir" -type f -iname '*handoff*.json' -printf '%T@ %p\n' 2>/dev/null \
                     | sort -rn | head -1 | cut -d' ' -f2-)"
            if [ -n "$found" ]; then
                HANDOFF_PATH="$found"
                break
            fi
        fi
    done
fi

if [ -n "$HANDOFF_PATH" ] && [ -f "$HANDOFF_PATH" ]; then
    log "找到衔接包 JSON: $HANDOFF_PATH"
    HANDOFF_DATA="$(cat "$HANDOFF_PATH" 2>/dev/null)"
    if [ -n "$HANDOFF_DATA" ]; then
        # 验证 JSON 可解析
        tool="$(detect_json_tool)"
        if [ "$tool" != "none" ]; then
            test_parse="$(json_get "$HANDOFF_DATA" ".chapter_no")"
            if [ -n "$test_parse" ] && [ "$test_parse" != "null" ]; then
                HANDOFF_PARSED="yes"
                log "衔接包解析成功（章号: $test_parse）"
            else
                log "衔接包 JSON 解析失败或无 chapter_no 字段" "warn"
                HANDOFF_PARSED=""
            fi
        else
            # 无 node.js，用 grep 粗提取 chapter_no
            test_parse="$(echo "$HANDOFF_DATA" | grep -o '"chapter_no"[[:space:]]*:[[:space:]]*[0-9]*' | head -1 | grep -o '[0-9]*$')"
            if [ -n "$test_parse" ]; then
                HANDOFF_PARSED="grep"
                log "衔接包通过 grep 粗解析（章号: $test_parse，建议安装 node.js 获得完整解析）" "warn"
            else
                log "无法解析衔接包 JSON（未安装 node.js，grep 也未匹配）" "warn"
                HANDOFF_PARSED=""
            fi
        fi
    fi
fi

# ──────────────────────────────────────────────────────────
#  2. 定位本章正文文件
# ──────────────────────────────────────────────────────────

CHAPTER_PATH="$CHAPTER_FILE_ARG"
CHAPTER_CONTENT=""

if [ -z "$CHAPTER_PATH" ]; then
    # 自动检测：在 正文/ 目录下搜索最近修改的 .md 文件
    prose_dir="$PROJECT_PATH/正文"
    if [ -d "$prose_dir" ]; then
        found="$(find "$prose_dir" -maxdepth 1 -type f -name '*.md' -printf '%T@ %p\n' 2>/dev/null \
                 | sort -rn | head -1 | cut -d' ' -f2-)"
        if [ -n "$found" ]; then
            CHAPTER_PATH="$found"
        fi
    fi
fi

if [ -n "$CHAPTER_PATH" ] && [ -f "$CHAPTER_PATH" ]; then
    log "找到本章正文: $CHAPTER_PATH"
    CHAPTER_CONTENT="$(cat "$CHAPTER_PATH" 2>/dev/null)"
fi

# ──────────────────────────────────────────────────────────
#  3. 降级处理：找不到衔接包 JSON
# ──────────────────────────────────────────────────────────

if [ -z "$HANDOFF_PARSED" ]; then
    log "" "warn"
    log "========================================" "warn"
    log "  降级提示：未找到或无法解析衔接包 JSON 文件" "warn"
    log "  请手动更新上下文管理模板：" "warn"
    log "    - 更新 追踪/上下文管理模板.md 中的角色状态表" "warn"
    log "    - 更新 追踪/上下文管理模板.md 中的伏笔追踪表" "warn"
    log "    - 记录当前章号、角色状态、活跃伏笔、下一步任务" "warn"
    log "========================================" "warn"
    log "" "warn"

    # 即使没有衔接包，也尝试从正文中提取角色状态（简化版）
    if [ -n "$CHAPTER_CONTENT" ]; then
        # 无衔接包时无法获知角色名，输出通用提示
        log "（降级）已读取正文，但无衔接包角色名，无法提取角色状态变化" "warn"
        log "  建议安装 node.js 以启用完整 JSON 解析" "warn"
    fi
    exit 0
fi

# ──────────────────────────────────────────────────────────
#  4. 从正文中提取角色状态变化（简化版）
# ──────────────────────────────────────────────────────────

# 角色状态关键词（简化版检测）
STATE_KEYWORDS="受伤 骨折 昏迷 苏醒 突破 升级 恢复 死亡 消失 获得 失去 夺 吞 服 进入 离开 到达 发现 得知 愤怒 震惊 悲伤 恐惧 狂喜 绝望 犹豫 决意 心动"

# 提取角色名列表
extract_char_names() {
    if [ "$HANDOFF_PARSED" = "grep" ]; then
        # grep 模式：从原始 JSON 提取 "name" 字段
        echo "$HANDOFF_DATA" | grep -o '"name"[[:space:]]*:[[:space:]]*"[^"]*"' | sed 's/.*"name"[[:space:]]*:[[:space:]]*"//;s/"$//'
    else
        # node 模式
        json_get "$HANDOFF_DATA" '.p0_fields.character_states[].name'
    fi
}

# 从正文提取角色状态变化
extract_prose_states() {
    local text="$1"
    local names="$2"
    local results=""
    local name kw window
    while IFS= read -r name; do
        [ -z "$name" ] && continue
        # 在正文中查找角色名，截取前后 30 字符窗口检查状态关键词
        # 使用 grep -ob 获取字节偏移，然后截取
        local positions
        positions="$(echo "$text" | grep -ob -- "$name" 2>/dev/null | cut -d: -f1)"
        for pos in $positions; do
            [ -z "$pos" ] && continue
            local start=$((pos - 30))
            [ "$start" -lt 0 ] && start=0
            local len=90
            window="$(echo "$text" | tail -c +$((start + 1)) | head -c $len)"
            for kw in $STATE_KEYWORDS; do
                if echo "$window" | grep -q -- "$kw"; then
                    local excerpt
                    excerpt="$(echo "$window" | tr -d '\n' | head -c 60)"
                    results="${results}${name} -> ${kw} （${excerpt}...）
"
                    break  # 每个角色名每次出现只记录一个关键词
                fi
            done
        done
    done <<< "$names"
    echo "$results"
}

CHAR_NAMES="$(extract_char_names)"
PROSE_STATES=""
if [ -n "$CHAPTER_CONTENT" ] && [ -n "$CHAR_NAMES" ]; then
    PROSE_STATES="$(extract_prose_states "$CHAPTER_CONTENT" "$CHAR_NAMES")"
    state_count="$(echo "$PROSE_STATES" | grep -c . 2>/dev/null || true)"
    if [ "$state_count" -gt 0 ]; then
        log "从正文提取到 $state_count 个角色状态变化提示"
    fi
fi

# ──────────────────────────────────────────────────────────
#  5. 更新 追踪/上下文管理模板.md
# ──────────────────────────────────────────────────────────

TIMESTAMP="$(date '+%Y-%m-%d %H:%M:%S')"

# 提取章号
if [ "$HANDOFF_PARSED" = "grep" ]; then
    CHAPTER_NO="$(echo "$HANDOFF_DATA" | grep -o '"chapter_no"[[:space:]]*:[[:space:]]*[0-9]*' | head -1 | grep -o '[0-9]*$')"
else
    CHAPTER_NO="$(json_get "$HANDOFF_DATA" '.chapter_no')"
fi
[ -z "$CHAPTER_NO" ] && CHAPTER_NO="0"

# 构建角色状态表
build_char_table() {
    local md=""
    md="${md}| 角色 | 位置 | 身体状态 | 心理状态 | 知识边界 | 更新章 |
"
    md="${md}|------|------|----------|----------|----------|--------|
"

    if [ "$HANDOFF_PARSED" = "grep" ]; then
        # grep 模式：粗提取，无法精确对应字段，输出提示
        md="${md}| （grep 模式，请安装 node.js 获取精确角色表） | - | - | - | - | Ch.${CHAPTER_NO} |
"
    else
        # node 模式：遍历 character_states 数组
        local count
        count="$(json_get "$HANDOFF_DATA" '.p0_fields.character_states | length')"
        if [ "$count" -gt 0 ] 2>/dev/null; then
            local i=0
            while [ "$i" -lt "$count" ]; do
                local name loc phy men kb
                name="$(json_get "$HANDOFF_DATA" ".p0_fields.character_states[$i].name")"
                loc="$(json_get "$HANDOFF_DATA" ".p0_fields.character_states[$i].location")"
                phy="$(json_get "$HANDOFF_DATA" ".p0_fields.character_states[$i].physical_state")"
                men="$(json_get "$HANDOFF_DATA" ".p0_fields.character_states[$i].mental_state")"
                kb="$(json_get "$HANDOFF_DATA" ".p0_fields.character_states[$i].knowledge_boundary")"
                [ -z "$name" -o "$name" = "null" ] && name="-"
                [ -z "$loc" -o "$loc" = "null" ] && loc="-"
                [ -z "$phy" -o "$phy" = "null" ] && phy="-"
                [ -z "$men" -o "$men" = "null" ] && men="-"
                [ -z "$kb" -o "$kb" = "null" ] && kb="-"
                md="${md}| ${name} | ${loc} | ${phy} | ${men} | ${kb} | Ch.${CHAPTER_NO} |
"
                i=$((i + 1))
            done
        else
            md="${md}| （无角色状态数据） | - | - | - | - | - |
"
        fi
    fi
    echo "$md"
}

# 构建伏笔追踪表 + 收集活跃伏笔
ACTIVE_FORESHADOWS=""
build_foreshadow_table() {
    local md=""
    md="${md}| ID | 伏笔名称 | 埋设章 | 计划回收 | 当前状态 | 更新时间 |
"
    md="${md}|----|----------|--------|----------|----------|----------|
"

    local count="0"
    if [ "$HANDOFF_PARSED" != "grep" ]; then
        count="$(json_get "$HANDOFF_DATA" '.foreshadowing | length')"
    fi

    if [ "$count" -gt 0 ] 2>/dev/null; then
        local i=0
        while [ "$i" -lt "$count" ]; do
            local id nm pc ph st
            id="$(json_get "$HANDOFF_DATA" ".foreshadowing[$i].id")"
            nm="$(json_get "$HANDOFF_DATA" ".foreshadowing[$i].name")"
            pc="$(json_get "$HANDOFF_DATA" ".foreshadowing[$i].plant_chapter")"
            ph="$(json_get "$HANDOFF_DATA" ".foreshadowing[$i].planned_harvest")"
            st="$(json_get "$HANDOFF_DATA" ".foreshadowing[$i].current_status")"
            [ -z "$id" -o "$id" = "null" ] && id="-"
            [ -z "$nm" -o "$nm" = "null" ] && nm="-"
            [ -z "$pc" -o "$pc" = "null" ] && pc="-" || pc="Ch.${pc}"
            [ -z "$ph" -o "$ph" = "null" ] && ph="-"
            [ -z "$st" -o "$st" = "null" ] && st="unknown"
            md="${md}| ${id} | ${nm} | ${pc} | ${ph} | ${st} | ${TIMESTAMP} |
"
            i=$((i + 1))
        done
    else
        md="${md}| （无伏笔数据） | - | - | - | - | - |
"
    fi
    echo "$md"
}

# 构建禁止矛盾清单
build_forbidden() {
    local md=""
    local count="0"
    if [ "$HANDOFF_PARSED" != "grep" ]; then
        count="$(json_get "$HANDOFF_DATA" '.p0_fields.forbidden_contradictions | length')"
    fi
    if [ "$count" -gt 0 ] 2>/dev/null; then
        md="${md}
### 禁止矛盾清单（Ch.${CHAPTER_NO}）

"
        local i=0
        while [ "$i" -lt "$count" ]; do
            local fc
            fc="$(json_get "$HANDOFF_DATA" ".p0_fields.forbidden_contradictions[$i]")"
            [ -z "$fc" -o "$fc" = "null" ] && fc="-"
            md="${md}- [ ] ${fc}
"
            i=$((i + 1))
        done
    fi
    echo "$md"
}

# 构建正文状态变化提示
build_prose_states() {
    local md=""
    if [ -n "$PROSE_STATES" ]; then
        md="${md}
### 正文状态变化提示（Ch.${CHAPTER_NO} 自动提取）

"
        while IFS= read -r line; do
            [ -z "$line" ] && continue
            md="${md}- ${line}
"
        done <<< "$PROSE_STATES"
    fi
    echo "$md"
}

CHAR_TABLE_MD="$(build_char_table)"
FORESHADOW_MD="$(build_foreshadow_table)"
FORBIDDEN_MD="$(build_forbidden)"
PROSE_MD="$(build_prose_states)"

# 在主 shell 中单独收集活跃伏笔（build_foreshadow_table 在子 shell 中运行，变量无法传出）
ACTIVE_FORESHADOWS=""
if [ "$HANDOFF_PARSED" != "grep" ]; then
    _fs_count="$(json_get "$HANDOFF_DATA" '.foreshadowing | length')"
    [ -z "$_fs_count" -o "$_fs_count" = "null" ] && _fs_count="0"
    _i=0
    while [ "$_i" -lt "$_fs_count" ]; do
        _st="$(json_get "$HANDOFF_DATA" ".foreshadowing[$_i].current_status")"
        _nm="$(json_get "$HANDOFF_DATA" ".foreshadowing[$_i].name")"
        _id="$(json_get "$HANDOFF_DATA" ".foreshadowing[$_i].id")"
        [ -z "$_nm" -o "$_nm" = "null" ] && _nm="-"
        [ -z "$_id" -o "$_id" = "null" ] && _id="-"
        [ -z "$_st" -o "$_st" = "null" ] && _st="unknown"
        case "$_st" in
            planted|active|reinforced)
                ACTIVE_FORESHADOWS="${ACTIVE_FORESHADOWS}- ${_nm} (ID:${_id}, 状态:${_st})
"
                ;;
        esac
        _i=$((_i + 1))
    done
fi

[ -z "$ACTIVE_FORESHADOWS" ] && ACTIVE_FORESHADOWS="（无活跃伏笔）"

# 组装更新区块
UPDATE_BLOCK="<!-- post-chapter-update 自动更新 @ ${TIMESTAMP} -->
## 章节进度更新 — Ch.${CHAPTER_NO}

> 更新时间: ${TIMESTAMP}
> 数据来源: 衔接包 JSON + 正文关键词提取

### 角色状态表（Ch.${CHAPTER_NO}）

${CHAR_TABLE_MD}
### 伏笔追踪表（Ch.${CHAPTER_NO}）

${FORESHADOW_MD}${FORBIDDEN_MD}${PROSE_MD}
<!-- /post-chapter-update -->"

# 读取或创建上下文管理模板
EXISTING_CONTENT=""
if [ -f "$CONTEXT_FILE" ]; then
    EXISTING_CONTENT="$(cat "$CONTEXT_FILE" 2>/dev/null)"
fi

# 替换旧的自动更新区块（如果有），否则追加
# 使用 awk 统一处理（避免内嵌 Python/sed 的引号嵌套问题）
NEW_CONTENT=""
if echo "$EXISTING_CONTENT" | grep -q "post-chapter-update 自动更新"; then
    # 已存在旧区块：用 awk 删除旧区块行，保留其余内容
    OLD_BLOCK_REMOVED="$(awk '
        /<!-- post-chapter-update/ { skip=1; next }
        /\/post-chapter-update -->/ { skip=0; next }
        !skip { print }
    ' "$CONTEXT_FILE" 2>/dev/null)"
    # 去除尾部空行后追加新区块
    NEW_CONTENT="$(printf '%s\n' "$OLD_BLOCK_REMOVED" | awk 'NF{p=1} p')"
    NEW_CONTENT="${NEW_CONTENT}

---

${UPDATE_BLOCK}"
else
    if [ -z "$EXISTING_CONTENT" ]; then
        # 文件不存在或为空：创建带标题头的新文件
        NEW_CONTENT="# 上下文管理模板

本项目跨会话状态跟踪文件，由 post-chapter-update hook 自动维护。

---

${UPDATE_BLOCK}"
    else
        # 文件存在但无旧区块：去除尾部空行后追加新区块
        TRIMMED="$(printf '%s\n' "$EXISTING_CONTENT" | awk 'NF{p=1} p')"
        NEW_CONTENT="${TRIMMED}

---

${UPDATE_BLOCK}"
    fi
fi

write_file "$CONTEXT_FILE" "$NEW_CONTENT"
log "已更新上下文管理模板: $CONTEXT_FILE"

# ──────────────────────────────────────────────────────────
#  6. 生成断点快照
# ──────────────────────────────────────────────────────────

[ -d "$SNAPSHOT_DIR" ] || mkdir -p "$SNAPSHOT_DIR"

# 推断下一步任务
NEXT_TASK="Ch.$((CHAPTER_NO + 1)) 细纲生成（02a）+ 扩写（03a）"
if [ "$CHAPTER_NO" -gt 0 ] 2>/dev/null; then
    MOD3=$((CHAPTER_NO % 3))
    if [ "$MOD3" -eq 0 ]; then
        NEXT_TASK="每3章审稿（09 多视角审稿，4-Agent 必执行）+ 补纲 5-10 章（02a 滚动建纲）"
    fi
fi

# 角色状态摘要
CHAR_SUMMARY="  （无角色状态）"
if [ "$HANDOFF_PARSED" != "grep" ]; then
    count="$(json_get "$HANDOFF_DATA" '.p0_fields.character_states | length')"
    if [ "$count" -gt 0 ] 2>/dev/null; then
        CHAR_SUMMARY=""
        i=0
        while [ "$i" -lt "$count" ]; do
            name="$(json_get "$HANDOFF_DATA" ".p0_fields.character_states[$i].name")"
            loc="$(json_get "$HANDOFF_DATA" ".p0_fields.character_states[$i].location")"
            phy="$(json_get "$HANDOFF_DATA" ".p0_fields.character_states[$i].physical_state")"
            [ -z "$name" -o "$name" = "null" ] && name="?"
            [ -z "$loc" -o "$loc" = "null" ] && loc="?"
            [ -z "$phy" -o "$phy" = "null" ] && phy="?"
            CHAR_SUMMARY="${CHAR_SUMMARY}  - ${name}: 位置=${loc}, 身体=${phy}
"
            i=$((i + 1))
        done
    fi
fi

CHAPTER_NO_PAD="$(printf '%03d' "$CHAPTER_NO" 2>/dev/null || echo "$CHAPTER_NO")"
SNAPSHOT_FILE="$SNAPSHOT_DIR/snapshot-ch${CHAPTER_NO_PAD}.md"

SNAPSHOT="# 断点快照 — Ch.${CHAPTER_NO}

> 生成时间: ${TIMESTAMP}
> 由 post-chapter-update.sh 自动生成

## 当前进度
- 当前章号: Ch.${CHAPTER_NO}
- 下一步任务: ${NEXT_TASK}

## 角色状态摘要
${CHAR_SUMMARY}
## 活跃伏笔
${ACTIVE_FORESHADOWS}
## 恢复指引
1. 读取本快照恢复上下文
2. 读取 追踪/上下文管理模板.md 获取完整状态
3. 读取最近衔接包 JSON 获取 P0/P1 字段
4. 执行 ${NEXT_TASK}
"

write_file "$SNAPSHOT_FILE" "$SNAPSHOT"
log "断点快照已生成: $SNAPSHOT_FILE"

# ──────────────────────────────────────────────────────────
#  6.5 规则执行遥测 + Dashboard生成（V6.0新增）
# ──────────────────────────────────────────────────────────

# 定位 scripts 目录
SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)/scripts"

# 规则执行遥测
if [ -f "$SCRIPT_DIR/check-rule-execution.js" ] && command -v node >/dev/null 2>&1; then
    log "运行规则执行遥测..."
    if node "$SCRIPT_DIR/check-rule-execution.js" --project "$PROJECT_PATH" --chapter "$CHAPTER_FILE" 2>&1; then
        log "规则执行遥测完成，报告已写入 追踪/rule-execution-telemetry.json"
    else
        log "规则执行遥测跳过（执行失败）" "yellow"
    fi
else
    log "check-rule-execution.js 或 node 未找到，跳过遥测"
fi

# Dashboard生成
if [ -f "$SCRIPT_DIR/generate-dashboard.js" ] && command -v node >/dev/null 2>&1; then
    log "生成HTML进度面板..."
    DASHBOARD_OUTPUT="$TRACK_DIR/dashboard.html"
    if node "$SCRIPT_DIR/generate-dashboard.js" --project "$PROJECT_PATH" --output "$DASHBOARD_OUTPUT" 2>&1; then
        log "HTML进度面板已生成: $DASHBOARD_OUTPUT"
    else
        log "Dashboard生成跳过（执行失败）" "yellow"
    fi
else
    log "generate-dashboard.js 或 node 未找到，跳过Dashboard"
fi

# ──────────────────────────────────────────────────────────
#  7. 汇总输出
# ──────────────────────────────────────────────────────────

# 统计角色数和伏笔数
CHAR_COUNT="0"
FS_COUNT="0"
ACTIVE_COUNT="0"
if [ "$HANDOFF_PARSED" != "grep" ]; then
    CHAR_COUNT="$(json_get "$HANDOFF_DATA" '.p0_fields.character_states | length')"
    FS_COUNT="$(json_get "$HANDOFF_DATA" '.foreshadowing | length')"
    [ -z "$CHAR_COUNT" -o "$CHAR_COUNT" = "null" ] && CHAR_COUNT="0"
    [ -z "$FS_COUNT" -o "$FS_COUNT" = "null" ] && FS_COUNT="0"
    ACTIVE_COUNT="$(echo "$ACTIVE_FORESHADOWS" | grep -c '^-' 2>/dev/null || true)"
fi
PROSE_COUNT="$(echo "$PROSE_STATES" | grep -c . 2>/dev/null || true)"

echo ""
echo "========================================"
echo "  章节更新完成 (Ch.${CHAPTER_NO})"
echo "========================================"
echo "  角色状态: ${CHAR_COUNT} 个角色"
echo "  伏笔追踪: ${FS_COUNT} 条（活跃 ${ACTIVE_COUNT} 条）"
echo "  正文状态提示: ${PROSE_COUNT} 条"
echo "  上下文模板: ${CONTEXT_FILE}"
echo "  断点快照: ${SNAPSHOT_FILE}"
echo "  规则遥测: 追踪/rule-execution-telemetry.json"
echo "  进度面板: 追踪/dashboard.html"
echo "  下一步: ${NEXT_TASK}"
echo "========================================"

exit 0

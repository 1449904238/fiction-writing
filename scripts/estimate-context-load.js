#!/usr/bin/env node
'use strict';

/**
 * estimate-context-load.js — 上下文预算估算器
 *
 * 输入当前章节号 + 场景类型，输出预估加载的文件列表和总行数。
 * 解析 scene-trigger-map.md 中的场景→文件加载映射，根据参数计算需要加载的文件。
 *
 * 输出：文件列表 / 每个文件行数 / 总行数 / 预估token数（行数×15估算）
 * 如果总行数 > 2000，输出 WARNING。
 *
 * 用法：node estimate-context-load.js --step=<step> [--chapter=N] [--scene=<type>]
 *        [--content-tag=<tag>] [--genre=<genre>] [--dialogue-ratio=N] [--new-character]
 *        [--chapter-type=<type>] [--json] [--map=<path>] [--references-dir=<path>]
 *
 * Exit codes: 0=正常, 1=有warning(总行数>2000), 2=错误
 */

const fs = require('fs');
const path = require('path');

const USAGE = `Usage: node estimate-context-load.js --step=<step> [options]

Estimate context window load based on scene-trigger-map.md.
  --step=<step>           current step: 02a/03a/03b/04/05 (required)
  --chapter=N             chapter number
  --scene=<type>          scene type: core/important/transitional/accent
  --content-tag=<tag>     content tag: 战斗/心理/环境/对话/情绪
  --genre=<genre>         book genre: 玄幻/都市/悬疑/言情/修仙
  --dialogue-ratio=N      dialogue ratio percentage (0-100)
  --new-character         flag: new character appears in this chapter
  --chapter-type=<type>   chapter type: opening/climax/transition/regular
  --json                  output JSON to stdout
  --map=<path>            path to scene-trigger-map.md
  --references-dir=<path> path to references directory

Report-only. Never modifies files.`;

// 行数→token估算系数（中文每行约15 token）
const TOKENS_PER_LINE = 15;
// 上下文行数告警阈值
const CONTEXT_LINE_WARNING = 2000;

// ════════════════════════════════════════════════════════════
//  参数解析
// ════════════════════════════════════════════════════════════

const options = {
  step: null,
  chapter: null,
  scene: null,
  contentTag: null,
  genre: null,
  dialogueRatio: null,
  newCharacter: false,
  chapterType: null,
  json: false,
  mapPath: null,
  referencesDir: null,
};

for (let i = 2; i < process.argv.length; i += 1) {
  const arg = process.argv[i];
  if (arg.startsWith('--step=')) {
    options.step = arg.slice('--step='.length);
  } else if (arg.startsWith('--chapter=')) {
    options.chapter = parseInt(arg.slice('--chapter='.length), 10) || null;
  } else if (arg.startsWith('--scene=')) {
    options.scene = arg.slice('--scene='.length);
  } else if (arg.startsWith('--content-tag=')) {
    options.contentTag = arg.slice('--content-tag='.length);
  } else if (arg.startsWith('--genre=')) {
    options.genre = arg.slice('--genre='.length);
  } else if (arg.startsWith('--dialogue-ratio=')) {
    options.dialogueRatio = parseFloat(arg.slice('--dialogue-ratio='.length)) || null;
  } else if (arg === '--new-character') {
    options.newCharacter = true;
  } else if (arg.startsWith('--chapter-type=')) {
    options.chapterType = arg.slice('--chapter-type='.length);
  } else if (arg === '--json') {
    options.json = true;
  } else if (arg.startsWith('--map=')) {
    options.mapPath = path.resolve(arg.slice('--map='.length));
  } else if (arg.startsWith('--references-dir=')) {
    options.referencesDir = path.resolve(arg.slice('--references-dir='.length));
  } else if (arg === '-h' || arg === '--help') {
    process.stdout.write(`${USAGE}\n`);
    process.exit(0);
  } else {
    console.error(`Unknown option: ${arg}`);
    console.error(USAGE.trimEnd());
    process.exit(2);
  }
}

if (!options.step) {
  console.error('Error: --step is required');
  console.error(USAGE.trimEnd());
  process.exit(2);
}

// 默认路径
if (!options.mapPath) {
  options.mapPath = path.join(__dirname, '..', 'references', 'scene-trigger-map.md');
}
if (!options.referencesDir) {
  options.referencesDir = path.join(__dirname, '..', 'references');
}

// ════════════════════════════════════════════════════════════
//  scene-trigger-map.md 解析
// ════════════════════════════════════════════════════════════

/**
 * 解析 scene-trigger-map.md，返回结构化的加载规则
 * 只解析"## 一、加载规则"部分，跳过"## 二、文件详细说明"等后续部分
 */
function parseSceneTriggerMap(mapText) {
  const sections = [];
  let currentSection = null;
  let inTable = false;
  let inRulesSection = false; // 是否在"一、加载规则"部分

  const lines = mapText.split(/\r?\n/);

  for (const line of lines) {
    // 检测 ## 级 header（大节标题）
    const h2Match = line.match(/^##\s+(.+)/);
    if (h2Match) {
      const title = h2Match[1].trim();
      // 只解析"一、加载规则"部分
      inRulesSection = title.includes('加载规则');
      inTable = false;
      currentSection = null;
      continue;
    }

    // 不在加载规则部分，跳过
    if (!inRulesSection) continue;

    // 检测 ### 级 section header
    const sectionMatch = line.match(/^###\s+(.+)/);
    if (sectionMatch) {
      currentSection = { title: sectionMatch[1].trim(), rows: [] };
      sections.push(currentSection);
      inTable = false;
      continue;
    }

    // 检测 table 行
    if (line.includes('|') && line.trim().startsWith('|')) {
      const parts = line.split('|');
      // 去掉首尾空元素（因为行以|开头和结尾）
      const trimmedParts = parts.slice(1, parts.length - 1).map(p => p.trim());

      // 跳过分隔行
      if (trimmedParts.every(p => p.match(/^[-:]+$/) || p === '')) {
        inTable = true;
        continue;
      }

      // 表头行
      if (!inTable && trimmedParts.length > 0) {
        inTable = true;
        continue;
      }

      // 数据行
      if (inTable && currentSection && trimmedParts.length > 0) {
        currentSection.rows.push(trimmedParts);
      }
    } else if (line.trim() && !line.trim().startsWith('|')) {
      inTable = false;
    }
  }

  return sections;
}

/**
 * 从表格行中提取文件名
 * 核心常驻集: 第1列是文件名
 * 其他集: "加载文件" 列是文件名
 */
function extractFileName(row, sectionTitle) {
  if (!row || row.length === 0) return null;

  // 核心常驻集 — 文件在第1列
  if (sectionTitle.includes('核心常驻集')) {
    return row[0];
  }

  // 其他集 — 找"加载文件"列（通常是第2列）
  // 触发条件 | 加载文件 | 加载指令
  // 或 触发条件 | 加载文件
  if (row.length >= 2) {
    return row[1];
  }

  return null;
}

/**
 * 从表格行中提取触发条件
 */
function extractTriggerCondition(row, sectionTitle) {
  if (!row || row.length === 0) return '';

  // 核心常驻集 — 无触发条件（始终加载）
  if (sectionTitle.includes('核心常驻集')) {
    return 'always';
  }

  // 其他集 — 触发条件在第1列
  return row[0] || '';
}

// ════════════════════════════════════════════════════════════
//  触发条件匹配
// ════════════════════════════════════════════════════════════

/**
 * 判断触发条件是否匹配当前参数
 */
function matchesTrigger(condition, sectionTitle, opts) {
  if (!condition || condition === 'always') return true;

  const cond = condition.toLowerCase();

  // ── scene_type 匹配 ──
  if (cond.includes('scene_type')) {
    if (!opts.scene) return false;
    // 解析 scene_type in [core, important]
    const sceneMatch = condition.match(/scene_type\s*(?:in\s*)?\[([^\]]+)\]/i);
    if (sceneMatch) {
      const sceneList = sceneMatch[1].split(',').map(s => s.trim().toLowerCase());
      if (!sceneList.includes(opts.scene.toLowerCase())) return false;
    }
    // 解析 scene_type == transitional
    const sceneEqMatch = condition.match(/scene_type\s*==\s*(\w+)/i);
    if (sceneEqMatch) {
      if (opts.scene.toLowerCase() !== sceneEqMatch[1].toLowerCase()) return false;
    }
  }

  // ── 内容标签匹配 ──
  if (cond.includes('内容标签')) {
    if (!opts.contentTag) return false;
    const tagMatch = condition.match(/内容标签\s*[=＝]\s*(\S+)/);
    if (tagMatch) {
      if (!opts.contentTag.includes(tagMatch[1])) return false;
    }
  }

  // ── dialogue_ratio 匹配 ──
  if (cond.includes('dialogue_ratio')) {
    if (opts.dialogueRatio === null) return false;
    const ratioMatch = condition.match(/dialogue_ratio\s*>\s*(\d+)/i);
    if (ratioMatch) {
      if (opts.dialogueRatio <= parseInt(ratioMatch[1], 10)) return false;
    }
  }

  // ── 新角色登场 ──
  if (cond.includes('新角色')) {
    if (!opts.newCharacter) return false;
  }

  // ── 步骤匹配 ──
  // 步骤触发集: "03b 质检", "04 精修", "05 去AI味"
  const stepMatch = condition.match(/^(\d+[a-z]?)\s/);
  if (stepMatch && sectionTitle.includes('步骤触发集')) {
    if (!opts.step || !opts.step.toLowerCase().startsWith(stepMatch[1].toLowerCase())) return false;
  }

  // ── genre 匹配 ──
  if (cond.includes('genre')) {
    if (!opts.genre) return false;
    const genreMatch = condition.match(/genre\s*==\s*["'"]([^"'"]+)["'"']/i);
    if (genreMatch) {
      if (opts.genre !== genreMatch[1]) return false;
    }
    // 也匹配 "or" 分隔的多个 genre
    const genreOrMatch = condition.match(/genre\s*==\s*["'"]([^"'"]+)["'"]\s*or\s*["'"]([^"'"]+)["'"']/i);
    if (genreOrMatch) {
      if (opts.genre !== genreOrMatch[1] && opts.genre !== genreOrMatch[2]) return false;
    }
  }

  // ── 02a 模块触发集 ──
  if (sectionTitle.includes('02a')) {
    if (!opts.step || opts.step.toLowerCase() !== '02a') return false;

    // 首批建纲（前10章）
    if (cond.includes('首批建纲') || cond.includes('前10章')) {
      if (opts.chapter === null || opts.chapter > 10) return false;
    }
    // 滚动补纲（5-10章）
    if (cond.includes('滚动补纲')) {
      if (opts.chapter === null || opts.chapter <= 10) return false;
    }
    // 卷首章
    if (cond.includes('卷首章')) {
      if (opts.chapterType !== 'opening') return false;
    }
    // 高潮章
    if (cond.includes('高潮章')) {
      if (opts.chapterType !== 'climax') return false;
    }
    // 发现细纲变对话脚本
    if (cond.includes('发现细纲变对话脚本')) {
      // 这个条件需要人工判断，默认不自动加载
      return false;
    }
  }

  return true;
}

// ════════════════════════════════════════════════════════════
//  文件行数统计
// ════════════════════════════════════════════════════════════

/**
 * 统计文件行数
 */
function countFileLines(filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    return content.split(/\r?\n/).length;
  } catch (_e) {
    return -1; // 文件不存在
  }
}

/**
 * 清理文件名（去除可能的 markdown 格式标记和括号说明）
 * 只返回以 .md 结尾的文件名，非文件名返回 null
 */
function cleanFileName(fileName) {
  if (!fileName) return null;
  // 去除 `Read references/xxx.md` 中的路径前缀
  let cleaned = fileName.replace(/Read\s+references\//i, '').replace(/`/g, '').trim();
  // 去除括号说明（中文和英文括号）
  cleaned = cleaned.replace(/（[^）]*）/g, '').replace(/\([^)]*\)/g, '').trim();
  // 去除 [ARCHIVED] 标记
  cleaned = cleaned.replace(/\[ARCHIVED\]/gi, '').trim();
  // 如果还有路径分隔，取最后部分
  if (cleaned.includes('/')) {
    cleaned = cleaned.split('/').pop().trim();
  }
  // 只接受以 .md 结尾的文件名
  if (!cleaned.toLowerCase().endsWith('.md')) return null;
  // 过滤掉被删除线标记的文件名 (~~xxx~~)
  if (cleaned.includes('~~')) return null;
  return cleaned;
}

// ════════════════════════════════════════════════════════════
//  主流程
// ════════════════════════════════════════════════════════════

function main() {
  // 读取 scene-trigger-map.md
  let mapText;
  try {
    mapText = fs.readFileSync(options.mapPath, 'utf8');
  } catch (error) {
    console.error(`错误: 无法读取 scene-trigger-map.md: ${options.mapPath}`);
    console.error(error.message);
    process.exit(2);
  }

  // 解析映射表
  const sections = parseSceneTriggerMap(mapText);

  // 需要跳过的按需加载集（不会自动触发）
  const ON_DEMAND_SECTIONS = ['语言素材集', '方法论集', '协议集'];

  // 收集匹配的文件
  const fileSet = new Set(); // 用 Set 去重

  for (const section of sections) {
    // 跳过按需加载集
    if (ON_DEMAND_SECTIONS.some(s => section.title.includes(s))) continue;

    for (const row of section.rows) {
      const condition = extractTriggerCondition(row, section.title);
      const rawFileName = extractFileName(row, section.title);

      if (!rawFileName) continue;

      // 检查触发条件
      if (matchesTrigger(condition, section.title, options)) {
        const fileName = cleanFileName(rawFileName);
        if (fileName && fileName.length > 2) {
          fileSet.add(fileName);
        }
      }
    }
  }

  // 统计每个文件的行数
  const fileList = [];
  let totalLines = 0;
  let missingFiles = 0;

  for (const fileName of fileSet) {
    const filePath = path.join(options.referencesDir, fileName);
    const lines = countFileLines(filePath);
    if (lines < 0) {
      missingFiles += 1;
      fileList.push({
        file: fileName,
        path: filePath,
        lines: 0,
        status: 'missing',
        estimated_tokens: 0,
      });
    } else {
      totalLines += lines;
      fileList.push({
        file: fileName,
        path: filePath,
        lines: lines,
        status: 'ok',
        estimated_tokens: lines * TOKENS_PER_LINE,
      });
    }
  }

  // 排序：存在的文件在前，按行数降序
  fileList.sort((a, b) => {
    if (a.status === 'ok' && b.status !== 'ok') return -1;
    if (a.status !== 'ok' && b.status === 'ok') return 1;
    return b.lines - a.lines;
  });

  const estimatedTokens = totalLines * TOKENS_PER_LINE;
  const hasWarning = totalLines > CONTEXT_LINE_WARNING;

  const result = {
    step: options.step,
    chapter: options.chapter,
    scene: options.scene,
    content_tag: options.contentTag,
    genre: options.genre,
    dialogue_ratio: options.dialogueRatio,
    new_character: options.newCharacter,
    chapter_type: options.chapterType,
    files: fileList,
    summary: {
      total_files: fileList.length,
      files_found: fileList.filter(f => f.status === 'ok').length,
      files_missing: missingFiles,
      total_lines: totalLines,
      estimated_tokens: estimatedTokens,
      warning: hasWarning,
      warning_message: hasWarning ? `总行数 ${totalLines} 超过 ${CONTEXT_LINE_WARNING} 行阈值，可能超出上下文窗口` : null,
    },
  };

  // 输出
  if (options.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    console.log('═══════════════════════════════════════════════════════');
    console.log('  上下文预算估算');
    console.log('═══════════════════════════════════════════════════════');
    console.log(`步骤: ${options.step}  章节: ${options.chapter || '—'}  场景: ${options.scene || '—'}  内容标签: ${options.contentTag || '—'}`);
    console.log(`题材: ${options.genre || '—'}  对话占比: ${options.dialogueRatio !== null ? options.dialogueRatio + '%' : '—'}  新角色: ${options.newCharacter ? '是' : '否'}`);
    console.log('');
    console.log('── 文件加载列表 ──');
    for (const f of fileList) {
      const status = f.status === 'ok' ? '✓' : '✗';
      console.log(`  ${status} ${f.file} (${f.lines} 行, ~${f.estimated_tokens} tokens)`);
    }
    console.log('');
    console.log('── 汇总 ──');
    console.log(`  文件总数:     ${result.summary.total_files}`);
    console.log(`  已找到:       ${result.summary.files_found}`);
    console.log(`  缺失:         ${result.summary.files_missing}`);
    console.log(`  总行数:       ${totalLines}`);
    console.log(`  预估token数:  ~${estimatedTokens}`);
    console.log('');

    if (hasWarning) {
      console.log(`⚠️  WARNING: 总行数 ${totalLines} 超过 ${CONTEXT_LINE_WARNING} 行阈值，可能超出上下文窗口。`);
      console.log(`   建议精简加载列表或使用模块化按需加载。`);
    } else {
      console.log('✅ 上下文预算在安全范围内。');
    }
  }

  // Exit code
  if (hasWarning) process.exit(1);
  process.exit(0);
}

main();

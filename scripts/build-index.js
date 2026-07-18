#!/usr/bin/env node
'use strict';

/**
 * build-index.js — 轻量级文件索引
 *
 * 扫描所有章节正文 + 衔接包 + 角色状态文件，生成关键词索引。
 * 对每个文件提取关键词（角色名/地点名/物品名/伏笔关键词），
 * 构建 { keyword: [{chapter, position, context_snippet}] } 索引。
 *
 * 输出到 追踪/index.json。
 * 索引文件大小超过 500KB 时输出 WARNING。
 *
 * 用法：node build-index.js [--project=<path>] [--rebuild] [--query="关键词"]
 *        [--chapters=1-50] [--json]
 *
 * Exit codes: 0=成功, 1=有warning(索引过大), 2=错误
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const USAGE = `Usage: node build-index.js [options]

Build a lightweight keyword index from chapter files and handoff packages.
  --project=<path>   project root (default: cwd)
  --rebuild          force full rebuild (ignore existing index)
  --query="keyword"  quick query mode: search existing index
  --chapters=1-50    chapter range filter (e.g., 1-50 or 1,3,5 or 1-10,20-30)
  --json             output JSON to stdout

Index is written to <project>/追踪/index.json.
WARNING if index exceeds 500KB.`;

// 索引大小告警阈值（500KB）
const INDEX_SIZE_WARNING = 500 * 1024;

// 上下文片段长度（关键字前后各取的字符数）
const CONTEXT_RADIUS = 30;

// ════════════════════════════════════════════════════════════
//  参数解析
// ════════════════════════════════════════════════════════════

const options = {
  project: process.cwd(),
  rebuild: false,
  query: null,
  chapters: null,
  json: false,
};

for (let i = 2; i < process.argv.length; i += 1) {
  const arg = process.argv[i];
  if (arg.startsWith('--project=')) {
    options.project = path.resolve(arg.slice('--project='.length));
  } else if (arg === '--rebuild') {
    options.rebuild = true;
  } else if (arg.startsWith('--query=')) {
    options.query = arg.slice('--query='.length);
  } else if (arg.startsWith('--chapters=')) {
    options.chapters = arg.slice('--chapters='.length);
  } else if (arg === '--json') {
    options.json = true;
  } else if (arg === '-h' || arg === '--help') {
    process.stdout.write(`${USAGE}\n`);
    process.exit(0);
  } else {
    console.error(`Unknown option: ${arg}`);
    console.error(USAGE.trimEnd());
    process.exit(2);
  }
}

// ════════════════════════════════════════════════════════════
//  章节范围解析
// ════════════════════════════════════════════════════════════

/**
 * 解析章节范围字符串，返回章节号 Set
 * 支持: "1-50", "1,3,5", "1-10,20-30"
 */
function parseChapterRange(rangeStr) {
  if (!rangeStr) return null;
  const chapters = new Set();
  const parts = rangeStr.split(',');
  for (const part of parts) {
    const trimmed = part.trim();
    const rangeMatch = trimmed.match(/^(\d+)\s*-\s*(\d+)$/);
    if (rangeMatch) {
      const start = parseInt(rangeMatch[1], 10);
      const end = parseInt(rangeMatch[2], 10);
      for (let i = start; i <= end; i += 1) {
        chapters.add(i);
      }
    } else {
      const num = parseInt(trimmed, 10);
      if (!isNaN(num)) chapters.add(num);
    }
  }
  return chapters.size > 0 ? chapters : null;
}

// ════════════════════════════════════════════════════════════
//  关键词提取
// ════════════════════════════════════════════════════════════

// 对话标签模式：提取角色名（2-4字 + 说道/道/笑道等）
// 使用非贪婪量词避免将对话标签的一部分捕获为角色名
const DIALOGUE_TAG_RE = /([\u4e00-\u9fff]{2,4}?)(?:说道?|道|笑道|喊道?|叫道?|问|答|怒道|冷道|低声道?|轻声道?|叹道|沉声道?|嘶声道?|冷笑道|苦笑道|微笑道|嘟囔道|嘀咕道|喃喃道)/g;

// 地点名模式：2-3字 + 常见地点后缀（非贪婪）
const LOCATION_RE = /([\u4e00-\u9fff]{2,3}?(?:城|谷|山|河|林|殿|阁|楼|院|宫|门|派|宗|族|镇|村|岛|崖|洞|塔|桥|街|巷|府|庄|堂|室|房|营|寨|关|峡|渊|海|湖|溪|泉|峰|岭|坡|原|野|漠|泽))/g;

// 物品名模式：2-4字 + 常见物品后缀（非贪婪）
const ITEM_RE = /([\u4e00-\u9fff]{2,4}?(?:剑|刀|枪|弓|盾|铠|甲|杖|珠|玉|戒|链|印|符|卷|书|册|瓶|丹|药|茶|酒|令|牌|镜|琴|笛|箫|鼓|钟|鼎|炉|灯|伞|扇|帕|囊|袋|筐|箱|柜|床|桌|椅|碗|杯|壶|盘))/g;

// 伏笔关键词标记
const FORESHADOW_RE = /【?伏笔】?|【?悬念】?|【?线索】?|【?秘密】?|【?谜团】?|【?疑问】?/g;

/**
 * 从 novel_meta.json 提取角色名列表
 */
function loadCharacterNames(projectRoot) {
  try {
    let raw = fs.readFileSync(path.join(projectRoot, 'novel_meta.json'), 'utf8');
    // 剥离 UTF-8 BOM（PowerShell Set-Content -Encoding UTF8 会添加 BOM）
    if (raw.charCodeAt(0) === 0xFEFF) {
      raw = raw.slice(1);
    }
    const meta = JSON.parse(raw);
    const names = [];
    if (meta.characters && Array.isArray(meta.characters)) {
      for (const char of meta.characters) {
        if (typeof char === 'string') {
          names.push(char);
        } else if (char.name) {
          names.push(char.name);
        }
      }
    }
    if (meta.character_names && Array.isArray(meta.character_names)) {
      names.push(...meta.character_names);
    }
    return names;
  } catch (_e) {
    return [];
  }
}

/**
 * 提取文本中的所有关键词
 * @returns {Array<{keyword, position, context, type}>}
 */
function extractKeywords(text, knownCharacterNames) {
  const keywords = [];
  const foundPositions = new Set(); // 去重：(keyword + position)

  function addKeyword(keyword, position, type) {
    const key = keyword + ':' + position;
    if (foundPositions.has(key)) return;
    foundPositions.add(key);

    // 前缀过滤：跳过以常见虚词/动词后缀开头的关键词
    // 已知角色名不受前缀过滤影响
    if (keyword.length > 0 && PREFIX_FILTER.has(keyword[0]) && !knownCharacterNames.includes(keyword)) {
      return;
    }
    // 过滤词检查
    if (FILTER_WORDS.has(keyword)) return;

    // 提取上下文片段
    const start = Math.max(0, position - CONTEXT_RADIUS);
    const end = Math.min(text.length, position + keyword.length + CONTEXT_RADIUS);
    let context = text.slice(start, end);
    // 清理换行
    context = context.replace(/\r?\n/g, ' ').trim();
    if (context.length > 80) context = context.slice(0, 77) + '...';

    keywords.push({ keyword, position, context, type });
  }

  // 1. 已知角色名（来自 novel_meta.json）
  for (const name of knownCharacterNames) {
    let idx = text.indexOf(name);
    while (idx !== -1) {
      addKeyword(name, idx, 'character');
      idx = text.indexOf(name, idx + name.length);
    }
  }

  // 2. 对话标签提取的角色名
  DIALOGUE_TAG_RE.lastIndex = 0;
  let match;
  while ((match = DIALOGUE_TAG_RE.exec(text)) !== null) {
    const name = match[1];
    // 过滤掉非名字的常见词
    if (!FILTER_WORDS.has(name)) {
      addKeyword(name, match.index, 'character');
    }
  }

  // 3. 地点名
  LOCATION_RE.lastIndex = 0;
  while ((match = LOCATION_RE.exec(text)) !== null) {
    addKeyword(match[0], match.index, 'location');
  }

  // 4. 物品名
  ITEM_RE.lastIndex = 0;
  while ((match = ITEM_RE.exec(text)) !== null) {
    addKeyword(match[0], match.index, 'item');
  }

  // 5. 伏笔关键词
  FORESHADOW_RE.lastIndex = 0;
  while ((match = FORESHADOW_RE.exec(text)) !== null) {
    addKeyword(match[0], match.index, 'foreshadow');
  }

  return keywords;
}

// 过滤词表：对话标签匹配中常见的非角色名词
const FILTER_WORDS = new Set([
  '于是', '然后', '但是', '不过', '因为', '所以', '虽然', '尽管',
  '如果', '假如', '倘若', '只要', '只有', '除非', '一旦', '万一',
  '他们', '她们', '我们', '你们', '自己', '别人', '他人', '大家',
  '这个', '那个', '这些', '那些', '什么', '怎么', '为何', '为什么',
  '这样', '那样', '怎样', '怎么', '于是', '因此', '所以',
  '他没', '她没', '它没', '他有', '她有', '它有',
  '他是', '她是', '它是', '他在', '她在', '它在',
  '他一', '她一', '它一', '他走', '她走', '它走',
  '他看', '她看', '它看', '他想', '她想', '它想',
  '他说', '她说', '它说', '他笑', '她笑', '它笑',
  '一瞬', '一刻', '一时', '一片', '一阵', '一股',
  '忽然', '突然', '顿时', '霎时', '瞬间', '转眼',
]);

// 前缀过滤：关键词首字为以下虚词/动词后缀时跳过（避免 "了天云城" 这类误提取）
const PREFIX_FILTER = new Set([
  '了', '的', '是', '在', '有', '到', '从', '去', '这', '那',
  '一', '不', '他', '她', '它', '我', '你', '把', '被', '让',
  '给', '对', '向', '为', '与', '和', '或', '及', '着', '过',
  '又', '再', '也', '都', '就', '才', '只', '还', '已', '将',
  '要', '能', '会', '可', '应', '该', '须', '得', '须', '需',
  '便', '即', '则', '而', '且', '并', '其', '此', '某', '每',
  '各', '另', '本', '该', '某', '无', '非', '勿', '别', '莫',
  '看', '听', '想', '说', '笑', '走', '来', '去', '坐', '站',
  '握', '拿', '放', '推', '拉', '打', '踢', '跑', '跳', '飞',
]);

// ════════════════════════════════════════════════════════════
//  文件扫描
// ════════════════════════════════════════════════════════════

/**
 * 从文件名提取章节号
 */
function extractChapterNum(filename) {
  const match = filename.match(/(\d+)/);
  return match ? parseInt(match[1], 10) : null;
}

/**
 * 扫描目录中的 .md/.txt 文件
 */
function scanDirectory(dirPath, chapterFilter) {
  const files = [];
  try {
    const entries = fs.readdirSync(dirPath);
    for (const entry of entries) {
      if (!entry.endsWith('.md') && !entry.endsWith('.txt')) continue;
      const chapterNum = extractChapterNum(entry);
      if (chapterFilter && chapterNum !== null && !chapterFilter.has(chapterNum)) continue;
      files.push({
        filename: entry,
        path: path.join(dirPath, entry),
        chapter_num: chapterNum,
      });
    }
  } catch (_e) {
    // 目录不存在
  }
  return files;
}

/**
 * 计算文件内容的 hash（用于增量更新判断）
 */
function fileHash(content) {
  return crypto.createHash('md5').update(content).digest('hex').slice(0, 8);
}

// ════════════════════════════════════════════════════════════
//  索引构建
// ════════════════════════════════════════════════════════════

/**
 * 构建关键词索引
 */
function buildIndex(projectRoot, chapterFilter, knownCharacterNames) {
  const index = {}; // { keyword: [{chapter, file, line, context, type}] }
  let totalFiles = 0;
  let totalEntries = 0;
  const fileHashes = {};

  // 扫描正文/终稿/
  const chapterDir = path.join(projectRoot, '正文', '终稿');
  const chapterFiles = scanDirectory(chapterDir, chapterFilter);

  // 扫描 细纲/衔接包链/
  const handoffDir = path.join(projectRoot, '细纲', '衔接包链');
  const handoffFiles = scanDirectory(handoffDir, chapterFilter);

  // 处理章节文件
  for (const file of chapterFiles) {
    let content;
    try {
      content = fs.readFileSync(file.path, 'utf8');
    } catch (_e) {
      continue;
    }
    totalFiles += 1;
    fileHashes[file.filename] = fileHash(content);

    const keywords = extractKeywords(content, knownCharacterNames);
    const lines = content.split(/\r?\n/);

    // 计算每个关键字位置对应的行号
    for (const kw of keywords) {
      // 通过偏移量计算行号
      let lineNum = 1;
      let offset = 0;
      for (let i = 0; i < lines.length; i += 1) {
        const lineEnd = offset + lines[i].length;
        if (kw.position >= offset && kw.position <= lineEnd) {
          lineNum = i + 1;
          break;
        }
        offset = lineEnd + 1; // +1 for newline
      }

      if (!index[kw.keyword]) {
        index[kw.keyword] = [];
      }
      index[kw.keyword].push({
        chapter: file.chapter_num,
        file: file.filename,
        source: 'chapter',
        line: lineNum,
        context: kw.context,
        type: kw.type,
      });
      totalEntries += 1;
    }
  }

  // 处理衔接包文件
  for (const file of handoffFiles) {
    let content;
    try {
      content = fs.readFileSync(file.path, 'utf8');
    } catch (_e) {
      continue;
    }
    totalFiles += 1;
    fileHashes[file.filename] = fileHash(content);

    const keywords = extractKeywords(content, knownCharacterNames);
    const lines = content.split(/\r?\n/);

    for (const kw of keywords) {
      let lineNum = 1;
      let offset = 0;
      for (let i = 0; i < lines.length; i += 1) {
        const lineEnd = offset + lines[i].length;
        if (kw.position >= offset && kw.position <= lineEnd) {
          lineNum = i + 1;
          break;
        }
        offset = lineEnd + 1;
      }

      if (!index[kw.keyword]) {
        index[kw.keyword] = [];
      }
      index[kw.keyword].push({
        chapter: file.chapter_num,
        file: file.filename,
        source: 'handoff',
        line: lineNum,
        context: kw.context,
        type: kw.type,
      });
      totalEntries += 1;
    }
  }

  return {
    keywords: index,
    metadata: {
      built_at: new Date().toISOString(),
      total_files: totalFiles,
      total_keywords: Object.keys(index).length,
      total_entries: totalEntries,
      file_hashes: fileHashes,
      chapter_filter: options.chapters || null,
    },
  };
}

// ════════════════════════════════════════════════════════════
//  查询模式
// ════════════════════════════════════════════════════════════

/**
 * 在索引中查询关键词
 */
function queryIndex(indexData, query) {
  const keywords = indexData.keywords || {};
  const results = [];

  // 精确匹配
  if (keywords[query]) {
    results.push({ keyword: query, exact: true, entries: keywords[query] });
  }

  // 模糊匹配（关键词包含查询词）
  for (const key in keywords) {
    if (key === query) continue;
    if (key.includes(query) || query.includes(key)) {
      results.push({ keyword: key, exact: false, entries: keywords[key] });
    }
  }

  return results;
}

// ════════════════════════════════════════════════════════════
//  主流程
// ════════════════════════════════════════════════════════════

function main() {
  const projectRoot = options.project;
  const trackingDir = path.join(projectRoot, '追踪');
  const indexPath = path.join(trackingDir, 'index.json');

  // ── 查询模式 ──
  if (options.query) {
    let indexData;
    try {
      indexData = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
    } catch (_e) {
      console.error(`错误: 索引文件不存在或无法读取: ${indexPath}`);
      console.error('请先运行 build-index.js 构建索引。');
      process.exit(2);
    }

    const results = queryIndex(indexData, options.query);
    const totalMatches = results.reduce((sum, r) => sum + r.entries.length, 0);

    if (options.json) {
      process.stdout.write(`${JSON.stringify({
        query: options.query,
        total_matches: totalMatches,
        results: results,
      }, null, 2)}\n`);
    } else {
      console.log('═══════════════════════════════════════════════════════');
      console.log(`  关键词查询: "${options.query}"`);
      console.log('═══════════════════════════════════════════════════════');
      console.log(`匹配结果: ${results.length} 个关键词, ${totalMatches} 条记录`);
      console.log('');

      for (const result of results) {
        const marker = result.exact ? '★' : '○';
        console.log(`${marker} ${result.keyword} (${result.entries.length} 条)`);
        for (const entry of result.entries.slice(0, 10)) {
          console.log(`  第${entry.chapter || '?'}章 ${entry.file}:${entry.line} [${entry.source}/${entry.type}]`);
          console.log(`    ${entry.context}`);
        }
        if (result.entries.length > 10) {
          console.log(`  ...还有 ${result.entries.length - 10} 条`);
        }
        console.log('');
      }

      if (results.length === 0) {
        console.log('未找到匹配结果。');
      }
    }
    process.exit(0);
  }

  // ── 构建/重建模式 ──
  const chapterFilter = parseChapterRange(options.chapters);
  const knownCharacterNames = loadCharacterNames(projectRoot);

  // 检查是否已有索引（非 rebuild 模式下可增量更新）
  let existingIndex = null;
  if (!options.rebuild) {
    try {
      existingIndex = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
    } catch (_e) {
      // 无现有索引，全量构建
    }
  }

  // 构建索引
  const indexData = buildIndex(projectRoot, chapterFilter, knownCharacterNames);

  // 如果有现有索引且非 rebuild，合并未在本次扫描范围内的条目
  if (existingIndex && !options.rebuild && existingIndex.keywords) {
    const scannedFiles = new Set(Object.keys(indexData.metadata.file_hashes));
    for (const keyword in existingIndex.keywords) {
      for (const entry of existingIndex.keywords[keyword]) {
        // 如果该文件不在本次扫描范围内，保留旧条目
        if (!scannedFiles.has(entry.file)) {
          if (!indexData.keywords[keyword]) {
            indexData.keywords[keyword] = [];
          }
          indexData.keywords[keyword].push(entry);
        }
      }
    }
    // 重新统计
    indexData.metadata.total_keywords = Object.keys(indexData.keywords).length;
    indexData.metadata.total_entries = Object.values(indexData.keywords).reduce((sum, entries) => sum + entries.length, 0);
    indexData.metadata.previous_built_at = existingIndex.metadata ? existingIndex.metadata.built_at : null;
  }

  // 检查索引大小
  const indexJSON = JSON.stringify(indexData, null, 2);
  const indexSize = Buffer.byteLength(indexJSON, 'utf8');
  const hasWarning = indexSize > INDEX_SIZE_WARNING;

  // 写入索引文件
  try {
    if (!fs.existsSync(trackingDir)) {
      fs.mkdirSync(trackingDir, { recursive: true });
    }
    fs.writeFileSync(indexPath, indexJSON, 'utf8');
  } catch (error) {
    console.error(`错误: 无法写入索引文件 ${indexPath}: ${error.message}`);
    process.exit(2);
  }

  // 输出
  if (options.json) {
    process.stdout.write(`${JSON.stringify({
      status: 'built',
      index_path: indexPath,
      metadata: indexData.metadata,
      index_size_bytes: indexSize,
      index_size_kb: parseFloat((indexSize / 1024).toFixed(1)),
      warning: hasWarning,
    }, null, 2)}\n`);
  } else {
    console.log('═══════════════════════════════════════════════════════');
    console.log('  关键词索引构建完成');
    console.log('═══════════════════════════════════════════════════════');
    console.log(`索引文件: ${indexPath}`);
    console.log(`构建模式: ${options.rebuild ? '全量重建' : (existingIndex ? '增量更新' : '首次构建')}`);
    console.log(`章节过滤: ${options.chapters || '无（全部章节）'}`);
    console.log(`已知角色: ${knownCharacterNames.length > 0 ? knownCharacterNames.join(', ') : '未从 novel_meta.json 加载'}`);
    console.log('');
    console.log('── 索引统计 ──');
    console.log(`  扫描文件数:   ${indexData.metadata.total_files}`);
    console.log(`  关键词总数:   ${indexData.metadata.total_keywords}`);
    console.log(`  索引条目数:   ${indexData.metadata.total_entries}`);
    console.log(`  索引大小:     ${(indexSize / 1024).toFixed(1)} KB`);
    console.log('');

    // 按类型统计关键词
    const typeStats = { character: 0, location: 0, item: 0, foreshadow: 0 };
    for (const keyword in indexData.keywords) {
      for (const entry of indexData.keywords[keyword]) {
        if (typeStats[entry.type] !== undefined) {
          typeStats[entry.type] += 1;
        }
      }
    }
    console.log('── 关键词类型分布 ──');
    console.log(`  角色名:   ${typeStats.character} 条`);
    console.log(`  地点名:   ${typeStats.location} 条`);
    console.log(`  物品名:   ${typeStats.item} 条`);
    console.log(`  伏笔词:   ${typeStats.foreshadow} 条`);
    console.log('');

    // 高频关键词 Top 10
    const sortedKeywords = Object.entries(indexData.keywords)
      .sort((a, b) => b[1].length - a[1].length)
      .slice(0, 10);
    if (sortedKeywords.length > 0) {
      console.log('── 高频关键词 Top 10 ──');
      for (const [keyword, entries] of sortedKeywords) {
        console.log(`  ${keyword}: ${entries.length} 次`);
      }
      console.log('');
    }

    if (hasWarning) {
      console.log(`⚠️  WARNING: 索引文件大小 ${(indexSize / 1024).toFixed(1)} KB 超过 500KB 阈值。`);
      console.log(`   建议使用 --chapters 参数限定章节范围，或清理不再需要的条目。`);
    } else {
      console.log('✅ 索引大小在正常范围内。');
    }
  }

  if (hasWarning) process.exit(1);
  process.exit(0);
}

main();

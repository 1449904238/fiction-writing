#!/usr/bin/env node
'use strict';

/**
 * check-slang-density.js — 网络梗密度/堆砌/题材冲突/叙述者越权检测（V6.1.0 新增）
 *
 * 定位：可选脚本（Phase 2 网络梗 — 确定性检测）。若脚本缺失，由 05 去AI味
 * Gate 7 人工校验替代。本脚本提供可复现的量化检测，不替代人工口味判断。
 *
 * 检测维度：
 *   1. 密度    ：每章网络梗出现总次数 vs --threshold（默认 4 条/章）
 *   2. 堆砌    ：同一条梗在同一章重复出现的次数
 *   3. 题材冲突：梗条目的"适用题材"与 --genre 不匹配（例：历史/严肃题材禁用）
 *   4. 叙述者越权：梗出现在引号外的第三人称叙述层（素材库明确禁止）
 *
 * 用法：
 *   node check-slang-density.js <file...> [--library=FILE] [--genre=都市/玄幻...]
 *                 [--threshold=N] [--repeat=N] [--json]
 *
 * 默认 dry-run 只报告；本脚本只读，不写入任何文件。
 * 素材库默认读取 scripts/../references/网络梗素材库.md。
 * 题材→允许时效等级映射对齐 SKILL.md"网感方向启用决策"；封锁题材（历史/严肃等）
 * 出现任何网络梗均报冲突。混合题材（如"都市悬疑"）取严格侧（对齐素材库"双题材取严格侧"）。
 * 密度阈值默认 3（对齐素材库日常章上限），核心章建议 2、高潮章 0。
 */

const fs = require('fs');
const path = require('path');

const USAGE = `Usage: node check-slang-density.js <file...> [options]

Detect net-slang density, repetition, genre conflict and narrator overreach.
  <file...>          Chapter/draft text files to scan (required)
  --library=FILE     Slang library markdown (default references/网络梗素材库.md)
  --genre=NAME       Target genre for conflict check (e.g. 都市/玄幻/历史)
  --threshold=N      Max slang uses per file (default 3; core chapter 2, climax 0)
  --repeat=N         Max repeats of a single slang per file (default 2)
  --json             Output JSON instead of markdown
`;

/** 题材→允许时效等级（对齐 SKILL.md 网感方向启用决策；空数组=禁用） */
const GENRE_TIER_LIMITS = {
  '都市': ['S', 'A', 'B'],
  '职场': ['S', 'A', 'B'],
  '系统': ['S', 'A', 'B'],
  '轻小说': ['S', 'A', 'B', 'C'],
  '二次元': ['S', 'A', 'B', 'C'],
  '玄幻': ['S', 'A'],
  '修仙': ['S', 'A'],
  '科幻': ['S', 'A'],
  '末世': ['S', 'A'],
  '废土': ['S', 'A'],
  '无限流': ['S', 'A'],
  // 穿越异世界：中度网感，允许 S+A；'穿越' 用 includes 匹配 穿越异世界/穿越
  '穿越': ['S', 'A'],
  '电竞': ['S', 'A'],
  // 重生流/竞技体育：克制网感，仅 S 级
  '重生': ['S'],
  '竞技': ['S'],
  '言情': ['S'],
  '武侠': ['S'],
  '同人': ['S'],
  // 封锁题材：禁用网络梗（悬疑/恐怖/盗墓/历史/严肃）
  '盗墓': [],
  '悬疑': [],
  '恐怖': [],
  '历史': [],
  '严肃': [],
};

function parseArgs(argv) {
  const args = { files: [], library: null, genre: null, threshold: 3, repeat: 2, json: false };
  for (const arg of argv.slice(2)) {
    if (arg === '--help' || arg === '-h') {
      console.log(USAGE);
      process.exit(0);
    } else if (arg === '--json') {
      args.json = true;
    } else if (arg.startsWith('--library=')) {
      args.library = arg.slice('--library='.length);
    } else if (arg.startsWith('--genre=')) {
      args.genre = arg.slice('--genre='.length);
    } else if (arg.startsWith('--threshold=')) {
      args.threshold = Number.parseInt(arg.slice('--threshold='.length), 10);
    } else if (arg.startsWith('--repeat=')) {
      args.repeat = Number.parseInt(arg.slice('--repeat='.length), 10);
    } else if (arg.startsWith('-') && arg !== '-') {
      console.error(`Unknown option: ${arg}`);
      process.exit(2);
    } else {
      args.files.push(arg);
    }
  }
  if (Number.isNaN(args.threshold)) args.threshold = 3;
  if (Number.isNaN(args.repeat)) args.repeat = 2;
  return args;
}

/** 引号字符对（用于判断文本跨度是否位于对话/内心吐槽内） */
const QUOTE_PAIRS = [
  ['\u201c', '\u201d'], // “ ”
  ['\u2018', '\u2019'], // ‘ ’
  ['「', '」'],
  ['『', '』'],
  ['【', '】'],
  ['"', '"'],
];

/** 判断 text 中 index 处是否落在某个引号对内部（简单成对扫描） */
function isInsideQuotes(text, index) {
  for (const [open, close] of QUOTE_PAIRS) {
    let depth = 0;
    for (let i = 0; i < index; i += 1) {
      const ch = text[i];
      if (open === close) {
        if (ch === open) depth ^= 1;
      } else if (ch === open) {
        depth += 1;
      } else if (ch === close && depth > 0) {
        depth -= 1;
      }
    }
    if (depth % 2 === 1) return true;
  }
  return false;
}

/** 解析网络梗素材库 markdown 表，返回条目数组 {term, tier, genres[], risk} */
function parseLibrary(file) {
  let src;
  try {
    src = fs.readFileSync(file, 'utf8');
  } catch (e) {
    throw new Error(`无法读取素材库 ${file}: ${e.message}`);
  }
  const entries = [];
  const lines = src.split(/\r?\n/);
  let inItems = false; // 仅在“四、网络梗条目”区间内收集，避免误吞时效/题材路由/场景规范等非条目表格
  for (const raw of lines) {
    const t = raw.trim();
    if (/^#{1,6}\s/.test(t)) {
      // 进入“网络梗条目”小节后，子标题(### 4.x)保持收集；遇到其它顶级标题则结束
      if (/网络梗条目/.test(t)) inItems = true;
      else if (!/^4\.\d/.test(t.replace(/^#+\s*/, ''))) inItems = false;
      continue;
    }
    if (!inItems) continue;
    if (!t.startsWith('|')) continue;
    // 跳过表头 / 分隔行
    if (/^\|[-\s|]*$/.test(t)) continue;
    if (/^\|\s*条目\s*\|/.test(t)) continue;
    const cells = t.replace(/^\||\|$/g, '').split('|').map((c) => c.trim().replace(/^`|`$/g, ''));
    const term = cells[0];
    if (!term || term.length === 0) continue;
    const tier = (cells[2] || '').trim();
    // 时效列必须为 S/A/B/C；否则视为非条目表格的杂行，跳过
    if (!['S', 'A', 'B', 'C'].includes(tier)) continue;
    entries.push({
      term,
      tier,
      genres: (cells[3] || '').split(/[/、，,]/).map((g) => g.trim()).filter(Boolean),
      risk: cells[7] || '?',
    });
  }
  return entries;
}

function countOccurrences(text, term) {
  const needle = term.toLowerCase();
  const hay = text.toLowerCase();
  const positions = [];
  let idx = hay.indexOf(needle);
  while (idx !== -1) {
    positions.push(idx);
    idx = hay.indexOf(needle, idx + needle.length);
  }
  return positions;
}

function analyzeFile(filePath, entries, args) {
  const text = fs.readFileSync(filePath, 'utf8');
  const hits = []; // {term, tier, risk, narrator, repeatOf, position}
  const perTerm = {};
  for (const e of entries) {
    const positions = countOccurrences(text, e.term);
    if (positions.length === 0) continue;
    const lineStarts = [];
    let ls = 0;
    const lines = text.split(/\r?\n/);
    for (const l of lines) {
      lineStarts.push(ls);
      ls += l.length + 1;
    }
    for (const pos of positions) {
      let lineNo = 0;
      for (let i = lineStarts.length - 1; i >= 0; i -= 1) {
        if (lineStarts[i] <= pos) { lineNo = i + 1; break; }
      }
      const narrator = !isInsideQuotes(text, pos);
      hits.push({ term: e.term, tier: e.tier, risk: e.risk, narrator, position: pos, line: lineNo });
    }
    perTerm[e.term] = { tier: e.tier, risk: e.risk, count: positions.length };
  }

  // 题材冲突：先按 SKILL.md 网感路由的"题材→允许等级"判定，未命中映射再回退到条目适用题材列
  const conflicts = [];
  for (const h of hits) {
    const entry = entries.find((x) => x.term === h.term);
    if (!entry) continue;
    const genres = entry.genres;
    // 题材匹配：收集全部命中键，多题材取严格侧（对齐素材库"双题材取严格侧"），空数组（禁用）最严
    let genreKey = null;
    if (args.genre && args.genre.trim()) {
      const g = args.genre.trim();
      const matches = Object.keys(GENRE_TIER_LIMITS).filter((k) => g.includes(k) || k.includes(g));
      if (matches.length > 0) {
        genreKey = matches.reduce((strict, k) => (GENRE_TIER_LIMITS[k].length < GENRE_TIER_LIMITS[strict].length ? k : strict));
      }
    }
    if (genreKey) {
      const allowed = GENRE_TIER_LIMITS[genreKey];
      if (allowed.length === 0) {
        conflicts.push({ term: h.term, reason: `题材 ${args.genre} 禁用网络梗`, line: h.line });
      } else if (!allowed.includes(entry.tier)) {
        conflicts.push({ term: h.term, reason: `题材 ${args.genre} 限 ${allowed.join('+')} 级，条目为 ${entry.tier} 级`, line: h.line });
      }
    } else if (genres.includes('禁用')) {
      conflicts.push({ term: h.term, reason: '素材库标记禁用', line: h.line });
    } else if (args.genre && genres.length > 0 && !genres.some((g) => g.includes(args.genre) || args.genre.includes(g))) {
      conflicts.push({ term: h.term, reason: `题材 ${args.genre} 不在适用 ${genres.join('/')}`, line: h.line });
    }
  }

  const narratorOverreach = hits.filter((h) => h.narrator);
  const crowded = Object.keys(perTerm).filter((t) => perTerm[t].count > args.repeat);
  const excessive = hits.length > args.threshold;

  const problems = [];
  if (excessive) problems.push(`密度超标：${hits.length} 条 > 阈值 ${args.threshold}`);
  if (crowded.length) problems.push(`堆砌：${crowded.map((t) => `${t}x${perTerm[t].count}`).join('，')}（单条 > ${args.repeat}）`);
  if (narratorOverreach.length) problems.push(`叙述者越权：${narratorOverreach.length} 处（引号外叙述层）`);
  const seen = new Set();
  for (const c of conflicts) {
    const key = `${c.term}|${c.reason}`;
    if (seen.has(key)) continue;
    seen.add(key);
    problems.push(`题材冲突：${c.term}（${c.reason}）L${c.line}`);
  }

  return {
    file: filePath,
    total: hits.length,
    distinct: Object.keys(perTerm).length,
    byTerm: perTerm,
    narratorOverreach: narratorOverreach.map((h) => ({ term: h.term, line: h.line })),
    conflicts,
    problems,
    verdict: problems.length ? 'advisory' : 'ok',
  };
}

function main() {
  const args = parseArgs(process.argv);
  if (args.files.length === 0) {
    console.error('缺少输入文件。用法见 --help。');
    process.exit(2);
  }
  const scriptDir = __dirname;
  const library = args.library || path.join(scriptDir, '..', 'references', '网络梗素材库.md');
  let entries;
  try {
    entries = parseLibrary(library);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }

  const results = args.files.map((f) => {
    try {
      return analyzeFile(f, entries, args);
    } catch (e) {
      console.error('无法读取文件 ' + f + ': ' + e.message);
      process.exit(2);
    }
  });
  const overall = results.every((r) => r.verdict === 'ok') ? 'ok' : 'advisory';

  if (args.json) {
    console.log(JSON.stringify({ overall, library, entries: entries.length, files: results }, null, 2));
    process.exit(overall === 'ok' ? 0 : 1);
  }

  console.log(`# 网络梗检测报告（库 ${entries.length} 条）\n`);
  for (const r of results) {
    console.log(`## ${r.file}`);
    console.log(`- 状态：${r.verdict === 'ok' ? 'OK' : '需复核'}`);
    console.log(`- 密度：${r.total} 次 / ${r.distinct} 个不同梗`);
    if (Object.keys(r.byTerm).length) {
      const top = Object.entries(r.byTerm)
        .sort((a, b) => b[1].count - a[1].count)
        .map(([t, d]) => `${t}(x${d.count},${d.tier}级,风险${d.risk})`)
        .join('、');
      console.log(`- 明细：${top}`);
    }
    for (const p of r.problems) console.log(`- ⚠ ${p}`);
    console.log('');
  }
  process.exit(overall === 'ok' ? 0 : 1);
}

if (require.main === module) {
  main();
}

module.exports = { parseLibrary, analyzeFile, isInsideQuotes };

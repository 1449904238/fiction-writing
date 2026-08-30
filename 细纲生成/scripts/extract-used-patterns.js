#!/usr/bin/env node
'use strict';

/**
 * extract-used-patterns.js — 跨章句式/意象提取，生成去重清单（V6.1.0 新增）
 *
 * 定位：可选脚本。读取近 N 章草稿（默认 --lookback=3），提取已被使用的
 * 句式模式与比喻意象，输出"跨章去重清单"，供下一章列为禁用项。
 * 若脚本缺失，05 去AI味由人工维护该清单，可跳过。
 *
 * 提取内容：
 *   1. 句式模板：如"不是A而是B"、"仿佛X一样"、段首过渡词堆叠、固定套语
 *   2. 比喻意象：像/如同/好似/宛如…一般/似的 等明喻句
 *   3. 高频套语：在所有输入文件中重复出现的短语（去重优先级高）
 *
 * 用法：
 *   node extract-used-patterns.js <file...> [--lookback=N] [--repeat=K]
 *                 [--output=FILE] [--json]
 *
 * 默认 dry-run 只打印到 stdout；加 --output=FILE 才写入清单（markdown）。
 */

const fs = require('fs');
const path = require('path');

const USAGE = `Usage: node extract-used-patterns.js <file...> [options]

Extract reused sentence patterns and imagery from recent chapters.
  <file...>          Recent chapter files to scan (required, ordered oldest->newest)
  --lookback=N       Keep only the last N files (default 3)
  --repeat=K         Phrase must appear >=K times overall to be listed (default 2)
  --output=FILE      Write checklist markdown to FILE (default: stdout only)
  --json             Output JSON instead of markdown
`;

function parseArgs(argv) {
  const args = { files: [], lookback: 3, repeat: 2, output: null, json: false };
  for (const arg of argv.slice(2)) {
    if (arg === '--help' || arg === '-h') {
      console.log(USAGE);
      process.exit(0);
    } else if (arg === '--json') {
      args.json = true;
    } else if (arg.startsWith('--lookback=')) {
      args.lookback = Number.parseInt(arg.slice('--lookback='.length), 10);
    } else if (arg.startsWith('--repeat=')) {
      args.repeat = Number.parseInt(arg.slice('--repeat='.length), 10);
    } else if (arg.startsWith('--output=')) {
      args.output = arg.slice('--output='.length);
    } else if (arg.startsWith('-') && arg !== '-') {
      console.error(`Unknown option: ${arg}`);
      process.exit(2);
    } else {
      args.files.push(arg);
    }
  }
  if (Number.isNaN(args.lookback)) args.lookback = 3;
  if (Number.isNaN(args.repeat)) args.repeat = 2;
  return args;
}

/** 明喻/比喻句式模板：捕获"像/如同/仿佛/宛如…(一般|一样|似的)" */
const SIMILE_RE = /(?:像|如同|仿佛|宛如|好似|恰如)[^，。！？!?；\n]{2,28}(?:一般|一样|似的|般)/g;

/** 常见套语/模板句式（出现即计数，用于跨章去重） */
const PATTERN_TERMS = [
  '不是', '而是', '忍不住', '不由得', '不禁',
  '与此同时', '就在这时', '刹那间', '须臾间', '转眼间',
  '看似', '实则', '居然', '竟然', '果然', '难怪',
  '一瞬间', '下一秒', '下一刻',
];

function countMatches(text, re) {
  const out = [];
  let m;
  const r = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
  r.lastIndex = 0;
  while ((m = r.exec(text)) !== null) {
    out.push({ text: m[0], position: m.index });
    if (m[0].length === 0) r.lastIndex += 1;
  }
  return out;
}

function extractFromFile(filePath) {
  const text = fs.readFileSync(filePath, 'utf8');
  const metaphors = countMatches(text, SIMILE_RE).map((m) => m.text);
  const patterns = {};
  for (const term of PATTERN_TERMS) {
    const n = countMatches(text, new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')).length;
    if (n > 0) patterns[term] = (patterns[term] || 0) + n;
  }
  return { file: filePath, metaphors: [...new Set(metaphors)], patternCounts: patterns };
}

function aggregate(results, repeat) {
  // 比喻：跨文件去重，仅列出现 >1 次的
  const metaFreq = {};
  for (const r of results) {
    for (const m of r.metaphors) metaFreq[m] = (metaFreq[m] || 0) + 1;
  }
  const reusedMetaphors = Object.entries(metaFreq)
    .filter(([, n]) => n >= repeat)
    .map(([m, n]) => ({ value: m, count: n }));

  // 句式：累计次数 >= repeat 的
  const patAgg = {};
  for (const r of results) {
    for (const [p, n] of Object.entries(r.patternCounts)) {
      patAgg[p] = (patAgg[p] || 0) + n;
    }
  }
  const reusedPatterns = Object.entries(patAgg)
    .filter(([, n]) => n >= repeat)
    .sort((a, b) => b[1] - a[1])
    .map(([p, n]) => ({ value: p, count: n }));

  return {
    files: results.map((r) => r.file),
    reusedMetaphors,
    reusedPatterns,
  };
}

function renderMarkdown(agg) {
  const lines = [];
  lines.push('# 跨章去重清单');
  lines.push('');
  lines.push(`> 扫描范围：${agg.files.join(' ← ')}`);
  lines.push('> 下一章禁用项（避免与近几章重复）；可手动维护，脚本仅辅助。');
  lines.push('');
  lines.push('## 重复意象/比喻');
  lines.push('');
  if (agg.reusedMetaphors.length === 0) {
    lines.push('（无跨章重复比喻）');
  } else {
    for (const m of agg.reusedMetaphors) {
      lines.push(`- 禁用：${m.value}（已用 ${m.count} 次）`);
    }
  }
  lines.push('');
  lines.push('## 高频句式（慎用复制）');
  lines.push('');
  if (agg.reusedPatterns.length === 0) {
    lines.push('（无跨章重复句式）');
  } else {
    for (const p of agg.reusedPatterns) {
      lines.push(`- 注意：${p.value}（已出现 ${p.count} 次）`);
    }
  }
  return lines.join('\n') + '\n';
}

function main() {
  const args = parseArgs(process.argv);
  if (args.files.length === 0) {
    console.error('缺少输入文件。用法见 --help。');
    process.exit(2);
  }

  const recent = args.files.slice(-args.lookback);
  const results = recent.map((f) => {
    try {
      return extractFromFile(f);
    } catch (e) {
      console.error('无法读取文件 ' + f + ': ' + e.message);
      process.exit(2);
    }
  });
  const agg = aggregate(results, args.repeat);

  if (args.json) {
    console.log(JSON.stringify({ lookback: args.lookback, aggregate: agg }, null, 2));
  } else {
    const md = renderMarkdown(agg);
    if (args.output) {
      const dir = path.dirname(path.resolve(args.output));
      fs.mkdirSync(dir, { recursive: true });
      const tmp = path.resolve(args.output) + '.tmp';
      fs.writeFileSync(tmp, md, 'utf8');
      fs.renameSync(tmp, path.resolve(args.output));
      console.log(`已写入 ${args.output}`);
    } else {
      process.stdout.write(md);
    }
  }
  process.exit(0);
}

if (require.main === module) {
  main();
}

module.exports = { SIMILE_RE, PATTERN_TERMS, extractFromFile, aggregate, renderMarkdown };

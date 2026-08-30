#!/usr/bin/env node
'use strict';

/**
 * aggregate-volume.js — 卷文件聚合（V6.1.1 新增）
 *
 * 将一卷内的逐章产物（细纲 .md + 衔接包 .md + chapter_delta .json 或 md 内嵌 Delta）
 * 聚合为两个卷级文件，形成独立的交付/归档形态：
 *   <out-dir>/卷<volume>_细纲与衔接.md   —— 人读聚合（各章按【CH-XXXX】锚点分隔）
 *   <out-dir>/卷<volume>_delta.json      —— 机读增量（chapters[] 聚合本书卷内所有章 delta）
 *
 * 设计原则：只做"打包"，不改动任何逐章文件；merge-delta.js / compress-handoff.js
 * 仍按逐章契约工作。聚合文件是独立产物，供整卷通读、归档、备查。
 *
 * 用法：
 *   node aggregate-volume.js --volume=V-01 --out=细纲/卷V-01 [细纲/Ch1_细纲.md 细纲/Ch1_衔接包.md chapter_delta_Ch1.json ...]
 *   node aggregate-volume.js --volume=V-01 --out=细纲/卷V-01 --dir=细纲/Ch*.md --dir=细纲/接*Ch*.md
 *   --dir=GLOB   按 glob 追加输入（可多次）
 *   --name=NAME  可选，输出文件名前缀，默认用 --volume
 *   --write      真正写文件（默认 dry-run 只打印摘要）
 */

const fs = require('fs');
const path = require('path');

const USAGE = `Usage: node aggregate-volume.js --volume=V-01 [--out=DIR] [--name=NAME] [--write] [--json] <files...>
  --volume=ID     卷标识，用于输出命名（默认 V-01 这类）
  --out=DIR       输出目录（默认 ./）
  --name=NAME     输出文件名前缀（默认同 volume）
  --dir=GLOB      追加一组输入（glob，可多次）
  --write         写文件（默认 dry-run）
  --json          输出 JSON 摘要
`;

function parseArgs(argv) {
  const a = { volume: null, out: '.', name: null, write: false, json: false, files: [], dirs: [] };
  for (const arg of argv.slice(2)) {
    if (arg === '--write') a.write = true;
    else if (arg === '--json') a.json = true;
    else if (arg.startsWith('--volume=')) a.volume = arg.split('=')[1];
    else if (arg.startsWith('--out=')) a.out = arg.split('=')[1];
    else if (arg.startsWith('--name=')) a.name = arg.split('=')[1];
    else if (arg.startsWith('--dir=')) a.dirs.push(arg.split('=')[1]);
    else if (!arg.startsWith('--')) a.files.push(arg);
    else if (arg === '--help' || arg === '-h') { console.log(USAGE); process.exit(0); }
  }
  if (!a.volume) {
    console.error('[aggregate-volume] --volume is required');
    console.log(USAGE);
    process.exit(1);
  }
  // 展开 dirs glob
  for (const g of a.dirs) {
    if (globHasWildcard(g)) {
      const matches = expandGlob(g);
      a.files.push(...matches);
    } else if (fs.existsSync(g)) {
      a.files.push(g);
      if (fs.statSync(g).isDirectory()) {
        const all = fs.readdirSync(g).map(n => path.join(g, n));
        a.files.push(...all.filter(f => /\.(md|json)$/i.test(f)));
      }
    }
  }
  // 去重保序
  a.files = [...new Set(a.files)];
  a.name = a.name || a.volume;
  return a;
}

function globHasWildcard(s) { return /[*?\[]/.test(s); }

function expandGlob(glob) {
  // 极简 glob：目录部分 + 模式部分。支持普通 * 匹配文件名。
  const seg = glob.replace(/\\/g, '/');
  const slashIdx = seg.lastIndexOf('/');
  const dir = slashIdx >= 0 ? seg.slice(0, slashIdx) : '.';
  const pat = slashIdx >= 0 ? seg.slice(slashIdx + 1) : seg;
  if (!fs.existsSync(dir)) return [];
  const re = new RegExp('^' + pat.split('*').map(e => e.replace(/[.+^${}()|[\]\\]/g, '\\$&')).join('.*') + '$', 'i');
  return fs.readdirSync(dir).filter(n => re.test(n)).map(n => path.join(dir, n)).sort();
}

// 从内容里抽取一个【CH-XXXX】或 Ch.XXXX 章节编号
function chapterOf(file, text) {
  const m = (file.match(/Ch[-_]?(\d+)/i) || text.match(/Ch[:.\-s]*(\d+)|【CH[-_]?(\d+)】/)) || [];
  return parseInt(m[1] || m[2] || '0', 10) || 0;
}

// 从 md 的 ```json 块抽取第一个 delta 对象（合并校验/结果字段）
function extractDelta(text, chapter) {
  const m = text.match(/```json\n([\s\S]*?)\n```/);
  if (!m) return null;
  try {
    const obj = JSON.parse(m[1]);
    // 接受 {chapter, delta:{...}} 或 {delta:{...}}
    const core = obj;
    if (core && core.chapter === undefined) core.chapter = chapter;
    return core;
  } catch { return null; }
}

function parseInput(file) {
  const ext = path.extname(file).toLowerCase();
  const isJson = ext === '.json';
  let raw = '';
  try { raw = fs.readFileSync(file, 'utf-8'); } catch { return null; }

  let chapter = chapterOf(file, raw);
  let delta = null;
  let kind = 'other';

  if (isJson) {
    try {
      const obj = JSON.parse(raw);
      // chapter_delta_ChX.json: 顶层即 delta 对象
      delta = obj;
      chapter = obj.chapter || chapter;
      kind = 'delta';
    } catch { kind = 'other'; }
  } else {
    // md：区分细纲与衔接包
    if (/【衔接包|\[衔接包/.test(raw)) { kind = 'handoff'; }
    else if (/【内容概括|【章节结构|大纲五检|模块执行确认/.test(raw)) { kind = 'outline'; }
    else { kind = 'md-other'; }
    delta = extractDelta(raw, chapter);
  }
  return { file, chapter, kind, delta, raw };
}

function main() {
  const a = parseArgs(process.argv);
  if (a.files.length === 0) {
    console.error('[aggregate-volume] no input files given (or none matched --dir)');
    console.log(USAGE);
    process.exit(1);
  }

  const items = a.files.map(parseInput).filter(Boolean)
    .sort((x, y) => x.chapter - y.chapter || x.file.localeCompare(y.file));

  const outlines = items.filter(i => i.kind === 'outline');
  const handoffs = items.filter(i => i.kind === 'handoff');
  const deltas = items.map(i => i.delta).filter(Boolean);

  // 组装人读聚合 md
  const sep = '════════════════════════════════════════════';
  const mdParts = [`# 卷聚合 · ${a.volume} · 细纲与衔接包`, `> 由 aggregate-volume.js 聚合生成 · 章节单元以【CH-XXXX】锚点分隔`, ``];
  const mdOutlines = items.filter(i => i.kind === 'outline' || i.kind === 'handoff');
  if (mdOutlines.length === 0) {
    mdParts.push(`<!-- 未找到细纲/衔接包 md 输入，仅有 delta 文件 -->`);
  } else {
    for (const it of mdOutlines) {
      mdParts.push(`${sep}`);
      mdParts.push(`【CH-${String(it.chapter).padStart(4, '0')}】 · ${it.kind === 'outline' ? '细纲' : '衔接包'} · ${path.basename(it.file)}`);
      mdParts.push(`${sep}`);
      mdParts.push(it.raw.trim());
      mdParts.push('');
    }
  }
  const md = mdParts.join('\n');

  // 组装机读 delta json
  const volJson = {
    contract_version: 'volume.1',
    volume: a.volume,
    aggregated_at: new Date().toISOString(),
    chapter_count: deltas.length,
    chapters: deltas,
  };

  if (!a.write) {
    const lines = [
      `[dry-run] aggregator would write:`,
      `  md   : ${path.join(a.out, a.name + '_细纲与衔接.md')}  (${md.length} chars, ${mdOutlines.length} 章单元)`,
      `  json : ${path.join(a.out, a.name + '_delta.json')}  (${JSON.stringify(volJson, null, 2).length} chars, ${deltas.length} 章 delta)`,
    ];
    console.log(lines.join('\n'));
    return;
  }

  fs.mkdirSync(a.out, { recursive: true });
  const mdPath = path.join(a.out, a.name + '_细纲与衔接.md');
  const jPath = path.join(a.out, a.name + '_delta.json');
  fs.writeFileSync(mdPath, md, 'utf-8');
  fs.writeFileSync(jPath, JSON.stringify(volJson, null, 2), 'utf-8');
  const summary = `[aggregate-volume ${a.volume}] 写入 ${mdPath} (${md.length} chars) / ${jPath} (${deltas.length} 章 delta)`;
  if (a.json) console.log(JSON.stringify({ volume: a.volume, md: mdPath, json: jPath, md_chars: md.length, chapter_count: deltas.length }));
  else console.log(summary);
}

main();
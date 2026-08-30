#!/usr/bin/env node
'use strict';

/**
 * check-wordcount.js — 章节字数确定性校验
 *
 * 铁律2（3500-4500字）的机检执行器。LLM 自估字数不可靠，
 * 出稿前以本脚本结果为准。
 *
 * 计数口径：可见字符（中日韩表意文字 + 全角字母 + ASCII 字母数字），
 * 剔除：YAML front matter、markdown 结构行（标题/引用/列表/表格/分隔线）、
 * 围栏代码块、引号内对话不计的选项默认关闭（--narrative-only 开启）。
 *
 * 用法：node check-wordcount.js [--json] [--min=3500] [--max=4500] [--target=4000] [--narrative-only] <file...>
 *
 * Exit codes: 0=全部达标, 1=有不达标文件或读取失败
 */

const fs = require('fs');
const path = require('path');
const { stripQuoted, visibleLength, isDivider, isStructural, hasYamlFrontMatter } = require('./lib/prose-utils.js');

const USAGE = 'Usage: node check-wordcount.js [--json] [--min=3500] [--max=4500] [--target=4000] [--narrative-only] <file...>';

function parseArgs(argv) {
  const opts = { json: false, min: 3500, max: 4500, target: 4000, narrativeOnly: false, files: [] };
  for (const a of argv) {
    if (a === '--json') opts.json = true;
    else if (a === '--narrative-only') opts.narrativeOnly = true;
    else if (a.startsWith('--min=')) opts.min = Number(a.slice(6));
    else if (a.startsWith('--max=')) opts.max = Number(a.slice(6));
    else if (a.startsWith('--target=')) opts.target = Number(a.slice(9));
    else if (a === '--help' || a === '-h') { console.log(USAGE); process.exit(0); }
    else opts.files.push(a);
  }
  return opts;
}

function extractNarrative(file) {
  const raw = fs.readFileSync(file, 'utf8');
  let lines = raw.split(/\r?\n/);
  if (hasYamlFrontMatter(lines)) {
    const end = lines.findIndex((l, i) => i > 0 && l.trim() === '---');
    if (end !== -1) lines = lines.slice(end + 1);
  }
  const body = [];
  let inFence = false;
  for (const line of lines) {
    const t = line.trim();
    if (/^(```|~~~)/.test(t)) { inFence = !inFence; continue; }
    if (inFence) continue;
    if (!t || isDivider(t) || isStructural(t)) continue;
    body.push(t);
  }
  return body.join('\n');
}

function countFile(file, opts) {
  const narrative = extractNarrative(file);
  const text = opts.narrativeOnly ? stripQuoted(narrative) : narrative;
  const count = visibleLength(text);
  const ratioMin = count / opts.min;
  return { file, count, ok: count >= opts.min && count <= opts.max, ratioMin };
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.files.length === 0) { console.error(USAGE); process.exit(1); }

  const results = [];
  for (const f of opts.files) {
    if (!fs.existsSync(f)) {
      results.push({ file: f, error: '文件不存在' });
      continue;
    }
    results.push(countFile(f, opts));
  }

  const anyFail = results.some((r) => r.error || !r.ok);

  if (opts.json) {
    console.log(JSON.stringify({
      config: { min: opts.min, max: opts.max, target: opts.target, narrative_only: opts.narrativeOnly },
      results,
      all_ok: !anyFail,
    }, null, 2));
  } else {
    for (const r of results) {
      if (r.error) { console.log(`✗ ${path.basename(r.file)} — ${r.error}`); continue; }
      const state = r.ok ? '✓' : '✗';
      const hint = r.count < opts.min
        ? `欠账 ${opts.min - r.count} 字（当前 ${(r.count / opts.min * 100).toFixed(0)}% of min）→ 按字数欠账定位协议重写，禁止整体注水`
        : r.count > opts.max
          ? `超出 ${r.count - opts.max} 字 → 压过场、合并疏点、删过渡`
          : `达标，区间位置 ${((r.count - opts.min) / Math.max(1, opts.max - opts.min) * 100).toFixed(0)}%`;
      console.log(`${state} ${path.basename(r.file)} — 可见字数 ${r.count} [${opts.min}-${opts.max}] ${hint}`);
    }
    if (anyFail) console.log('\n结论：未达标。铁律2：以本脚本计数为准，先定位欠账场景再重写。');
    else console.log('\n结论：全部达标。');
  }
  process.exit(anyFail ? 1 : 0);
}

main();

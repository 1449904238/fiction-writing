#!/usr/bin/env node
'use strict';

/**
 * check-anchor-consistency.js — 数值/战力锚点一致性机检（独立版 · V5.0.0 配套）
 *
 * 核对正文是否与 delta.json 的 number_anchors_updated 保持一致（SKILL.md 铁律：
 * "正文数值须与 number_anchors 一致"）。对每个锚点 {key: value}：
 *   - 在正文中找到 key 出现的位置，提取上下文；
 *   - value 为数字：上下文出现其他不同数字 → blocking（数值冲突）
 *   - value 为字符串：上下文未出现该值 → advisory（可能未提及，不阻断）
 *
 * 用法：
 *   node check-anchor-consistency.js --delta=卷V-01_delta.json <正文文件...>
 * 退出码：0=通过 / 1=存在blocking冲突 / 2=用法错误或delta缺失
 * Report-only，永不改写文本。
 */
const fs = require('fs');
const path = require('path');

const USAGE = `Usage: node check-anchor-consistency.js --delta=<delta.json> [--json] <chapter-files...>

Verify number_anchors_updated values are consistent in chapter text.
Exit 0 = pass, 1 = blocking conflict, 2 = usage/delta error.`;

function loadAnchors(deltaPath) {
  const raw = JSON.parse(fs.readFileSync(deltaPath, 'utf-8'));
  const anchors = {};
  const chapters = raw.chapters || [];
  for (const ch of chapters) {
    const delta = ch.delta || {};
    const na = delta.number_anchors_updated;
    if (na && typeof na === 'object') {
      for (const [k, v] of Object.entries(na)) {
        anchors[k] = v; // 后章覆盖前章
      }
    }
  }
  return anchors;
}

// 提取一段文本中的数字（含中文数字一~九/十/百）
function extractNumbers(ctx) {
  const out = [];
  const re = /\d+(?:\.\d+)?|[一二三四五六七八九十百]+/g;
  let m;
  while ((m = re.exec(ctx)) !== null) out.push(m[0]);
  return out;
}

function cnToNum(s) {
  const map = { '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9 };
  if (/^[一二三四五六七八九]$/.test(s)) return map[s];
  if (s === '十') return 10;
  if (/^[一二三四五六七八九]十$/.test(s)) return map[s[0]] * 10;
  if (/^十[一二三四五六七八九]$/.test(s)) return 10 + map[s[1]];
  return null;
}

function numValue(s) {
  if (/^\d+(?:\.\d+)?$/.test(s)) return parseFloat(s);
  return cnToNum(s);
}

// 生成锚点 key 的候选搜索词（正文不会写字段名，需提取核心词）
function searchKeys(key) {
  const keys = [key];
  // 去掉常见字段后缀
  const stripped = key.replace(/(年数|编号|数量|数值|次数|天数|第.*天)$/, '');
  if (stripped !== key && stripped.length >= 2) keys.push(stripped);
  // 前缀匹配（如"周衡殉职年数"→"周衡殉职"）
  if (key.length > 5) keys.push(key.slice(0, 4));
  return keys;
}

function analyzeAnchors(anchors, text, name) {
  const findings = [];
  let blocking = 0;

  for (const [key, value] of Object.entries(anchors)) {
    if (key.length < 2) continue;
    // 依次用候选词搜索，取第一个命中的
    let hitKey = null;
    let hitCount = 0;
    for (const k of searchKeys(key)) {
      const re = new RegExp(k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
      let cnt = 0;
      let m;
      while ((re.exec(text)) !== null) cnt++;
      if (cnt > 0) { hitKey = k; hitCount = cnt; break; }
    }
    if (hitKey === null) continue; // 正文未提及该锚点核心词，跳过

    const re = new RegExp(hitKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
    const ctxs = [];
    let m;
    while ((m = re.exec(text)) !== null) {
      const dispStart = Math.max(0, m.index - 6);
      const dispEnd = Math.min(text.length, m.index + m[0].length + 12);
      // 数字提取窗口：仅取 key 之后 12 字，避免 key 前的相邻锚点值干扰
      const numStart = m.index + m[0].length;
      const numEnd = Math.min(text.length, numStart + 12);
      ctxs.push({
        display: text.slice(dispStart, dispEnd).replace(/\n/g, ' '),
        numWindow: text.slice(numStart, numEnd),
      });
    }

    if (typeof value === 'number') {
      // 数值锚点：取 key 后最近的一个数字核对
      const conflicts = [];
      for (const ctx of ctxs) {
        const nums = extractNumbers(ctx.numWindow);
        if (nums.length === 0) continue;
        const nv = numValue(nums[0]);
        if (nv !== null && nv !== value) {
          conflicts.push({ ctx: ctx.display, num: nums[0] });
        }
      }
      if (conflicts.length > 0) {
        blocking++;
        findings.push({
          key, expected: value, severity: 'blocking',
          detail: `${key} 锚点值=${value}，正文出现冲突数字 ${conflicts.map((c) => c.num).join('/')}`,
          sample: conflicts[0].ctx,
        });
      } else {
        findings.push({ key, expected: value, severity: 'pass', detail: `${key} 锚点值=${value}，正文一致` });
      }
    } else {
      // 字符串锚点：上下文出现该值 → 通过；否则 advisory（未提及）
      const found = ctxs.some((ctx) => ctx.display.includes(String(value)));
      findings.push({
        key, expected: value, severity: found ? 'pass' : 'advisory',
        detail: found ? `${key} 锚点值=${value}，正文一致` : `${key} 锚点值=${value}，正文未出现（可能未提及）`,
        sample: ctxs[0] ? ctxs[0].display : '',
      });
    }
  }

  return { file: name, blocking_count: blocking, findings };
}

function printReport(results) {
  for (const r of results) {
    console.log(`\n=== ${r.file} ===`);
    for (const f of r.findings) {
      const mark = f.severity === 'blocking' ? '❌' : f.severity === 'advisory' ? '⚠️' : '✅';
      console.log(`  ${mark} [${f.severity}] ${f.detail}`);
      if (f.sample) console.log(`        上下文: …${f.sample}…`);
    }
    console.log(`  blocking: ${r.blocking_count}`);
  }
}

function main() {
  const args = process.argv.slice(2);
  let deltaPath = null;
  let json = false;
  const files = [];
  for (const a of args) {
    if (a.startsWith('--delta=')) deltaPath = a.slice('--delta='.length);
    else if (a === '--json') json = true;
    else files.push(a);
  }
  if (!deltaPath || !files.length) {
    console.log(USAGE);
    process.exit(2);
  }
  let anchors;
  try {
    anchors = loadAnchors(deltaPath);
  } catch (e) {
    console.error(`无法读取 delta 文件: ${e.message}`);
    process.exit(2);
  }
  if (Object.keys(anchors).length === 0) {
    console.log('delta 中无 number_anchors_updated，跳过一致性检查。');
    process.exit(0);
  }

  const results = [];
  let hasBlocking = false;
  for (const f of files) {
    const text = fs.readFileSync(f, 'utf-8');
    const r = analyzeAnchors(anchors, text, path.basename(f));
    results.push(r);
    if (r.blocking_count > 0) hasBlocking = true;
  }
  if (json) {
    console.log(JSON.stringify(results, null, 2));
  } else {
    printReport(results);
    const total = results.reduce((s, r) => s + r.blocking_count, 0);
    console.log(`\n结论：${total} 处数值冲突。${hasBlocking ? '存在 blocking，修正正文数值后重跑。' : '通过。'}`);
  }
  process.exit(hasBlocking ? 1 : 0);
}

main();

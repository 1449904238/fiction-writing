#!/usr/bin/env node
'use strict';

/**
 * check-output-structure.js — 输出结构完整性机检（独立版 · V5.0.0 配套）
 *
 * 验证扩写产出是否包含 SKILL.md <输出格式> 规定的全部输出块：
 *   1. <五维锚点确认块>        （扩写前输出）
 *   2. <情节脱水预检面板>      （正文前输出）
 *   3. <used_patterns加载确认> （跨章去重数据加载确认或降级标注）
 *   4. 【小说正文】             （3500-4500字）
 *   5. <文本脱水度自检>        （8 项终检：1/2/3/4/5/6/7/8a/8b/8c/8d）
 *   6. <锐度保护清单>          （可选）
 *   7. 【定位报告】             （低分区域 + 模板句式清单 + 场景元素清单）
 *   8. 【创造配额使用记录】     （可选，如有）
 *
 * 用法：
 *   node check-output-structure.js [--json] <file...>
 * 退出码：0=结构完整 / 1=缺失强制块 / 2=用法错误
 * Report-only，永不改写文本。
 */
const fs = require('fs');
const path = require('path');

const USAGE = `Usage: node check-output-structure.js [--json] <file...>

Check required output blocks exist in a chapter output file.
Exit 0 = complete, 1 = missing required blocks, 2 = usage error.`;

// 强制块（缺失=结构不完整）
const REQUIRED_BLOCKS = [
  { key: 'five_dim', label: '<五维锚点确认块>', re: /<五维锚点确认块>/ },
  { key: 'precheck', label: '<情节脱水预检面板>', re: /<情节脱水预检面板>/ },
  { key: 'used_patterns', label: '<used_patterns加载确认>', re: /<used_patterns加载确认>|used_patterns加载确认/ },
  { key: 'loaded_materials', label: '<已加载素材清单>', re: /<已加载素材清单>/ },
  { key: 'body', label: '【小说正文】', re: /【小说正文】/ },
  { key: 'dehydrate', label: '<文本脱水度自检>', re: /<文本脱水度自检>/ },
  { key: 'report', label: '【定位报告】', re: /【定位报告】/ },
];

// 脱水自检子项（须含全部编号）
const DEHYDRATE_ITEMS = ['1', '2', '3', '4', '5', '6', '7', '8a', '8b', '8c', '8d'];

// 可选块
const OPTIONAL_BLOCKS = [
  { key: 'sharpness', label: '<锐度保护清单>（可选）', re: /<锐度保护清单>/ },
  { key: 'quota', label: '【创造配额使用记录】（可选）', re: /【创造配额使用记录】/ },
];

function analyze(text, name) {
  const blocks = [];
  let missingRequired = 0;

  for (const b of REQUIRED_BLOCKS) {
    const found = b.re.test(text);
    if (!found) missingRequired++;
    blocks.push({ key: b.key, label: b.label, required: true, found });
  }

  // 脱水自检子项
  const dehydrateSection = text.match(/<文本脱水度自检>([\s\S]*?)<\/文本脱水度自检>/);
  const dehydrateItems = [];
  if (dehydrateSection) {
    for (const item of DEHYDRATE_ITEMS) {
      // 8a/8b/8c/8d 单独处理，数字项按行首匹配
      const re = item.includes('8')
        ? new RegExp(`^${item}\\.|${item}[a-d]\\.`, 'm')
        : new RegExp(`^${item}\\.`, 'm');
      const found = re.test(dehydrateSection[1]);
      if (!found) missingRequired++;
      dehydrateItems.push({ id: item, found });
    }
  } else {
    for (const item of DEHYDRATE_ITEMS) {
      dehydrateItems.push({ id: item, found: false });
    }
    missingRequired += DEHYDRATE_ITEMS.length;
  }
  blocks.push({ key: 'dehydrate_items', label: '脱水自检8项编号', required: true, found: dehydrateItems.every((d) => d.found), detail: dehydrateItems });

  for (const b of OPTIONAL_BLOCKS) {
    blocks.push({ key: b.key, label: b.label, required: false, found: b.re.test(text) });
  }

  const verdict = missingRequired > 0 ? 'incomplete' : 'complete';
  return { file: name, verdict, missing_required: missingRequired, blocks };
}

function printReport(results) {
  for (const r of results) {
    console.log(`\n=== ${r.file} ===`);
    console.log(`结论: ${r.verdict === 'complete' ? '结构完整 ✅' : `缺失强制块 ${r.missing_required} 处 ❌`}`);
    for (const b of r.blocks) {
      if (b.key === 'dehydrate_items') {
        console.log(`  ${b.found ? '✅' : '❌'} [${b.required ? '强制' : '可选'}] 脱水自检8项编号: ${b.detail.map((d) => (d.found ? d.id : `✗${d.id}`)).join(' ')}`);
        continue;
      }
      console.log(`  ${b.found ? '✅' : b.required ? '❌' : '—'} [${b.required ? '强制' : '可选'}] ${b.label}`);
    }
  }
}

function main() {
  const args = process.argv.slice(2);
  let json = false;
  const files = [];
  for (const a of args) {
    if (a === '--json') json = true;
    else files.push(a);
  }
  if (!files.length) {
    console.log(USAGE);
    process.exit(2);
  }
  const results = [];
  let hasIncomplete = false;
  for (const f of files) {
    const text = fs.readFileSync(f, 'utf-8');
    const r = analyze(text, path.basename(f));
    results.push(r);
    if (r.verdict === 'incomplete') hasIncomplete = true;
  }
  if (json) {
    console.log(JSON.stringify(results, null, 2));
  } else {
    printReport(results);
    console.log(`\n结论：${results.length} 个文件，${hasIncomplete ? '存在结构缺失，补齐强制输出块后重跑。' : '全部结构完整。'}`);
  }
  process.exit(hasIncomplete ? 1 : 0);
}

main();

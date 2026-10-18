#!/usr/bin/env node
'use strict';

/**
 * check-ai-patterns.js — AI味模式机检（独立版 · V5.0.0 配套）
 *
 * 覆盖 6 项出稿前必须人工核对的项目，改为机检：
 *   1. metaphor_density  比喻密度（"像/仿佛/如同/似的" 计数 / 千字）—— 对话区不计
 *   2. emotion_words     叙述语直接情绪词计数（情绪词配额制铁律4/终检8c）
 *   3. not_is_comparison "不是A是B"句式计数（对话不计）—— 硬上限≤2次
 *   4. ai_visual_words   AI画面腔违禁词扫描（出现即blocking）
 *   5. negative_triple   否定排比三连扫描（出现即blocking）
 *   6. psych_direct      心理直给词扫描（叙述语出现即blocking；对话不计）
 *
 * 用法：
 *   node check-ai-patterns.js [--json] <file...>
 * 退出码：0=全部通过 / 1=存在blocking项 / 2=用法错误
 * Report-only，永不改写文本。
 */
const fs = require('fs');
const path = require('path');
const { stripQuoted, visibleLength, METAPHOR_DENSITY_BLOCK } = require('./lib/prose-utils.js');

const USAGE = `Usage: node check-ai-patterns.js [--json] <file...>

Check AI-flavor patterns (metaphor density / emotion words / not-is /
AI visual cliches / negative triples / psych-direct words).
Report-only. Exit 0 = pass, 1 = blocking, 2 = usage error.`;

// ── 词表 ─────────────────────────────────────────────
const EMOTION_WORDS = [
  '悲伤', '痛苦', '绝望', '愤怒', '狂喜', '恐惧', '震惊', '心酸',
  '委屈', '憋屈', '难过', '慌乱', '欣喜', '哀伤', '愤怒地', '绝望地',
  '恐惧地', '悲伤地', '冷冷地', '无情地', '愤怒的他'
];
const AI_VISUAL_WORDS = [
  '眼中闪过一丝', '嘴角微微上扬', '空气中弥漫着', '不禁', '不得不说',
  '仿佛在诉说着', '交织', '洗礼', '在这一刻', '时间仿佛静止'
];
const PSYCH_DIRECT_WORDS = [
  '他觉得', '她觉得', '他感到', '她感到', '他知道', '她明白',
  '他意识到', '她意识到', '他发现', '她发现', '这说明', '这意味着',
  '他心里明白', '她在想', '他在等', '显然', '可见'
];

// ── 检测函数 ─────────────────────────────────────────
function analyze(text, name) {
  const narrative = stripQuoted(text);           // 排除对话区
  const chars = visibleLength(narrative);        // 叙述区可见字数
  const perK = (n) => (chars > 0 ? (n * 1000) / chars : 0);

  const countRe = (re) => {
    const m = narrative.match(re);
    return m ? m.length : 0;
  };
  const samples = (re, limit = 3) => {
    const out = [];
    let m;
    const r = new RegExp(re.source, 'g');
    while ((m = r.exec(narrative)) !== null && out.length < limit) {
      out.push(m[0].slice(0, 30));
    }
    return out;
  };

  // 1. 比喻密度
  const metaphorN = countRe(/像|仿佛|如同|似的/g);
  const metaphorPerK = perK(metaphorN);

  // 2. 情绪词
  const emotionN = countRe(new RegExp(EMOTION_WORDS.join('|'), 'g'));

  // 3. 不是A是B
  const notIsN = countRe(/不是[^。！？；，]{1,24}[，,][^。！？；]{0,12}是|并非[^。！？；，]{1,24}而是/g);

  // 4. AI画面腔违禁词
  const aiVisualN = countRe(new RegExp(AI_VISUAL_WORDS.join('|'), 'g'));

  // 5. 否定排比三连
  const negativeTripleN = countRe(/(?:(?:没有|不是|并非)[^。！？；]{0,10}){3}/g);

  // 6. 心理直给词
  const psychDirectN = countRe(new RegExp(PSYCH_DIRECT_WORDS.join('|'), 'g'));

  // ── severity 判定 ──────────────────────────────
  const items = [];
  const add = (id, label, count, severity, limit, extra) => {
    items.push({ id, label, count, severity, limit: limit || null, sample: extra || [] });
  };

  // 比喻：≤3/千字 advisory 警示，≥4/千字 blocking
  if (metaphorPerK >= METAPHOR_DENSITY_BLOCK) {
    add('metaphor_density', '比喻密度', metaphorN, 'blocking', `${METAPHOR_DENSITY_BLOCK}次/千字`, samples(/像|仿佛|如同|似的/g));
  } else if (metaphorPerK >= 3) {
    add('metaphor_density', '比喻密度', metaphorN, 'advisory', '3次/千字', samples(/像|仿佛|如同|似的/g));
  } else {
    add('metaphor_density', '比喻密度', metaphorN, 'pass', '≤3次/千字');
  }

  // 情绪词：≤3 通过 | 4-6 advisory | >6 blocking
  if (emotionN > 6) {
    add('emotion_words', '叙述语情绪词', emotionN, 'blocking', '≤3次/章', samples(new RegExp(EMOTION_WORDS.join('|'), 'g')));
  } else if (emotionN >= 4) {
    add('emotion_words', '叙述语情绪词', emotionN, 'advisory', '≤3次/章', samples(new RegExp(EMOTION_WORDS.join('|'), 'g')));
  } else {
    add('emotion_words', '叙述语情绪词', emotionN, 'pass', '≤3次/章');
  }

  // 不是A是B：≤2 通过 | ≥3 blocking
  if (notIsN >= 3) {
    add('not_is_comparison', '"不是A是B"句式', notIsN, 'blocking', '≤2次/章', samples(/不是[^。！？；，]{1,24}[，,][^。！？；]{0,12}是|并非[^。！？；，]{1,24}而是/g));
  } else {
    add('not_is_comparison', '"不是A是B"句式', notIsN, 'pass', '≤2次/章');
  }

  // AI画面腔违禁词：出现即 blocking
  if (aiVisualN > 0) {
    add('ai_visual_words', 'AI画面腔违禁词', aiVisualN, 'blocking', '0次', samples(new RegExp(AI_VISUAL_WORDS.join('|'), 'g')));
  } else {
    add('ai_visual_words', 'AI画面腔违禁词', aiVisualN, 'pass', '0次');
  }

  // 否定排比三连：出现即 blocking
  if (negativeTripleN > 0) {
    add('negative_triple', '否定排比三连', negativeTripleN, 'blocking', '0次', samples(/(?:(?:没有|不是|并非)[^。！？；]{0,10}){3}/g));
  } else {
    add('negative_triple', '否定排比三连', negativeTripleN, 'pass', '0次');
  }

  // 心理直给词：出现即 blocking
  if (psychDirectN > 0) {
    add('psych_direct', '心理直给词', psychDirectN, 'blocking', '0次', samples(new RegExp(PSYCH_DIRECT_WORDS.join('|'), 'g')));
  } else {
    add('psych_direct', '心理直给词', psychDirectN, 'pass', '0次');
  }

  const blockingCount = items.filter((i) => i.severity === 'blocking').length;
  const advisoryCount = items.filter((i) => i.severity === 'advisory').length;

  return {
    file: name,
    narrative_chars: chars,
    metaphor_per_1k: Number(metaphorPerK.toFixed(1)),
    verdict: blockingCount > 0 ? 'blocking' : advisoryCount > 0 ? 'advisory' : 'pass',
    blocking_count: blockingCount,
    advisory_count: advisoryCount,
    items,
  };
}

function printReport(results) {
  for (const r of results) {
    console.log(`\n=== ${r.file} ===`);
    console.log(`叙述区字数: ${r.narrative_chars} | 比喻密度: ${r.metaphor_per_1k}/千字 | 结论: ${r.verdict.toUpperCase()}`);
    for (const it of r.items) {
      const mark = it.severity === 'blocking' ? '❌' : it.severity === 'advisory' ? '⚠️' : '✅';
      console.log(`  ${mark} [${it.severity}] ${it.label}: ${it.count} (上限${it.limit})`);
      for (const s of it.sample) console.log(`       样本: …${s}…`);
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
  let hasBlocking = false;
  for (const f of files) {
    const text = fs.readFileSync(f, 'utf-8');
    const r = analyze(text, path.basename(f));
    results.push(r);
    if (r.verdict === 'blocking') hasBlocking = true;
  }
  if (json) {
    console.log(JSON.stringify(results, null, 2));
  } else {
    printReport(results);
    const totalBlocking = results.reduce((s, r) => s + r.blocking_count, 0);
    const totalAdvisory = results.reduce((s, r) => s + r.advisory_count, 0);
    console.log(`\n结论：${results.length} 个文件，blocking ${totalBlocking} 项 / advisory ${totalAdvisory} 项。`);
    if (hasBlocking) console.log('存在 blocking 项，禁止出稿，按 SKILL.md 脱水重构后重跑。');
  }
  process.exit(hasBlocking ? 1 : 0);
}

main();

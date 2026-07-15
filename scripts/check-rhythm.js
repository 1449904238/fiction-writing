#!/usr/bin/env node
'use strict';

/**
 * check-rhythm.js — 跨章节节奏波形检测
 *
 * 检测 5 类节奏问题（只报告不修改）：
 *   - reward-gap (爽点间隔过大): 连续3章+无爽点关键词 → advisory
 *   - rhythm-collapse (节奏塌陷): 连续3章字数比前3章少30%+ → advisory
 *   - emotion-flat (情绪平坦): 连续3章无情绪波动关键词 → advisory
 *   - ratio-imbalance (篇幅配比失衡): 伏笔占比>20%或<5% → advisory
 *   - missing-hook (章末无钩子): 最后500字无钩子关键词 → advisory
 *   - sentence-variance (句长方差不足): 句长标准差<8 → advisory
 *
 * 用法：node check-rhythm.js [--check] [--json] <file...>
 * 输入为多个章节文件（按顺序传入），脚本跨章分析。
 * 只报告不修改。
 */

const fs = require('fs');
const path = require('path');
const { stripQuoted, visibleLength, isDivider, isStructural, hasYamlFrontMatter, splitSentences, parseFenceMarker } = require('./lib/prose-utils.js');

const USAGE = `Usage: node check-rhythm.js [--check] [--json] <file...>

Detect cross-chapter rhythm waveform issues:
  - reward-gap (爽点间隔过大): advisory
  - rhythm-collapse (节奏塌陷): advisory
  - emotion-flat (情绪平坦): advisory
  - ratio-imbalance (篇幅配比失衡): advisory
  - missing-hook (章末无钩子): advisory
  - sentence-variance (句长方差不足): advisory

Input: multiple chapter files in order. Cross-chapter analysis.
Report-only. Never rewrites text.`;

// --- 爽点关键词 ---
const REWARD_KEYWORDS = [
  '打脸', '翻盘', '碾压', '突破', '震惊', '反转', '秒杀', '吊打',
  '震撼', '倒吸凉气', '不敢置信',
];

// --- 情绪波动关键词 ---
const EMOTION_KEYWORDS = ['爽', '怒', '惊', '悲', '惧', '暖'];

// --- 篇幅配比关键词（7-2-1原则：70%主线 / 20%人设 / 10%伏笔）---
const PLOT_KEYWORDS = ['推进', '发现', '得知', '出发', '前往', '决定'];
const CHARACTER_KEYWORDS = ['回忆', '想起', '性格', '习惯', '口癖'];
const FORESHADOW_KEYWORDS = ['伏笔', '暗示', '线索', '异常'];

// --- 章末钩子关键词 ---
const HOOK_KEYWORDS = [
  '？', '?', '悬念', '未知', '突然', '只见', '然而', '就在这时',
  '不料', '谁知', '下一步', '到底', '究竟',
];

// --- 阈值 ---
const REWARD_GAP_WARN = 3;           // 连续3章无爽点 = 爽点真空
const REWARD_GAP_CRITICAL = 5;       // 连续5章无爽点 = 高危
const RHYTHM_DROP_RATIO = 0.7;       // 字数下降30%阈值
const EMOTION_FLAT_RUN = 3;          // 连续3章无情绪 = 情绪平坦
const RATIO_FORESHADOW_MIN = 0.05;   // 伏笔占比下限 5%
const RATIO_FORESHADOW_MAX = 0.20;   // 伏笔占比上限 20%
const RATIO_MIN_KEYWORDS = 5;        // 配比检测最少关键词数（低于则不具备统计意义）
const HOOK_TAIL_CHARS = 500;         // 章末检测窗口（字数）
const SENTENCE_STD_LOW = 8;          // 句长标准差下限（低于=突发度不足）
const SENTENCE_STD_HIGH = 25;        // 句长标准差上限（超过=人类特征，不标记）
const SENTENCE_MIN_COUNT = 10;       // 方差检测最少句子数

const options = { json: false, files: [] };

for (let i = 2; i < process.argv.length; i += 1) {
  const arg = process.argv[i];
  if (arg === '--check') { /* check-only 模式，脚本本身就是只读 */ }
  else if (arg === '--json') { options.json = true; }
  else if (arg === '-h' || arg === '--help') {
    process.stdout.write(`${USAGE}\n`);
    process.exit(0);
  } else if (arg.startsWith('-')) {
    die(`Unknown option: ${arg}`);
  } else {
    options.files.push(arg);
  }
}

if (options.files.length === 0) die('No files provided');

// --- 读取所有章节（按传入顺序）---
const chapters = [];
let failed = false;

for (const file of options.files) {
  const fullPath = path.resolve(file);
  let input;
  try { input = fs.readFileSync(fullPath, 'utf8'); }
  catch (error) { failed = true; if (!options.json) console.error(`${file}: unable to read (${error.message})`); continue; }
  chapters.push({ file, content: input, chars: countVisibleChars(input) });
}

if (chapters.length === 0) {
  if (!options.json) console.error('No readable files.');
  process.exit(2);
}

// --- 运行6类检测 ---
const allFindings = [];
allFindings.push(...detectRewardGap(chapters));
allFindings.push(...detectRhythmCollapse(chapters));
allFindings.push(...detectEmotionFlat(chapters));
allFindings.push(...detectRatioImbalance(chapters));
allFindings.push(...detectMissingHook(chapters));
allFindings.push(...detectSentenceVariance(chapters));

// 按章节顺序排序
allFindings.sort((a, b) => {
  const ai = chapters.findIndex((c) => c.file === a.file);
  const bi = chapters.findIndex((c) => c.file === b.file);
  if (ai !== bi) return ai - bi;
  return a.line - b.line || a.column - b.column;
});

// --- 输出 ---
if (options.json) {
  process.stdout.write(`${JSON.stringify({ findings: allFindings }, null, 2)}\n`);
} else {
  // 情绪关键词检测辅助说明
  const hasEmotionFinding = allFindings.some(f => f.type === 'emotion-flat');
  if (hasEmotionFinding) {
    console.log('注：情绪关键词检测为辅助参考，不作为blocking依据。一章可用具体描写表达情绪但通篇不出现关键词。\n');
  }
  for (const f of allFindings) {
    console.log(`${f.file}:${f.line}:${f.column}: [${f.severity}] ${f.type}: ${f.message} (${f.excerpt})`);
  }
}

if (failed) process.exit(2);
// advisory 级别的发现不触发退出码 1，只有 blocking 才阻断
const hasBlocking = allFindings.some(f => f.severity === 'blocking');
if (hasBlocking) process.exit(1);

// ========== 工具函数 ==========

function die(message) { console.error(message); console.error(USAGE.trimEnd()); process.exit(2); }

/** 统计可见字符数（中日韩文字+字母数字）*/
function countVisibleChars(text) {
  const m = text.match(/[一-鿿Ａ-ｚA-Za-z0-9]/g);
  return m ? m.length : 0;
}

// visibleLength, stripQuoted, splitSentences, isDivider, isStructural, parseFenceMarker
// — 已提取至 ./lib/prose-utils.js

/** 检查文本是否包含任一关键词 */
function containsAny(text, keywords) {
  for (const kw of keywords) {
    if (text.indexOf(kw) !== -1) return true;
  }
  return false;
}

/** 统计关键词在文本中出现总次数 */
function countKeywords(text, keywords) {
  let total = 0;
  for (const kw of keywords) {
    let idx = text.indexOf(kw);
    while (idx !== -1) {
      total += 1;
      idx = text.indexOf(kw, idx + kw.length);
    }
  }
  return total;
}

/** 压缩文本用于摘要展示 */
function compact(t) {
  const n = String(t).replace(/\s+/g, ' ').trim();
  return n.length > 80 ? `${n.slice(0, 77)}...` : n;
}

/** 计算标准差 */
function stdDev(values) {
  if (values.length === 0) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

// hasYamlFrontMatter — 已提取至 ./lib/prose-utils.js

/** 提取章节正文行（跳过代码块、分隔线、结构性文本、YAML前言）*/
function extractProseLines(input) {
  const lines = input.split(/\r?\n/);
  const proseLines = [];
  let fence = null;
  let inFrontMatter = hasYamlFrontMatter(lines);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const trimmed = line.trim();
    if (inFrontMatter) { if (i > 0 && trimmed === '---') inFrontMatter = false; continue; }
    const fenceMarker = parseFenceMarker(trimmed);
    if (fence) { if (fenceMarker && fenceMarker.char === fence.char && fenceMarker.length >= fence.length) fence = null; continue; }
    if (fenceMarker) { fence = fenceMarker; continue; }
    if (!trimmed || isDivider(trimmed) || isStructural(trimmed)) continue;
    proseLines.push(line);
  }
  return proseLines;
}

// ========== 检测函数 ==========

/**
 * 检测类型1：爽点间隔过大
 * 连续3章+无爽点关键词 = 爽点真空；连续5章+ = 高危
 * 爆款书平均每3章内一次明确爽点，超过5章间隔=高危
 */
function detectRewardGap(chapters) {
  const findings = [];
  let gapStart = -1;
  let gapLen = 0;

  const flush = () => {
    if (gapLen >= REWARD_GAP_WARN) {
      const isCritical = gapLen >= REWARD_GAP_CRITICAL;
      findings.push({
        file: chapters[gapStart].file,
        line: 1, column: 1,
        type: 'reward-gap',
        severity: 'advisory',
        message: isCritical
          ? `爽点真空（高危）：连续 ${gapLen} 章无爽点关键词。爆款书平均每3章内一次明确爽点，超过5章间隔=高危。建议在真空区间插入打脸/翻盘/碾压/突破/震惊等爽点。`
          : `爽点真空：连续 ${gapLen} 章无爽点关键词（第${gapStart + 1}-${gapStart + gapLen}章）。建议在区间内插入明确爽点。`,
        excerpt: `第${gapStart + 1}-${gapStart + gapLen}章无爽点`,
      });
    }
    gapStart = -1;
    gapLen = 0;
  };

  for (let i = 0; i < chapters.length; i += 1) {
    if (containsAny(chapters[i].content, REWARD_KEYWORDS)) {
      flush();
    } else {
      if (gapStart === -1) gapStart = i;
      gapLen += 1;
    }
  }
  flush();

  return findings;
}

/**
 * 检测类型2a：节奏塌陷（字数下降）
 * 连续3章平均字数比前3章平均字数少30%以上
 */
function detectRhythmCollapse(chapters) {
  const findings = [];
  if (chapters.length < 6) return findings; // 至少6章才能比较两个3章窗口

  let i = 3;
  while (i + 2 < chapters.length) {
    const prevAvg = (chapters[i - 3].chars + chapters[i - 2].chars + chapters[i - 1].chars) / 3;
    const currAvg = (chapters[i].chars + chapters[i + 1].chars + chapters[i + 2].chars) / 3;
    if (prevAvg > 0 && currAvg < prevAvg * RHYTHM_DROP_RATIO) {
      const dropPct = Math.round((1 - currAvg / prevAvg) * 100);
      findings.push({
        file: chapters[i].file,
        line: 1, column: 1,
        type: 'rhythm-collapse',
        severity: 'advisory',
        message: `节奏塌陷：第${i + 1}-${i + 3}章平均 ${Math.round(currAvg)} 字，比前3章平均 ${Math.round(prevAvg)} 字少 ${dropPct}%（阈值30%）。检查是否大量过渡章/水字数，建议提升信息密度。`,
        excerpt: `前3章均${Math.round(prevAvg)}字 → 当前3章均${Math.round(currAvg)}字`,
      });
      i += 3; // 跳过已检测窗口，避免重叠报告
    } else {
      i += 1;
    }
  }

  return findings;
}

/**
 * 检测类型2b：情绪平坦
 * 连续3章无情绪波动关键词（爽/怒/惊/悲/惧/暖）
 */
function detectEmotionFlat(chapters) {
  const findings = [];
  let flatStart = -1;
  let flatLen = 0;

  const flush = () => {
    if (flatLen >= EMOTION_FLAT_RUN) {
      findings.push({
        file: chapters[flatStart].file,
        line: 1, column: 1,
        type: 'emotion-flat',
        severity: 'advisory',
        message: `情绪平坦：连续 ${flatLen} 章无情绪波动关键词（爽/怒/惊/悲/惧/暖）。读者情绪无起伏易弃书，建议在区间内加入情绪转折或冲突。注意：情绪关键词检测为辅助参考，不作为blocking依据。一章可用具体描写表达情绪但通篇不出现关键词。`,
        excerpt: `第${flatStart + 1}-${flatStart + flatLen}章无情绪波动`,
      });
    }
    flatStart = -1;
    flatLen = 0;
  };

  for (let i = 0; i < chapters.length; i += 1) {
    if (containsAny(chapters[i].content, EMOTION_KEYWORDS)) {
      flush();
    } else {
      if (flatStart === -1) flatStart = i;
      flatLen += 1;
    }
  }
  flush();

  return findings;
}

/**
 * 检测类型3：篇幅配比（7-2-1原则）
 * 70%主线 / 20%人设 / 10%伏笔
 * 通过关键词密度估算，伏笔占比>20%或<5% = 配比失衡（按章检测）
 */
function detectRatioImbalance(chapters) {
  const findings = [];

  for (let i = 0; i < chapters.length; i += 1) {
    const text = chapters[i].content;
    const plotCount = countKeywords(text, PLOT_KEYWORDS);
    const charCount = countKeywords(text, CHARACTER_KEYWORDS);
    const foreshadowCount = countKeywords(text, FORESHADOW_KEYWORDS);
    const total = plotCount + charCount + foreshadowCount;

    if (total < RATIO_MIN_KEYWORDS) continue; // 关键词太少，不具备统计意义

    const foreshadowRatio = foreshadowCount / total;
    if (foreshadowRatio > RATIO_FORESHADOW_MAX) {
      findings.push({
        file: chapters[i].file,
        line: 1, column: 1,
        type: 'ratio-imbalance',
        severity: 'advisory',
        message: `篇幅配比失衡：伏笔占比 ${(foreshadowRatio * 100).toFixed(0)}%（>${RATIO_FORESHADOW_MAX * 100}%）。7-2-1原则建议主线70%/人设20%/伏笔10%。伏笔过多会拖慢节奏，建议精简伏笔或融入主线推进。当前：主线${plotCount}/人设${charCount}/伏笔${foreshadowCount}。`,
        excerpt: `主线${plotCount} 人设${charCount} 伏笔${foreshadowCount}`,
      });
    } else if (foreshadowRatio < RATIO_FORESHADOW_MIN) {
      findings.push({
        file: chapters[i].file,
        line: 1, column: 1,
        type: 'ratio-imbalance',
        severity: 'advisory',
        message: `篇幅配比失衡：伏笔占比 ${(foreshadowRatio * 100).toFixed(0)}%（<${RATIO_FORESHADOW_MIN * 100}%）。7-2-1原则建议主线70%/人设20%/伏笔10%。伏笔过少会导致后续情节缺乏铺垫，建议增加暗示/线索/异常等伏笔。当前：主线${plotCount}/人设${charCount}/伏笔${foreshadowCount}。`,
        excerpt: `主线${plotCount} 人设${charCount} 伏笔${foreshadowCount}`,
      });
    }
  }

  return findings;
}

/**
 * 检测类型4：章末钩子缺失
 * 检测每章最后500字是否有钩子关键词
 * 无钩子关键词 = 章末无钩子
 */
function detectMissingHook(chapters) {
  const findings = [];

  for (let i = 0; i < chapters.length; i += 1) {
    const content = chapters[i].content;
    const tail = content.slice(-HOOK_TAIL_CHARS);
    if (!containsAny(tail, HOOK_KEYWORDS)) {
      const tailExcerpt = compact(tail.replace(/\s+/g, ' ').trim().slice(-60));
      findings.push({
        file: chapters[i].file,
        line: 1, column: 1,
        type: 'missing-hook',
        severity: 'advisory',
        message: `章末无钩子：最后${HOOK_TAIL_CHARS}字未检测到钩子关键词（？/悬念/未知/突然/只见/然而/就在这时/不料/谁知/下一步/到底/究竟）。章末应有悬念或转折钩住读者。`,
        excerpt: tailExcerpt || '(章末为空)',
      });
    }
  }

  return findings;
}

/**
 * 检测类型5：句长方差检测（单章级别）
 * 计算每章句子长度的标准差
 * 标准差<8 = 突发度不足（句子长度过于均匀，像AI）
 * 标准差>25 = 不标记（长短句变化剧烈，人类特征）
 */
function detectSentenceVariance(chapters) {
  const findings = [];

  for (let i = 0; i < chapters.length; i += 1) {
    const proseLines = extractProseLines(chapters[i].content);
    // 去除对话内容后再计算句长方差，避免对话短句干扰统计
    const fullText = proseLines.map((l) => stripQuoted(l)).join('\n');
    const sentences = splitSentences(fullText);

    if (sentences.length < SENTENCE_MIN_COUNT) continue;

    const lengths = sentences.map((s) => visibleLength(s)).filter((l) => l > 0);
    if (lengths.length < SENTENCE_MIN_COUNT) continue;

    const sd = stdDev(lengths);

    if (sd < SENTENCE_STD_LOW) {
      const avgLen = (lengths.reduce((a, b) => a + b, 0) / lengths.length).toFixed(1);
      findings.push({
        file: chapters[i].file,
        line: 1, column: 1,
        type: 'sentence-variance',
        severity: 'advisory',
        message: `突发度不足：句长标准差 ${sd.toFixed(1)}（<${SENTENCE_STD_LOW}），句子长度过于均匀，像AI。人类写作长短句交错，标准差通常>15。建议混入短句（1-5字）和长句（30+字）增加节奏变化。平均句长${avgLen}字。`,
        excerpt: `σ=${sd.toFixed(1)} 平均${avgLen}字 共${lengths.length}句`,
      });
    }
    // 标准差>25 不标记（人类特征）
  }

  return findings;
}

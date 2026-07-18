#!/usr/bin/env node
'use strict';

/**
 * check-style-consistency.js — 文风一致性跨章检测
 *
 * 检测相邻章节之间的文风漂移（只报告不修改）：
 *   - 提取每章文风指纹：句长分布（均值/标准差/CV）、用词频率Top20、
 *     段落结构比例（对话/叙述/描写占比）、对话风格特征（对话平均长度/对话密度）
 *   - 计算相邻章节文风距离（各维度差异的加权平均）
 *   - 文风距离超阈值（默认0.3）时标记"文风漂移"警告
 *
 * 设计依据：
 *   - 04_精修师 / references/Part_L_文风系统.md 的文风指纹概念
 *   - 同一作者、同一作品的相邻章节文风指纹应保持稳定；漂移过大意味着
 *     AI 介入痕迹（不同 prompt/不同模型生成）或人机交接不一致
 *   - 对标 Part_L 的"句长分布 + 用词频率 + 段落结构 + 对话风格"四维指纹
 *
 * 用法：
 *   node check-style-consistency.js --current <当前章正文路径> [--previous <前一章正文路径>] [--threshold 0.3] [--json]
 *
 * 参数：
 *   --current     当前章节正文路径（必填）
 *   --previous    前一章正文路径（可选；缺失时只输出当前章指纹，不做漂移对比）
 *   --threshold   文风距离告警阈值（默认 0.3，范围 0-1，越大越宽松）
 *   --json        输出 JSON 格式报告（默认输出人类可读文本）
 *   -h, --help    显示帮助
 *
 * 只报告不修改，永远不重写正文。
 * 不依赖外部 npm 包，仅使用 Node.js 内置模块 + ./lib/prose-utils.js。
 */

const fs = require('fs');
const path = require('path');
// 引入共享函数库（路径相对于 scripts/ 目录，解析为 scripts/lib/prose-utils.js）
const {
  stripQuoted,
  visibleLength,
  isDivider,
  isStructural,
  hasYamlFrontMatter,
  splitSentences,
  parseFenceMarker,
} = require('./lib/prose-utils.js');

// ──────────────────────────────────────────────────────────
//  常量与阈值
// ──────────────────────────────────────────────────────────

const USAGE = `Usage: node check-style-consistency.js --current <file> [--previous <file>] [--threshold 0.3] [--json]

Detect cross-chapter style drift (report-only, never rewrites):
  --current     Current chapter file path (required)
  --previous    Previous chapter file path (optional; omit for fingerprint-only mode)
  --threshold   Style distance alarm threshold (default: 0.3, range 0-1)
  --json        Output JSON report
  -h, --help    Show this help

Style fingerprint dimensions:
  1. Sentence length distribution (mean / stdDev / CV)
  2. Word frequency Top20
  3. Paragraph structure ratio (dialogue / narrative / description)
  4. Dialogue style features (avg dialogue length / dialogue density)

Report-only. Never rewrites text.`;

// 文风距离告警阈值（各维度差异的加权平均）
const DEFAULT_THRESHOLD = 0.3;

// Top-N 高频词数量
const TOP_N_WORDS = 20;

// 各维度权重（加权平均，总和 = 1.0）
const WEIGHTS = {
  sentenceLength: 0.30,   // 句长分布
  vocabulary: 0.25,        // 用词频率
  paragraphStructure: 0.25, // 段落结构比例
  dialogueStyle: 0.20,      // 对话风格特征
};

// 描写性关键词（用于区分叙述段与描写段）
const DESCRIPTION_KEYWORDS = [
  '光', '影', '声', '味', '气', '色', '温', '冷', '热', '风', '雨', '雪',
  '雾', '云', '树', '花', '草', '石', '水', '火', '铁', '金', '木', '丝',
  '光滑', '粗糙', '柔软', '坚硬', '刺鼻', '清香', '轰鸣', '低沉', '刺眼',
  '昏暗', '明亮', '潮湿', '干燥', '寂静', '嘈杂', '颤抖', '摇晃',
];

// ──────────────────────────────────────────────────────────
//  命令行参数解析
// ──────────────────────────────────────────────────────────

const options = {
  current: '',
  previous: '',
  threshold: DEFAULT_THRESHOLD,
  json: false,
};

for (let i = 2; i < process.argv.length; i += 1) {
  const arg = process.argv[i];
  if (arg === '--current') {
    options.current = process.argv[++i] || '';
  } else if (arg === '--previous') {
    options.previous = process.argv[++i] || '';
  } else if (arg === '--threshold') {
    options.threshold = parseFloat(process.argv[++i]);
    if (Number.isNaN(options.threshold)) options.threshold = DEFAULT_THRESHOLD;
  } else if (arg === '--json') {
    options.json = true;
  } else if (arg === '-h' || arg === '--help') {
    process.stdout.write(`${USAGE}\n`);
    process.exit(0);
  }
}

if (!options.current) {
  console.error('错误：缺少 --current 参数');
  console.error(USAGE);
  process.exit(2);
}

if (!fs.existsSync(options.current)) {
  console.error(`错误：当前章文件不存在: ${options.current}`);
  process.exit(2);
}

if (options.previous && !fs.existsSync(options.previous)) {
  console.error(`错误：前一章文件不存在: ${options.previous}`);
  process.exit(2);
}

// ──────────────────────────────────────────────────────────
//  正文行提取（跳过代码块/分隔线/结构性标记/YAML前言）
// ──────────────────────────────────────────────────────────

/**
 * 提取章节正文行（跳过 markdown 结构性内容）
 * 与 check-rhythm.js 的 extractProseLines 逻辑一致
 * @param {string} input - 原始文件内容
 * @returns {string[]} - 正文行数组
 */
function extractProseLines(input) {
  const lines = input.split(/\r?\n/);
  const proseLines = [];
  let fence = null;
  let inFrontMatter = hasYamlFrontMatter(lines);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const trimmed = line.trim();
    // 跳过 YAML front matter
    if (inFrontMatter) {
      if (i > 0 && trimmed === '---') inFrontMatter = false;
      continue;
    }
    const fenceMarker = parseFenceMarker(trimmed);
    // 跳过代码块内容
    if (fence) {
      if (fenceMarker && fenceMarker.char === fence.char && fenceMarker.length >= fence.length) {
        fence = null;
      }
      continue;
    }
    if (fenceMarker) {
      fence = fenceMarker;
      continue;
    }
    // 跳过分隔线和结构性标记
    if (!trimmed || isDivider(trimmed) || isStructural(trimmed)) continue;
    proseLines.push(line);
  }
  return proseLines;
}

// ──────────────────────────────────────────────────────────
//  维度1：句长分布指纹
// ──────────────────────────────────────────────────────────

/**
 * 提取句长分布指纹
 * 包含均值、标准差、变异系数（CV）
 * @param {string[]} proseLines - 正文行数组
 * @returns {{mean: number, stdDev: number, cv: number, sentenceCount: number}}
 */
function extractSentenceLengthFingerprint(proseLines) {
  // 去除对话内容后计算句长，避免对话短句干扰
  const fullText = proseLines.map((l) => stripQuoted(l)).join('\n');
  const sentences = splitSentences(fullText);
  const lengths = sentences.map((s) => visibleLength(s)).filter((l) => l > 0);

  if (lengths.length === 0) {
    return { mean: 0, stdDev: 0, cv: 0, sentenceCount: 0 };
  }

  const mean = lengths.reduce((a, b) => a + b, 0) / lengths.length;
  const variance = lengths.reduce((s, l) => s + (l - mean) * (l - mean), 0) / lengths.length;
  const stdDev = Math.sqrt(variance);
  const cv = mean > 0 ? stdDev / mean : 0;

  return {
    mean: round(mean, 2),
    stdDev: round(stdDev, 2),
    cv: round(cv, 4),
    sentenceCount: lengths.length,
  };
}

// ──────────────────────────────────────────────────────────
//  维度2：用词频率 Top-N 指纹
// ──────────────────────────────────────────────────────────

/**
 * 提取用词频率 Top-N 指纹
 * 中文按字统计（无空格分词），使用双字滑窗提取高频词组
 * @param {string[]} proseLines - 正文行数组
 * @returns {{topWords: Array<{word: string, freq: number}>, totalTokens: number}}
 */
function extractVocabularyFingerprint(proseLines) {
  const fullText = proseLines.join('\n');
  // 提取所有中文字符
  const chars = fullText.match(/[\u4e00-\u9fff]/g) || [];

  // 双字滑窗统计（捕捉高频词组/短语）
  const bigramFreq = new Map();
  for (let i = 0; i < chars.length - 1; i += 1) {
    const bigram = chars[i] + chars[i + 1];
    bigramFreq.set(bigram, (bigramFreq.get(bigram) || 0) + 1);
  }

  // 排序取 Top-N
  const sorted = [...bigramFreq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, TOP_N_WORDS)
    .map(([word, freq]) => ({ word, freq }));

  return {
    topWords: sorted,
    totalTokens: bigramFreq.size,
  };
}

// ──────────────────────────────────────────────────────────
//  维度3：段落结构比例指纹（对话/叙述/描写占比）
// ──────────────────────────────────────────────────────────

/**
 * 提取段落结构比例指纹
 * 按行分类：对话行（含引号）/ 描写行（含感官关键词）/ 叙述行（其余）
 * @param {string[]} proseLines - 正文行数组
 * @returns {{dialogueRatio: number, narrativeRatio: number, descriptionRatio: number, totalLines: number}}
 */
function extractParagraphStructureFingerprint(proseLines) {
  let dialogueLines = 0;
  let descriptionLines = 0;
  let narrativeLines = 0;

  for (const line of proseLines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // 对话行：含中文引号/日文引号/英文直引号的行（与 prose-utils.js stripQuoted 范围一致）
    const hasDialogue = /[\u201c\u201d\u2018\u2019「」『』"]/.test(trimmed);
    // 描写行：含感官/环境关键词的行（且不含对话）
    const hasDescription = !hasDialogue && DESCRIPTION_KEYWORDS.some((kw) => trimmed.includes(kw));

    if (hasDialogue) {
      dialogueLines += 1;
    } else if (hasDescription) {
      descriptionLines += 1;
    } else {
      narrativeLines += 1;
    }
  }

  const total = dialogueLines + descriptionLines + narrativeLines;
  if (total === 0) {
    return { dialogueRatio: 0, narrativeRatio: 0, descriptionRatio: 0, totalLines: 0 };
  }

  return {
    dialogueRatio: round(dialogueLines / total, 4),
    narrativeRatio: round(narrativeLines / total, 4),
    descriptionRatio: round(descriptionLines / total, 4),
    totalLines: total,
  };
}

// ──────────────────────────────────────────────────────────
//  维度4：对话风格特征指纹（对话平均长度/对话密度）
// ──────────────────────────────────────────────────────────

/**
 * 提取对话风格特征指纹
 * - 对话平均长度：每个引号内内容的可见字符数均值
 * - 对话密度：对话总字数 / 正文总字数
 * @param {string[]} proseLines - 正文行数组
 * @returns {{avgDialogueLength: number, dialogueDensity: number, dialogueCount: number}}
 */
function extractDialogueStyleFingerprint(proseLines) {
  const fullText = proseLines.join('\n');
  // 提取所有引号内的对话内容（中文弯引号 + 日文引号 + 英文直引号，与 stripQuoted 范围一致）
  const cnDialogueMatches = fullText.match(/\u201c[^\u201d]*\u201d/g) || [];
  const jpDialogueMatches = fullText.match(/「[^」]*」/g) || [];
  const jpInnerMatches = fullText.match(/『[^』]*』/g) || [];
  const enDialogueMatches = fullText.match(/"[^"]*"/g) || [];
  const allDialogues = [...cnDialogueMatches, ...jpDialogueMatches, ...jpInnerMatches, ...enDialogueMatches];

  // 对话总可见字符数
  let dialogueTotalChars = 0;
  for (const d of allDialogues) {
    dialogueTotalChars += visibleLength(d);
  }

  // 正文总可见字符数
  const totalChars = visibleLength(fullText);

  const avgDialogueLength = allDialogues.length > 0
    ? dialogueTotalChars / allDialogues.length
    : 0;
  const dialogueDensity = totalChars > 0
    ? dialogueTotalChars / totalChars
    : 0;

  return {
    avgDialogueLength: round(avgDialogueLength, 2),
    dialogueDensity: round(dialogueDensity, 4),
    dialogueCount: allDialogues.length,
  };
}

// ──────────────────────────────────────────────────────────
//  文风指纹组装
// ──────────────────────────────────────────────────────────

/**
 * 提取完整文风指纹（四维）
 * @param {string} filePath - 文件路径
 * @returns {{file: string, sentenceLength: object, vocabulary: object, paragraphStructure: object, dialogueStyle: object}}
 */
function extractStyleFingerprint(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  const proseLines = extractProseLines(content);

  return {
    file: path.basename(filePath),
    sentenceLength: extractSentenceLengthFingerprint(proseLines),
    vocabulary: extractVocabularyFingerprint(proseLines),
    paragraphStructure: extractParagraphStructureFingerprint(proseLines),
    dialogueStyle: extractDialogueStyleFingerprint(proseLines),
  };
}

// ──────────────────────────────────────────────────────────
//  文风距离计算（各维度差异的加权平均）
// ──────────────────────────────────────────────────────────

/**
 * 计算句长分布维度距离
 * 基于均值差异和CV差异的归一化组合
 * @param {object} a - 章节 A 的句长指纹
 * @param {object} b - 章节 B 的句长指纹
 * @returns {number} 0-1 归一化距离
 */
function sentenceLengthDistance(a, b) {
  // 均值差异（归一化到 0-1，假设句长均值在 5-50 范围）
  const meanDiff = Math.abs(a.mean - b.mean) / Math.max(a.mean, b.mean, 1);
  // CV 差异（归一化）
  const cvDiff = Math.abs(a.cv - b.cv) / Math.max(a.cv, b.cv, 0.01);
  // 组合（均值权重 0.6，CV 权重 0.4）
  const dist = 0.6 * clamp01(meanDiff) + 0.4 * clamp01(cvDiff);
  return clamp01(dist);
}

/**
 * 计算用词频率维度距离
 * 基于两组 Top-N 词的 Jaccard 距离（交集/并集的补集）
 * @param {object} a - 章节 A 的词汇指纹
 * @param {object} b - 章节 B 的词汇指纹
 * @returns {number} 0-1 归一化距离
 */
function vocabularyDistance(a, b) {
  const setA = new Set(a.topWords.map((w) => w.word));
  const setB = new Set(b.topWords.map((w) => w.word));
  if (setA.size === 0 && setB.size === 0) return 0;

  let intersection = 0;
  for (const w of setA) {
    if (setB.has(w)) intersection += 1;
  }
  const union = setA.size + setB.size - intersection;
  // Jaccard 距离 = 1 - Jaccard 相似度
  return union > 0 ? 1 - intersection / union : 0;
}

/**
 * 计算段落结构维度距离
 * 基于三维占比向量的欧氏距离（归一化）
 * @param {object} a - 章节 A 的段落结构指纹
 * @param {object} b - 章节 B 的段落结构指纹
 * @returns {number} 0-1 归一化距离
 */
function paragraphStructureDistance(a, b) {
  const dDialogue = a.dialogueRatio - b.dialogueRatio;
  const dNarrative = a.narrativeRatio - b.narrativeRatio;
  const dDescription = a.descriptionRatio - b.descriptionRatio;
  // 三维欧氏距离，最大值为 sqrt(2)（两章完全不重叠），归一化到 0-1
  const euclidean = Math.sqrt(dDialogue ** 2 + dNarrative ** 2 + dDescription ** 2);
  return clamp01(euclidean / Math.SQRT2);
}

/**
 * 计算对话风格维度距离
 * 基于对话平均长度差异和对话密度差异的归一化组合
 * @param {object} a - 章节 A 的对话风格指纹
 * @param {object} b - 章节 B 的对话风格指纹
 * @returns {number} 0-1 归一化距离
 */
function dialogueStyleDistance(a, b) {
  // 对话平均长度差异（归一化）
  const avgLenDiff = Math.abs(a.avgDialogueLength - b.avgDialogueLength)
    / Math.max(a.avgDialogueLength, b.avgDialogueLength, 1);
  // 对话密度差异（归一化）
  const densityDiff = Math.abs(a.dialogueDensity - b.dialogueDensity)
    / Math.max(a.dialogueDensity, b.dialogueDensity, 0.01);
  // 组合（平均长度权重 0.5，密度权重 0.5）
  const dist = 0.5 * clamp01(avgLenDiff) + 0.5 * clamp01(densityDiff);
  return clamp01(dist);
}

/**
 * 计算文风总距离（各维度差异的加权平均）
 * @param {object} fingerprintA - 章节 A 的完整指纹
 * @param {object} fingerprintB - 章节 B 的完整指纹
 * @returns {{total: number, dimensions: object}}
 */
function calculateStyleDistance(fingerprintA, fingerprintB) {
  const dimensions = {
    sentenceLength: sentenceLengthDistance(
      fingerprintA.sentenceLength,
      fingerprintB.sentenceLength,
    ),
    vocabulary: vocabularyDistance(
      fingerprintA.vocabulary,
      fingerprintB.vocabulary,
    ),
    paragraphStructure: paragraphStructureDistance(
      fingerprintA.paragraphStructure,
      fingerprintB.paragraphStructure,
    ),
    dialogueStyle: dialogueStyleDistance(
      fingerprintA.dialogueStyle,
      fingerprintB.dialogueStyle,
    ),
  };

  const total = round(
    WEIGHTS.sentenceLength * dimensions.sentenceLength +
    WEIGHTS.vocabulary * dimensions.vocabulary +
    WEIGHTS.paragraphStructure * dimensions.paragraphStructure +
    WEIGHTS.dialogueStyle * dimensions.dialogueStyle,
    4,
  );

  return { total, dimensions };
}

// ──────────────────────────────────────────────────────────
//  工具函数
// ──────────────────────────────────────────────────────────

/**
 * 数值四舍五入到指定小数位
 * @param {number} n - 输入数值
 * @param {number} digits - 小数位数
 * @returns {number}
 */
function round(n, digits) {
  const factor = 10 ** digits;
  return Math.round(n * factor) / factor;
}

/**
 * 将数值限制在 [0, 1] 范围
 * @param {number} n
 * @returns {number}
 */
function clamp01(n) {
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

// ──────────────────────────────────────────────────────────
//  主流程
// ──────────────────────────────────────────────────────────

function main() {
  // 提取当前章指纹
  const currentFingerprint = extractStyleFingerprint(options.current);

  // 无前一章：只输出指纹
  if (!options.previous) {
    const output = {
      status: 'fingerprint_only',
      current_file: options.current,
      fingerprint: currentFingerprint,
      note: '未提供 --previous 参数，仅输出当前章文风指纹，未做漂移对比。',
    };
    if (options.json) {
      process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
    } else {
      printFingerprint(currentFingerprint, '当前章');
      console.log('\n（未提供 --previous 参数，仅输出指纹，未做漂移对比）');
    }
    return;
  }

  // 提取前一章指纹
  const previousFingerprint = extractStyleFingerprint(options.previous);

  // 计算文风距离
  const distance = calculateStyleDistance(previousFingerprint, currentFingerprint);
  const isDrift = distance.total > options.threshold;

  const report = {
    status: isDrift ? 'style_drift_detected' : 'consistent',
    previous_file: options.previous,
    current_file: options.current,
    threshold: options.threshold,
    style_distance: distance.total,
    drift: isDrift,
    dimensions: {
      sentenceLength: {
        distance: round(distance.dimensions.sentenceLength, 4),
        weight: WEIGHTS.sentenceLength,
        previous: previousFingerprint.sentenceLength,
        current: currentFingerprint.sentenceLength,
      },
      vocabulary: {
        distance: round(distance.dimensions.vocabulary, 4),
        weight: WEIGHTS.vocabulary,
        previous: previousFingerprint.vocabulary,
        current: currentFingerprint.vocabulary,
      },
      paragraphStructure: {
        distance: round(distance.dimensions.paragraphStructure, 4),
        weight: WEIGHTS.paragraphStructure,
        previous: previousFingerprint.paragraphStructure,
        current: currentFingerprint.paragraphStructure,
      },
      dialogueStyle: {
        distance: round(distance.dimensions.dialogueStyle, 4),
        weight: WEIGHTS.dialogueStyle,
        previous: previousFingerprint.dialogueStyle,
        current: currentFingerprint.dialogueStyle,
      },
    },
  };

  // 输出
  if (options.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    printReport(report);
  }

  // 漂移时退出码 1（advisory，非 blocking）
  if (isDrift) {
    process.exit(1);
  }
}

/**
 * 打印单个章节的文风指纹（人类可读）
 * @param {object} fp - 文风指纹
 * @param {string} label - 章节标签
 */
function printFingerprint(fp, label) {
  console.log(`═══════════════════════════════════════`);
  console.log(`  ${label}文风指纹: ${fp.file}`);
  console.log(`═══════════════════════════════════════`);
  console.log(`【句长分布】均值=${fp.sentenceLength.mean} | 标准差=${fp.sentenceLength.stdDev} | CV=${fp.sentenceLength.cv} | 句数=${fp.sentenceLength.sentenceCount}`);
  console.log(`【用词频率Top${TOP_N_WORDS}】${fp.vocabulary.topWords.slice(0, 10).map((w) => `${w.word}(${w.freq})`).join(' ')}${fp.vocabulary.topWords.length > 10 ? ' ...' : ''}`);
  console.log(`【段落结构】对话=${(fp.paragraphStructure.dialogueRatio * 100).toFixed(0)}% | 叙述=${(fp.paragraphStructure.narrativeRatio * 100).toFixed(0)}% | 描写=${(fp.paragraphStructure.descriptionRatio * 100).toFixed(0)}% | 总行=${fp.paragraphStructure.totalLines}`);
  console.log(`【对话风格】平均长度=${fp.dialogueStyle.avgDialogueLength}字 | 密度=${(fp.dialogueStyle.dialogueDensity * 100).toFixed(1)}% | 对话数=${fp.dialogueStyle.dialogueCount}`);
  console.log('');
}

/**
 * 打印完整对比报告（人类可读）
 * @param {object} report - 报告对象
 */
function printReport(report) {
  console.log('═══════════════════════════════════════════════════════');
  console.log('  文风一致性跨章检测报告');
  console.log('═══════════════════════════════════════════════════════');
  console.log(`前一章: ${report.previous_file}`);
  console.log(`当前章: ${report.current_file}`);
  console.log(`阈值:   ${report.threshold}`);
  console.log('');

  printFingerprint(report.dimensions.sentenceLength.previous
    ? {
        file: report.previous_file,
        sentenceLength: report.dimensions.sentenceLength.previous,
        vocabulary: report.dimensions.vocabulary.previous,
        paragraphStructure: report.dimensions.paragraphStructure.previous,
        dialogueStyle: report.dimensions.dialogueStyle.previous,
      }
    : { file: report.previous_file },
    '前一章');
  printFingerprint({
    file: report.current_file,
    sentenceLength: report.dimensions.sentenceLength.current,
    vocabulary: report.dimensions.vocabulary.current,
    paragraphStructure: report.dimensions.paragraphStructure.current,
    dialogueStyle: report.dimensions.dialogueStyle.current,
  }, '当前章');

  console.log('── 文风距离（各维度差异加权平均）──');
  console.log(`  句长分布:     ${report.dimensions.sentenceLength.distance.toFixed(4)}  (权重 ${report.dimensions.sentenceLength.weight})`);
  console.log(`  用词频率:     ${report.dimensions.vocabulary.distance.toFixed(4)}  (权重 ${report.dimensions.vocabulary.weight})`);
  console.log(`  段落结构:     ${report.dimensions.paragraphStructure.distance.toFixed(4)}  (权重 ${report.dimensions.paragraphStructure.weight})`);
  console.log(`  对话风格:     ${report.dimensions.dialogueStyle.distance.toFixed(4)}  (权重 ${report.dimensions.dialogueStyle.weight})`);
  console.log(`  ─────────────────────`);
  console.log(`  文风总距离:   ${report.style_distance.toFixed(4)}  (阈值 ${report.threshold})`);
  console.log('');

  if (report.drift) {
    console.log('  ⚠️  文风漂移警告：文风总距离超过阈值，相邻章节文风不一致。');
    console.log('     可能原因：AI 介入痕迹（不同 prompt/模型生成）、人机交接不一致、');
    console.log('     或作者主动切换文风（如场景/情绪转变导致的有意变化）。');
    console.log('     建议：检查漂移最大的维度，确认是否有意为之。');
  } else {
    console.log('  ✓ 文风一致：文风总距离在阈值范围内，相邻章节文风稳定。');
  }
  console.log('═══════════════════════════════════════════════════════');
}

main();

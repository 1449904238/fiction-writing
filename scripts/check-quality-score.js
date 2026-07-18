#!/usr/bin/env node
'use strict';

/**
 * check-quality-score.js — 混合质量评分脚本（V3.0 新增, V5.3.1 修订）
 *
 * V5.3.1: 移除0.8校准因子(原引用arXiv:2511.21140但数学不对应)，改为客观分主导+主观分不压缩。
 *   旧方案：客观分(60) + 主观分(40×0.8=32) = 92分制。0.8系数声称对冲LLM自评宽容偏差，
 *           但 arXiv:2511.21140 的偏差量与0.8无数学对应关系，属经验拼凑。
 *   新方案：客观分(60) + 主观分(40) = 100分制。客观分占60%主导，主观分不压缩，阈值不变。
 *
 * 评分模型：
 *   最终评分 = 客观分（max 60） + LLM主观分（max 40）= 总分（max 100）
 *   total_max = objective_score + 40（当前客观分下可达的最高总分）
 *
 * 流程推荐逻辑：
 *   objective_score + 40（LLM满分）≥ 80 → "fast"（快速通道）
 *   objective_score + 30（中等LLM分）≥ 60 → "full"（完整流程）
 *   否则 → "rewrite"（重写）
 *
 * 5个客观维度（满分60分）：
 *   1. 情节推进力（15分）：信息密度检测，每500字分段计算（对话+动作占比）
 *   2. 节奏控制（15分）：burstiness CV + 句长方差
 *   3. 质感密度（10分）：感官词频统计（眼/耳/鼻/舌/身）+ 比喻密度
 *   4. 角色一致性（10分）：名称/数值矛盾检测（简化内联）
 *   5. AI味基线（10分）：blocking级问题计数
 *
 * 用法：node check-quality-score.js --file=<正文> [--handoff=<衔接包JSON>] [--metadata=<设定JSON>] [--json]
 * 不依赖外部 npm 包。只报告不修改。
 */

const fs = require('fs');
const path = require('path');
const {
  stripQuoted,
  visibleLength,
  isDivider,
  isStructural,
  hasYamlFrontMatter,
  splitSentences,
  parseFenceMarker,
  calculateBurstiness,
  calculateTTR,
  detectTransitionPatterns,
  calculateInfoDensityVariance,
  // V5.4.1: 阈值改为从 prose-utils.js 导入，消除硬编码不一致
  BURSTINESS_CV_SCORE_FULL,
  BURSTINESS_CV_SCORE_PASS,
} = require('./lib/prose-utils.js');

const USAGE = `Usage: node check-quality-score.js --file=<prose> [--handoff=<json>] [--metadata=<json>] [--json]

Hybrid quality scoring: objective script score (60pts) + LLM subjective score (40pts, no calibration).
V5.3.1: removed 0.8 penalty factor (arXiv:2511.21140 math mismatch), 100-pt scale.

Options:
  --file       Path to chapter prose file (required)
  --handoff    Path to handoff package JSON (optional)
  --metadata   Path to novel metadata JSON (optional)
  --json       Output JSON only to stdout (default: human-readable to stderr + JSON to stdout)

Report-only. Never rewrites text.`;

// ============================================================
//  感官词库（五感分类）
//  用于质感密度维度的感官词频统计
// ============================================================

const SENSORY_WORDS = {
  // 眼：视觉相关词
  sight: [
    '看', '望', '瞥', '瞪', '盯', '瞄', '瞧', '瞅', '凝视', '注视',
    '俯瞰', '仰望', '环顾', '打量', '端详', '视线', '目光', '瞳孔', '眼神', '眺望',
  ],
  // 耳：听觉相关词
  hearing: [
    '听', '响', '声', '嘶', '嚷', '喊', '叫', '咆哮', '低语', '呢喃',
    '轰鸣', '回响', '喧嚣', '嘈杂', '沉寂', '寂静', '呼啸', '嗡嗡', '滴答', '沙沙',
  ],
  // 鼻：嗅觉相关词
  smell: [
    '嗅', '腥', '香', '臭', '腐', '霉', '焦', '铁锈', '潮', '湿',
    '气味', '刺鼻', '腥味', '焦味', '霉味', '腐臭', '芳香',
  ],
  // 舌：味觉相关词
  taste: [
    '尝', '舔', '甜', '苦', '辣', '咸', '涩', '酸', '鲜', '甘',
    '腥甜', '苦涩', '酸甜', '咸腥',
  ],
  // 身：触觉/体感相关词
  touch: [
    '摸', '碰', '触', '热', '冷', '疼', '痛', '麻', '痒', '凉',
    '暖', '冰', '烫', '粗糙', '光滑', '湿润', '干燥', '颤抖', '僵硬', '酸软',
  ],
};

// ============================================================
//  排除搭配表：含感官字但非感官描写的常见复合词
//  在 Trie 中标记 $exclude=true，FMM 匹配后跳过不计数
//  与 check-emotion-density.js 共用 Trie+FMM 代码模式
// ============================================================

const SENSORY_EXCLUDE_COMPOUNDS = {
  // sight（视觉）— 看/望 的引申义
  '看': ['看待', '看重', '看法', '看不起', '看得起', '看作', '看做', '看透', '看开', '看破', '看病', '看穿', '看中', '看上'],
  '望': ['期望', '绝望', '愿望', '欲望', '希望', '盼望', '渴望', '指望'],
  // hearing（听觉）— 声/响/叫 的引申义
  '声': ['声明', '声张', '不动声色', '声势', '声誉', '声称', '声调', '声望'],
  '响': ['响应', '影响'],
  '叫': ['叫做'],
  // taste（味觉）— 苦/酸 的引申义
  '苦': ['刻苦', '困苦', '苦笑', '苦心', '苦力', '苦水', '苦于'],
  '酸': ['辛酸', '酸楚', '酸痛'],
  // touch（触觉）— 冷/热/痛/麻/凉 的引申义
  '冷': ['冷静', '冷淡', '冷漠', '冷清', '冷酷', '冷落', '冷战'],
  '热': ['热心', '热情', '热门', '热闹', '热切', '热衷'],
  '痛': ['头痛', '痛点', '痛风', '痛经'],
  '麻': ['麻烦', '麻利'],
  '凉': ['荒凉', '凄凉'],
};

// ============================================================
//  Trie 树 + 正向最大匹配（FMM）
//  解决 indexOf 子串匹配导致的误计数问题
// ============================================================

/**
 * 构建感官词 Trie 树（含排除搭配词）
 * 感官词标记 $sense + $exclude=false
 * 排除词标记 $exclude=true（不覆盖已存在的感官词）
 * @returns {Object} Trie 根节点
 */
function buildSensoryTrie() {
  const trie = {};
  // 插入感官词
  for (const [sense, words] of Object.entries(SENSORY_WORDS)) {
    for (const word of words) {
      let node = trie;
      for (const char of word) {
        if (!node[char]) node[char] = {};
        node = node[char];
      }
      node.$word = word;
      node.$sense = sense;
      node.$exclude = false;
    }
  }
  // 插入排除搭配词（不覆盖已存在的感官词）
  for (const compounds of Object.values(SENSORY_EXCLUDE_COMPOUNDS)) {
    for (const word of compounds) {
      let node = trie;
      for (const char of word) {
        if (!node[char]) node[char] = {};
        node = node[char];
      }
      if (!node.$word) {
        node.$word = word;
        node.$exclude = true;
      }
    }
  }
  return trie;
}

/**
 * 正向最大匹配（FMM）提取感官词
 * 从每个位置尝试最长匹配，匹配成功后跳过已匹配字符
 * 排除词（$exclude=true）跳过不计数但消耗字符
 * @param {string} text - 待扫描文本
 * @param {Object} trie - buildSensoryTrie 返回的 Trie 根节点
 * @returns {Array<{word: string, sense: string, position: number}>}
 */
function extractSensoryWords(text, trie) {
  const results = [];
  let i = 0;
  while (i < text.length) {
    // 从位置 i 开始，尝试最长匹配
    let node = trie;
    let bestMatch = null;   // { word, sense, exclude, length }
    let depth = 0;
    for (let j = i; j < text.length; j++) {
      const char = text[j];
      if (!node[char]) break;
      node = node[char];
      depth++;
      if (node.$word) {
        bestMatch = {
          word: node.$word,
          sense: node.$sense,
          exclude: node.$exclude === true,
          length: depth,
        };
      }
    }
    if (bestMatch) {
      if (!bestMatch.exclude) {
        results.push({
          word: bestMatch.word,
          sense: bestMatch.sense,
          position: i,
        });
      }
      // 无论是否排除，都跳过已匹配字符
      i += bestMatch.length;
    } else {
      i += 1;
    }
  }
  return results;
}

// 模块级 Trie（构建一次，多次复用）
const SENSORY_TRIE = buildSensoryTrie();

// ============================================================
//  比喻/明喻模式（复用 check-ai-patterns.js 定义）
// ============================================================

const SIMILE_PATTERNS = [
  /像[^""」』\n]{1,20}一样/g,
  /像[^""」』\n]{1,20}似的/g,
  /像[^""」』\n]{1,15}(?:一般|般)/g,
  /仿佛[^""」』\n]{2,25}/g,
  /如同[^""」』\n]{2,25}/g,
  /宛若[^""」』\n]{2,20}/g,
  /好似[^""」』\n]{2,20}/g,
  /犹如[^""」』\n]{2,20}/g,
];

// ============================================================
//  AI blocking 级模式（简化版，用于 AI味基线 评分）
// ============================================================

/** A级叙述语违禁词：零容忍，出现即 blocking */
const AI_NARRATIVE_BAN_A = [
  '意味着', '是因为', '这说明', '他发现', '他心里明白', '他在等',
  '他意识到', '显然', '可见', '看出规律', '异乎寻常',
];

/** 否定排比三连：连续否定分句构成排比 */
const NEGATION_PARALLELISM_RE = /(?:没有|不是|并非)[^，。；！？\n]{2,30}[，](?:没有|不是|并非)[^，。；！？\n]{2,30}[，]/g;

/** "不是…而是…" AI对比句式 */
const NOT_IS_RE = /不是[^，。！？\n]{2,40}(?:而是|只有|那是一种|唯有)/g;

/** 破折号模式 */
const EM_DASH_RE = /——|—|--+/g;

/** 闪回标记词：检测已死亡角色出现时排除闪回上下文 */
const FLASHBACK_MARKERS = /那一年|他想起|回忆|记忆中|多年前|曾经|梦中|幻觉|往事|旧事/;

// ============================================================
//  评分阈值常量
// ============================================================

const LLM_MAX_RAW = 40;                                                    // LLM 主观分满分（V5.3.1: 不再×0.8压缩）
const LLM_MAX_EFFECTIVE = LLM_MAX_RAW;                                     // 40（有效满分 = 原始满分）
const LLM_MEDIAN_SCORE = 30;                                               // 中等 LLM 分
const LLM_MEDIAN_EFFECTIVE = LLM_MEDIAN_SCORE;                             // 30（中等有效分，不再×0.8）

const FLOW_THRESHOLD_FAST = 80;   // fast 通道总分阈值
const FLOW_THRESHOLD_FULL = 60;   // full 流程总分阈值

const SEGMENT_SIZE = 500;         // 信息密度分段大小（字）
const MIN_NARRATIVE_CHARS = 200; // 最小叙述字数（低于此值跳过部分检测）
const MIN_SENTENCE_COUNT = 5;     // 最小句子数（低于此值节奏检测降级）

// ============================================================
//  CLI 参数解析
// ============================================================

/**
 * 解析命令行参数，支持 --key=value 和 --key value 两种格式
 * @param {string[]} argv - process.argv
 * @returns {{file: string|null, handoff: string|null, metadata: string|null, json: boolean}}
 */
function parseArgs(argv) {
  const opts = { file: null, handoff: null, metadata: null, json: false };
  const args = argv.slice(2);

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];

    if (arg === '-h' || arg === '--help') {
      process.stdout.write(`${USAGE}\n`);
      process.exit(0);
    }

    if (arg.startsWith('--file=')) {
      opts.file = arg.slice('--file='.length);
    } else if (arg === '--file') {
      opts.file = args[++i] || null;
    } else if (arg.startsWith('--handoff=')) {
      opts.handoff = arg.slice('--handoff='.length);
    } else if (arg === '--handoff') {
      opts.handoff = args[++i] || null;
    } else if (arg.startsWith('--metadata=')) {
      opts.metadata = arg.slice('--metadata='.length);
    } else if (arg === '--metadata') {
      opts.metadata = args[++i] || null;
    } else if (arg === '--json') {
      opts.json = true;
    }
  }

  if (!opts.file) {
    console.error('Error: --file is required');
    console.error(USAGE);
    process.exit(2);
  }

  return opts;
}

// ============================================================
//  文本预处理工具函数
// ============================================================

/**
 * 安全读取 JSON 文件，解析失败返回 null
 * @param {string} filePath - JSON 文件路径
 * @returns {Object|null}
 */
function parseJSON(filePath) {
  try {
    return JSON.parse(fs.readFileSync(path.resolve(filePath), 'utf8'));
  } catch (e) {
    console.error(`Warning: could not parse JSON file ${filePath}: ${e.message}`);
    return null;
  }
}

/**
 * 提取章节正文行（跳过代码块、分隔线、结构性文本、YAML前言）
 * 复用 check-rhythm.js / check-ai-patterns.js 的提取逻辑
 * @param {string} input - 原始文件内容
 * @returns {string[]} - 纯正文行数组
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

    // 跳过代码块
    const fenceMarker = parseFenceMarker(trimmed);
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

    // 跳过空行、分隔线、结构性标记
    if (!trimmed || isDivider(trimmed) || isStructural(trimmed)) continue;

    proseLines.push(line);
  }

  return proseLines;
}

/**
 * 压缩文本用于摘要展示（去除多余空白，截断至80字）
 * @param {string} t - 原始文本
 * @returns {string}
 */
function compact(t) {
  const n = String(t).replace(/\s+/g, ' ').trim();
  return n.length > 80 ? `${n.slice(0, 77)}...` : n;
}

/**
 * 中文数字解析（完整版，支持万/亿/段分隔符）
 * V5.3修复：复用 check-consistency.js 的段分隔符方案
 *
 * 支持：
 *   "二十三"→23, "一百"→100,
 *   "三万"→30000, "百万"→1000000, "三亿"→300000000,
 *   "十万"→100000, "三万五千"→35000
 *
 * 算法：分段进位制
 *   - 万/亿 是段分隔符（乘法），不是加法单位
 *   - 十/百/千 是段内累加单位
 *   - "十万" = (0+10) × 10000 = 100000（旧逻辑错误返回10010）
 *
 * @param {string} str - 数字字符串（中文或阿拉伯）
 * @returns {number} - 解析后的数值，无法解析返回 NaN
 */
function parseChineseNumberSimple(str) {
  if (str == null || str === '') return NaN;
  // 纯阿拉伯数字直接返回
  if (/^\d+(\.\d+)?$/.test(str)) return parseFloat(str);

  // 段分隔符：万/亿 是乘法段分隔符
  const SECTION_UNITS = { '万': 10000, '亿': 100000000 };
  // 段内单位：十/百/千 是段内累加
  const DIGIT_UNITS = { '十': 10, '百': 100, '千': 1000 };
  // 数字字符
  const DIGITS = {
    '一': 1, '二': 2, '两': 2, '三': 3, '四': 4, '五': 5,
    '六': 6, '七': 7, '八': 8, '九': 9, '零': 0, '半': 0.5,
  };

  let sectionValue = 0;  // 当前段内累积值
  let tempDigit = 0;     // 当前临时数字
  let totalValue = 0;    // 已完成段的总值

  for (const char of str) {
    if (DIGITS[char] !== undefined) {
      tempDigit = DIGITS[char];
    } else if (DIGIT_UNITS[char] !== undefined) {
      sectionValue += (tempDigit || 1) * DIGIT_UNITS[char];
      tempDigit = 0;
    } else if (SECTION_UNITS[char] !== undefined) {
      sectionValue += tempDigit;
      totalValue = (totalValue + sectionValue) * SECTION_UNITS[char];
      sectionValue = 0;
      tempDigit = 0;
    } else {
      // 非数字字符，返回已累积值或 NaN
      return totalValue + sectionValue + tempDigit > 0
        ? totalValue + sectionValue + tempDigit
        : NaN;
    }
  }
  sectionValue += tempDigit;
  return totalValue + sectionValue;
}

// ============================================================
//  维度1：情节推进力（15分）
//  检测信息密度（对话+动作占比），每500字分段计算
// ============================================================

/**
 * 评估情节推进力
 * 使用 calculateInfoDensityVariance 按500字分段计算信息密度，
 * 密度过低表示推进力不足（水字数段）。
 * @param {string} text - 原始全文（含对话）
 * @param {string[]} proseLines - 纯正文行数组
 * @returns {{score: number, max: number, reasons: string[], details: Object}}
 */
function scorePlotPropulsion(text, proseLines) {
  const fullText = proseLines.join('\n');
  const { variance, densities, mean } = calculateInfoDensityVariance(fullText, SEGMENT_SIZE);

  let score = 15;
  const reasons = [];

  // 基础密度评分：mean 表示平均信息密度（对话+动作占比）
  if (mean >= 0.08) {
    reasons.push(`信息密度良好：均值${mean.toFixed(3)}（≥0.08），情节推进充分`);
  } else if (mean >= 0.05) {
    score -= 2;
    reasons.push(`信息密度适中：均值${mean.toFixed(3)}（0.05-0.08），略有不足`);
  } else if (mean >= 0.03) {
    score -= 5;
    reasons.push(`信息密度偏低：均值${mean.toFixed(3)}（0.03-0.05），推进力不足`);
  } else {
    score -= 8;
    reasons.push(`信息密度过低：均值${mean.toFixed(3)}（<0.03），严重缺乏推进力`);
  }

  // 水字数段落检测：密度极低的段落
  const waterSegments = densities.filter((d) => d < 0.02).length;
  if (waterSegments > 0) {
    const deduction = Math.min(waterSegments * 2, 5);
    score -= deduction;
    reasons.push(`检测到${waterSegments}个低密度段落（密度<0.02），疑似水字数段，扣${deduction}分`);
  }

  // 密度方差检测：张弛节奏
  if (densities.length >= 3 && variance < 0.002) {
    score -= 2;
    reasons.push(`信息密度过于均匀（方差${variance.toFixed(4)}<0.002），缺乏张弛节奏`);
  }

  score = Math.max(0, score);

  return {
    score,
    max: 15,
    reasons,
    details: {
      mean_density: parseFloat(mean.toFixed(4)),
      variance: parseFloat(variance.toFixed(4)),
      segment_count: densities.length,
      water_segments: waterSegments,
    },
  };
}

// ============================================================
//  维度2：节奏控制（15分）
//  burstiness CV + 句长方差检测
// ============================================================

/**
 * 评估节奏控制
 * 使用 calculateBurstiness 计算句长变异系数（CV），
 * CV≥BURSTINESS_CV_SCORE_FULL(0.5)满分，BURSTINESS_CV_SCORE_PASS(0.3)-FULL(0.5)得10分，<PASS(0.3)得0分；
 * 句长标准差<8追加扣分。
 *
 * 注：此处阈值与 check-ai-patterns.js 的 BURSTINESS_CV_THRESHOLD(0.35) 不同是设计意图：
 *   - check-ai-patterns.js 是"AI模式检测"：CV<0.35=blocking（判定AI节奏指纹）
 *   - 本函数是"质量评分"：CV 0.3/0.5 是评分梯度（满分/及格/不及格）
 * 两者均从 prose-utils.js 导入统一常量，避免硬编码不一致。
 *
 * @param {string[]} proseLines - 纯正文行数组
 * @returns {{score: number, max: number, reasons: string[], details: Object}}
 */
function scoreRhythmControl(proseLines) {
  // 提取叙述文本中的句子（去除对话后分割）
  const allSentences = [];
  for (const line of proseLines) {
    const narrative = stripQuoted(line);
    if (visibleLength(narrative) === 0) continue;
    for (const sentence of splitSentences(narrative)) {
      if (visibleLength(sentence) > 0) allSentences.push(sentence);
    }
  }

  let score = 15;
  const reasons = [];

  // 句子数量不足时降级评分
  if (allSentences.length < MIN_SENTENCE_COUNT) {
    score = 5;
    reasons.push(`句子数量过少（${allSentences.length}句），无法有效评估节奏`);
    return {
      score,
      max: 15,
      reasons,
      details: { sentence_count: allSentences.length, cv: 0, stdDev: 0, mean_length: 0 },
    };
  }

  const { cv, mean, stdDev, count } = calculateBurstiness(allSentences);

  // burstiness CV 评分（核心指标）— V5.4.1: 阈值改为从 prose-utils.js 导入
  if (cv >= BURSTINESS_CV_SCORE_FULL) {
    reasons.push(`节奏控制优秀：CV=${cv.toFixed(2)}（≥${BURSTINESS_CV_SCORE_FULL}），长短句交替良好`);
  } else if (cv >= BURSTINESS_CV_SCORE_PASS) {
    score -= 5;
    reasons.push(`节奏控制一般：CV=${cv.toFixed(2)}（${BURSTINESS_CV_SCORE_PASS}-${BURSTINESS_CV_SCORE_FULL}），句式变化不够，建议在关键情绪点插入极短句或长句`);
  } else {
    score -= 10;
    reasons.push(`节奏控制差：CV=${cv.toFixed(2)}（<${BURSTINESS_CV_SCORE_PASS}），句式过于均匀，AI节奏指纹明显`);
  }

  // 句长方差检测：标准差过低追加扣分
  if (stdDev < 8) {
    score -= 3;
    reasons.push(`句长方差不足：标准差${stdDev.toFixed(1)}（<8），建议混入短句（1-5字）和长句（30+字）增加节奏变化`);
  }

  score = Math.max(0, score);

  return {
    score,
    max: 15,
    reasons,
    details: {
      cv: parseFloat(cv.toFixed(2)),
      mean_sentence_length: parseFloat(mean.toFixed(1)),
      stdDev: parseFloat(stdDev.toFixed(1)),
      sentence_count: count,
    },
  };
}

// ============================================================
//  维度3：质感密度（10分）
//  感官词频统计（眼/耳/鼻/舌/身）+ 比喻密度
// ============================================================

/**
 * 评估质感密度
 * 统计五感相关词频（感官多样性），检测比喻密度（≤3/千字满分）。
 * @param {string[]} proseLines - 纯正文行数组
 * @returns {{score: number, max: number, reasons: string[], details: Object}}
 */
function scoreTextureDensity(proseLines) {
  let totalChars = 0;
  let narrativeText = '';

  for (const line of proseLines) {
    const narrative = stripQuoted(line);
    const len = visibleLength(narrative);
    if (len === 0) continue;
    totalChars += len;
    narrativeText += narrative;
  }

  let score = 10;
  const reasons = [];

  // 文本过短时降级
  if (totalChars < MIN_NARRATIVE_CHARS) {
    reasons.push(`叙述文本过短（${totalChars}字），质感密度检测降级`);
    return { score: 7, max: 10, reasons, details: { total_chars: totalChars } };
  }

  // 统计五感词频（Trie + FMM，排除非感官搭配词）
  const sensoryWordsFound = extractSensoryWords(narrativeText, SENSORY_TRIE);
  const sensoryCounts = {};
  for (const sense of Object.keys(SENSORY_WORDS)) {
    sensoryCounts[sense] = 0;
  }
  for (const sw of sensoryWordsFound) {
    sensoryCounts[sw.sense] = (sensoryCounts[sw.sense] || 0) + 1;
  }

  const totalSensory = Object.values(sensoryCounts).reduce((a, b) => a + b, 0);
  const sensoryDensity = totalChars > 0 ? (totalSensory / totalChars) * 1000 : 0;
  const sensoryCategories = Object.values(sensoryCounts).filter((c) => c > 0).length;

  // 感官多样性评分
  if (sensoryCategories >= 4) {
    reasons.push(`感官描写丰富：覆盖${sensoryCategories}/5种感官（密度${sensoryDensity.toFixed(1)}/千字）`);
  } else if (sensoryCategories >= 3) {
    score -= 2;
    reasons.push(`感官描写适中：覆盖${sensoryCategories}/5种感官（密度${sensoryDensity.toFixed(1)}/千字），可增加更多感官维度`);
  } else {
    score -= 5;
    reasons.push(`感官描写不足：仅覆盖${sensoryCategories}/5种感官（密度${sensoryDensity.toFixed(1)}/千字），缺乏质感层次`);
  }

  // 比喻密度评分
  let metaphorCount = 0;
  for (const pattern of SIMILE_PATTERNS) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(narrativeText)) !== null) {
      metaphorCount += 1;
    }
  }
  const metaphorDensity = totalChars > 0 ? metaphorCount / (totalChars / 1000) : 0;

  if (metaphorDensity >= 4.0) {
    score -= 5;
    reasons.push(`比喻密度超标：${metaphorDensity.toFixed(1)}/千字（≥4），装饰性比喻过多`);
  } else if (metaphorDensity > 3.0) {
    score -= 3;
    reasons.push(`比喻密度偏高：${metaphorDensity.toFixed(1)}/千字（>3），建议精简至3/千字以内`);
  } else {
    reasons.push(`比喻密度合格：${metaphorDensity.toFixed(1)}/千字（≤3）`);
  }

  score = Math.max(0, score);

  return {
    score,
    max: 10,
    reasons,
    details: {
      sensory_counts: sensoryCounts,
      sensory_density: parseFloat(sensoryDensity.toFixed(1)),
      sensory_categories: sensoryCategories,
      metaphor_count: metaphorCount,
      metaphor_density: parseFloat(metaphorDensity.toFixed(2)),
      total_narrative_chars: totalChars,
    },
  };
}

// ============================================================
//  维度4：角色一致性（10分）
//  调用 check-consistency.js 的逻辑检测名称/数值矛盾（简化内联）
// ============================================================

/**
 * 评估角色一致性
 * 简化内联检测：已死亡角色出现（无闪回标记）、年龄数值异常、设定矛盾。
 * 当提供 metadata 设定JSON时进行深度检测，否则给予基准分。
 * @param {string} text - 原始全文
 * @param {Object|null} metadata - 设定JSON（含 number_anchors）
 * @param {Object|null} handoff - 衔接包JSON（含角色状态）
 * @returns {{score: number, max: number, reasons: string[], details: Object}}
 */
function scoreCharacterConsistency(text, metadata, handoff) {
  const reasons = [];
  let issueCount = 0;

  // 无设定数据时给予基准分
  if (!metadata && !handoff) {
    reasons.push('未提供设定JSON或衔接包，无法进行一致性检测，给予基准分7分');
    return {
      score: 7,
      max: 10,
      reasons,
      details: { issues_found: 0, metadata_used: false, handoff_used: false },
    };
  }

  const details = { issues_found: 0, metadata_used: false, handoff_used: false };

  // ── 从 metadata 检测 ──
  if (metadata) {
    details.metadata_used = true;
    const chars = metadata?.number_anchors?.character_numbers || {};
    const charEntries = Object.entries(chars);

    // 收集所有角色名（含别名），按长度降序避免子串误匹配
    const allNames = [];
    for (const [charName, charData] of charEntries) {
      allNames.push(charName);
      if (Array.isArray(charData?.aliases)) {
        allNames.push(...charData.aliases);
      }
    }
    allNames.sort((a, b) => b.length - a.length);

    // 检测已死亡角色以活人状态出现
    for (const [charName, charData] of charEntries) {
      if (charData?.status !== '已死亡') continue;
      const namesToSearch = [charName, ...(charData?.aliases || [])];
      for (const name of namesToSearch) {
        let idx = text.indexOf(name);
        while (idx !== -1) {
          // 检查是否为更长角色名的子串
          let isPartOfLonger = false;
          for (const other of allNames) {
            if (other === name || other.length <= name.length) continue;
            if (other.startsWith(name) && text.substring(idx, idx + other.length) === other) {
              isPartOfLonger = true;
              break;
            }
          }
          if (!isPartOfLonger) {
            // 检查上下文是否有闪回标记
            const context = text.substring(
              Math.max(0, idx - 100),
              Math.min(text.length, idx + name.length + 100)
            );
            if (!FLASHBACK_MARKERS.test(context)) {
              issueCount += 1;
              reasons.push(`已死亡角色"${charName}"可能以活人状态出现（上下文无闪回标记）`);
              break; // 同一角色只报告一次
            }
          }
          idx = text.indexOf(name, idx + name.length);
        }
      }
    }

    // 检测年龄数值异常（简化版语义校验）
    const agePattern = /(\d+)岁/g;
    let ageMatch;
    while ((ageMatch = agePattern.exec(text)) !== null) {
      const ageValue = parseInt(ageMatch[1], 10);
      if (ageValue > 200 || ageValue < 0) {
        issueCount += 1;
        reasons.push(`年龄数值异常："${ageMatch[0]}"（超出合理范围0-200）`);
      }
    }
  }

  // ── 从 handoff 检测 ──
  if (handoff) {
    details.handoff_used = true;
    // 衔接包中的角色状态（支持多种 schema 格式）
    const handoffChars = handoff?.character_states || handoff?.characters || {};
    for (const [name, state] of Object.entries(handoffChars)) {
      const status = typeof state === 'string' ? state : state?.status;
      if (status === '已死亡') {
        const idx = text.indexOf(name);
        if (idx !== -1) {
          const context = text.substring(
            Math.max(0, idx - 50),
            Math.min(text.length, idx + name.length + 50)
          );
          if (!FLASHBACK_MARKERS.test(context)) {
            issueCount += 1;
            reasons.push(`衔接包标记"${name}"为已死亡，但正文可能以活人状态出现`);
          }
        }
      }
    }
  }

  // 评分：0个=10分，1-2个=7分，3-5个=3分，>5个=0分
  let score;
  if (issueCount === 0) {
    score = 10;
    reasons.push('未检测到角色一致性问题');
  } else if (issueCount <= 2) {
    score = 7;
    reasons.push(`检测到${issueCount}个一致性问题`);
  } else if (issueCount <= 5) {
    score = 3;
    reasons.push(`检测到${issueCount}个一致性问题`);
  } else {
    score = 0;
    reasons.push(`检测到${issueCount}个一致性问题（严重），建议重写`);
  }

  details.issues_found = issueCount;
  return { score, max: 10, reasons, details };
}

// ============================================================
//  维度5：AI味基线（10分）
//  统计 blocking 级问题数
// ============================================================

/**
 * 检测 blocking 级 AI 味问题
 * 简化版检测 5 类 blocking 模式：
 *   1. not-is-comparison（"不是…而是…"AI对比句式）
 *   2. negation-parallelism（否定排比三连）
 *   3. narrative-ban-a（A级叙述语违禁词）
 *   4. em-dash-excess（破折号≥8处/章）
 *   5. metaphor-density（比喻密度≥4/千字）
 * @param {string[]} proseLines - 纯正文行数组
 * @returns {Array<{type: string, excerpt: string}>}
 */
function detectBlockingIssues(proseLines) {
  const issues = [];
  let totalChars = 0;
  let metaphorCount = 0;
  let dashCount = 0;

  for (const line of proseLines) {
    const narrative = stripQuoted(line);
    const len = visibleLength(narrative);
    if (len === 0) continue;

    totalChars += len;

    // 1. not-is-comparison：在叙述语中检测
    NOT_IS_RE.lastIndex = 0;
    let match;
    while ((match = NOT_IS_RE.exec(narrative)) !== null) {
      issues.push({ type: 'not-is-comparison', excerpt: compact(match[0]) });
    }

    // 2. negation-parallelism：否定排比三连
    NEGATION_PARALLELISM_RE.lastIndex = 0;
    while ((match = NEGATION_PARALLELISM_RE.exec(narrative)) !== null) {
      issues.push({ type: 'negation-parallelism', excerpt: compact(match[0]) });
    }

    // 3. narrative-ban-a：A级叙述语违禁词
    for (const word of AI_NARRATIVE_BAN_A) {
      let idx = narrative.indexOf(word);
      while (idx !== -1) {
        issues.push({ type: 'narrative-ban-a', excerpt: word });
        idx = narrative.indexOf(word, idx + word.length);
      }
    }

    // 4. em-dash 计数（在原始行中检测，含对话）
    EM_DASH_RE.lastIndex = 0;
    let dashMatch;
    while ((dashMatch = EM_DASH_RE.exec(line)) !== null) {
      dashCount += 1;
    }

    // 5. 比喻计数（在叙述语中检测）
    for (const pattern of SIMILE_PATTERNS) {
      pattern.lastIndex = 0;
      let m;
      while ((m = pattern.exec(narrative)) !== null) {
        metaphorCount += 1;
      }
    }
  }

  // em-dash blocking 判定（≥8处/章）
  if (dashCount >= 8) {
    issues.push({ type: 'em-dash-excess', excerpt: `破折号${dashCount}处（≥8）` });
  }

  // 比喻密度 blocking 判定（≥4/千字）
  const metaphorDensity = totalChars > MIN_NARRATIVE_CHARS
    ? metaphorCount / (totalChars / 1000)
    : 0;
  if (metaphorDensity >= 4.0) {
    issues.push({ type: 'metaphor-density', excerpt: `${metaphorDensity.toFixed(1)}/千字（≥4）` });
  }

  return issues;
}

/**
 * 评估 AI 味基线
 * 统计 blocking 级问题数：0个=10分，1-2个=7分，3-5个=3分，>5个=0分
 * @param {string[]} proseLines - 纯正文行数组
 * @returns {{score: number, max: number, reasons: string[], details: Object}}
 */
function scoreAIBaseline(proseLines) {
  const issues = detectBlockingIssues(proseLines);
  const blockingCount = issues.length;

  let score;
  const reasons = [];

  if (blockingCount === 0) {
    score = 10;
    reasons.push('未检测到blocking级AI味问题');
  } else if (blockingCount <= 2) {
    score = 7;
    const typeList = issues.map((i) => i.type).join(', ');
    reasons.push(`检测到${blockingCount}个blocking级问题：${typeList}`);
  } else if (blockingCount <= 5) {
    score = 3;
    const typeList = issues.map((i) => i.type).join(', ');
    reasons.push(`检测到${blockingCount}个blocking级问题：${typeList}`);
  } else {
    score = 0;
    reasons.push(`检测到${blockingCount}个blocking级问题（严重），建议重写`);
  }

  return {
    score,
    max: 10,
    reasons,
    details: {
      blocking_count: blockingCount,
      issues: issues.slice(0, 10),
    },
  };
}

// ============================================================
//  流程推荐逻辑
// ============================================================

/**
 * 根据客观分计算流程推荐
 * objective_score + 40（LLM满分）≥80 → "fast"
 * objective_score + 30（中等LLM分）≥60 → "full"
 * 否则 → "rewrite"
 * @param {number} objectiveScore - 客观分（0-60）
 * @returns {'fast'|'full'|'rewrite'}
 */
function determineFlowRecommendation(objectiveScore) {
  const maxTotal = objectiveScore + LLM_MAX_EFFECTIVE;     // 客观分 + 40
  const medianTotal = objectiveScore + LLM_MEDIAN_EFFECTIVE; // 客观分 + 30

  if (maxTotal >= FLOW_THRESHOLD_FAST) {
    return 'fast';
  }
  if (medianTotal >= FLOW_THRESHOLD_FULL) {
    return 'full';
  }
  return 'rewrite';
}

// ============================================================
//  人类可读输出
// ============================================================

/**
 * 格式化人类可读的评分报告，输出到 stderr
 * @param {Object} report - 完整评分报告
 * @param {Object} options - CLI 选项
 */
function printHumanReadable(report, options) {
  const lines = [];
  lines.push('=== 混合质量评分报告 ===');
  lines.push(`文件: ${options.file}`);
  if (options.metadata) lines.push(`设定: ${options.metadata}`);
  if (options.handoff) lines.push(`衔接包: ${options.handoff}`);
  lines.push('');

  lines.push(`客观分: ${report.objective_score}/60`);
  const d = report.objective_details;
  lines.push(`  情节推进力: ${d.plot_propulsion.score}/${d.plot_propulsion.max} — ${d.plot_propulsion.reasons[0]}`);
  lines.push(`  节奏控制:   ${d.rhythm_control.score}/${d.rhythm_control.max} — ${d.rhythm_control.reasons[0]}`);
  lines.push(`  质感密度:   ${d.texture_density.score}/${d.texture_density.max} — ${d.texture_density.reasons[0]}`);
  lines.push(`  角色一致性: ${d.character_consistency.score}/${d.character_consistency.max} — ${d.character_consistency.reasons[0]}`);
  lines.push(`  AI味基线:   ${d.ai_baseline.score}/${d.ai_baseline.max} — ${d.ai_baseline.reasons[0]}`);
  lines.push('');

  lines.push(`LLM主观分上限: ${report.llm_max_score} (40, V5.3.1不压缩)`);
  lines.push(`总分上限: ${report.total_max}`);
  lines.push('');

  lines.push(`流程推荐: ${report.flow_recommendation}`);
  if (report.flow_recommendation === 'fast') {
    lines.push(`  (客观分${report.objective_score} + LLM满分${report.llm_max_score} = ${report.total_max} ≥ ${FLOW_THRESHOLD_FAST} → 快速通道)`);
  } else if (report.flow_recommendation === 'full') {
    lines.push(`  (客观分${report.objective_score} + 中等LLM分${LLM_MEDIAN_EFFECTIVE} = ${report.objective_score + LLM_MEDIAN_EFFECTIVE} ≥ ${FLOW_THRESHOLD_FULL} → 完整流程)`);
  } else {
    lines.push(`  (客观分${report.objective_score} + 中等LLM分${LLM_MEDIAN_EFFECTIVE} = ${report.objective_score + LLM_MEDIAN_EFFECTIVE} < ${FLOW_THRESHOLD_FULL} → 需重写)`);
  }
  lines.push('');

  // 详细原因
  lines.push('--- 各维度详细原因 ---');
  for (const [dim, data] of Object.entries(report.objective_details)) {
    lines.push(`[${dim}] ${data.score}/${data.max}`);
    for (const r of data.reasons) {
      lines.push(`  - ${r}`);
    }
  }

  console.error(lines.join('\n'));
}

// ============================================================
//  主函数
// ============================================================

function main() {
  const options = parseArgs(process.argv);

  // 读取正文文件
  let text;
  try {
    text = fs.readFileSync(path.resolve(options.file), 'utf8');
  } catch (e) {
    console.error(`Error reading file ${options.file}: ${e.message}`);
    process.exit(2);
  }

  // 提取正文行
  const proseLines = extractProseLines(text);

  // 读取可选的衔接包和设定 JSON
  const metadata = options.metadata ? parseJSON(options.metadata) : null;
  const handoff = options.handoff ? parseJSON(options.handoff) : null;

  // 计算 5 个客观维度评分
  const plotPropulsion = scorePlotPropulsion(text, proseLines);
  const rhythmControl = scoreRhythmControl(proseLines);
  const textureDensity = scoreTextureDensity(proseLines);
  const characterConsistency = scoreCharacterConsistency(text, metadata, handoff);
  const aiBaseline = scoreAIBaseline(proseLines);

  // 汇总客观分
  const objectiveScore =
    plotPropulsion.score +
    rhythmControl.score +
    textureDensity.score +
    characterConsistency.score +
    aiBaseline.score;

  // 流程推荐
  const flowRecommendation = determineFlowRecommendation(objectiveScore);

  // 构建报告
  const report = {
    objective_score: objectiveScore,
    objective_details: {
      plot_propulsion: plotPropulsion,
      rhythm_control: rhythmControl,
      texture_density: textureDensity,
      character_consistency: characterConsistency,
      ai_baseline: aiBaseline,
    },
    llm_subjective_score: null,
    llm_max_score: LLM_MAX_EFFECTIVE,
    total_max: objectiveScore + LLM_MAX_EFFECTIVE,
    flow_recommendation: flowRecommendation,
    threshold: {
      fast: FLOW_THRESHOLD_FAST,
      full: FLOW_THRESHOLD_FULL,
      rewrite: FLOW_THRESHOLD_FULL,
    },
  };

  // 输出
  if (!options.json) {
    printHumanReadable(report, options);
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);

  // 退出码：flow_recommendation 为 rewrite 时返回 1（供 CI 集成使用）
  if (flowRecommendation === 'rewrite') {
    process.exit(1);
  }
  process.exit(0);
}

main();

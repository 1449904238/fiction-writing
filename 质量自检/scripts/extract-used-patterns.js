#!/usr/bin/env node
'use strict';

/**
 * extract-used-patterns.js — 跨章已用模式自动提取
 *
 * V4.0 新增脚本（问题3解决方案）：
 *   自动扫描最近 N 章正文，提取已用句式/意象/身体反应模式，
 *   输出结构化 JSON 供 03a 扩写时加载为 <used_patterns> 上下文。
 *   替代原来依赖用户手动维护"已用句式清单"的脆弱机制。
 *
 * 检测类别：
 *   - sentence_patterns: 高频句式模式（字符3-gram提取，语言独立，适合中文）
 *   - imagery_frequency: 意象词频（名词+形容词组合）
 *   - body_reactions: 身体反应描写频次
 *   - punctuation_rhythm: 标点节奏统计
 *   - sentence_length_stats: 句长分布与burstiness（变异系数）
 *   - scene_openers: 场景开篇模式（首句n-gram签名）
 *
 * 用法：node extract-used-patterns.js [--json] [--n=5] <chapter-files...>
 * 输出：JSON 格式的已用模式清单
 * 只报告不修改。
 */

const fs = require('fs');
const path = require('path');

const USAGE = `Usage: node extract-used-patterns.js [--json] [--n=5] <chapter-files...>

Extract used patterns from recent N chapters for cross-chapter dedup.
Outputs JSON for 03a to load as <used_patterns> context.
Report-only. Never rewrites text.`;

// ════════════════════════════════════════════════════════════
//  配置
// ════════════════════════════════════════════════════════════

const DEFAULT_N = 5; // 默认扫描最近5章

// 高频AI句式模式（正则匹配）
const SENTENCE_PATTERNS = [
  { name: 'not-is-comparison', regex: /不是[^，。！？\n]{1,40}[，,]?\s*(?:而是|而是)/g, label: '不是A是B' },
  { name: 'simile-ru', regex: /仿佛[^，。！？\n]{2,25}/g, label: '仿佛…（一般）' },
  { name: 'simile-tong', regex: /如同[^，。！？\n]{2,25}/g, label: '如同…' },
  { name: 'simile-wan', regex: /宛若[^，。！？\n]{2,20}/g, label: '宛若…' },
  { name: 'heart-tight', regex: /心中一[紧颤凉]/g, label: '心中一紧/颤/凉' },
  { name: 'breath-cold', regex: /倒吸(?:一口)?凉气/g, label: '倒吸凉气' },
  { name: 'fist-clench', regex: /握紧(?:了)?拳头/g, label: '握紧拳头' },
  { name: 'heartbeat', regex: /心跳(?:加速|加快|如鼓|如雷)/g, label: '心跳加速' },
  { name: 'eye-cold', regex: /眼神(?:冰冷|凛冽|锐利|如刀)/g, label: '眼神冰冷/锐利' },
  { name: 'brow-furrow', regex: /眉头(?:紧锁|一皱|微皱)/g, label: '眉头紧锁/一皱' },
  { name: 'corner-mouth', regex: /嘴角(?:上扬|微扬|勾起|抽搐)/g, label: '嘴角上扬/勾起' },
  { name: 'voice-hoarse', regex: /声音(?:沙哑|嘶哑|低沉|冰冷)/g, label: '声音沙哑/低沉' },
  { name: 'silence-fall', regex: /(?:空气|氛围|场面)?(?:瞬间)?(?:陷入)?沉默/g, label: '陷入沉默' },
  { name: 'time-freeze', regex: /(?:时间|空间)(?:仿佛)?(?:瞬间)?(?:静止|停滞|凝固)/g, label: '时间静止' },
  { name: 'wind-blow', regex: /风吹过[^，。！？\n]{0,15}/g, label: '风吹过…' },
  { name: 'moon-light', regex: /月光(?:洒|照|映|落)/g, label: '月光洒/照' },
];

// 身体反应模式
const BODY_REACTION_PATTERNS = [
  { name: 'fist', regex: /握(?:紧|住)?(?:了)?(?:拳头|双拳)/g, label: '握拳' },
  { name: 'tremble', regex: /(?:身体|手|腿)?(?:微微)?(?:发抖|颤抖|哆嗦)/g, label: '颤抖' },
  { name: 'cold-sweat', regex: /(?:冷汗|汗珠)(?:冒出|滚落|流下|渗出)/g, label: '冷汗' },
  { name: 'pale', regex: /(?:脸色|面色)(?:苍白|发白|惨白)/g, label: '脸色苍白' },
  { name: 'red-face', regex: /(?:脸色|面色|脸)(?:涨红|通红|发红)/g, label: '脸色涨红' },
  { name: 'gasp', regex: /(?:倒吸|深吸)(?:一口)?(?:凉气|冷气|气)/g, label: '吸气' },
  { name: 'stagger', regex: /(?:踉跄|趔趄|后退(?:几步|两步))/g, label: '踉跄后退' },
  { name: 'wide-eyes', regex: /(?:瞳孔|眼睛|双目)(?:放大|睁大|一缩)/g, label: '瞳孔放大' },
  { name: 'clench-teeth', regex: /咬(?:紧|住)?(?:牙关|嘴唇|下唇)/g, label: '咬牙' },
];

// 意象词表（高频环境意象，用于跨章重复检测）
const IMAGERY_WORDS = [
  '月光', '阳光', '星光', '灯光', '火光',
  '风', '雨', '雪', '雾', '云',
  '血', '泪', '汗',
  '剑', '刀', '拳', '掌',
  '墙', '门', '窗', '桌', '椅',
  '茶', '酒', '药',
  '路', '桥', '河', '山', '树',
];

// 句子分隔符
const SENTENCE_END = new Set(['。', '！', '？', '!', '?', '\n']);

// ════════════════════════════════════════════════════════════
//  核心函数
// ════════════════════════════════════════════════════════════

/**
 * 读取文件内容
 */
function readFile(filepath) {
  try {
    return fs.readFileSync(filepath, 'utf-8');
  } catch (e) {
    return null;
  }
}

/**
 * 统计字符 n-gram 频率
 */
function extractCharNgrams(text, n = 3) {
  const grams = {};
  // 只处理中文字符，跳过标点和空白
  const cleaned = text.replace(/[^\u4e00-\u9fff]/g, '');
  for (let i = 0; i <= cleaned.length - n; i++) {
    const gram = cleaned.substring(i, i + n);
    grams[gram] = (grams[gram] || 0) + 1;
  }
  return grams;
}

/**
 * 提取高频 n-gram（出现次数 >= minFreq）
 */
function getTopNgrams(grams, minFreq = 3) {
  return Object.entries(grams)
    .filter(([_, count]) => count >= minFreq)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 50)
    .map(([gram, count]) => ({ pattern: gram, count }));
}

/**
 * 匹配句式模式
 */
function matchSentencePatterns(text) {
  const results = {};
  for (const pat of SENTENCE_PATTERNS) {
    const matches = text.match(pat.regex);
    if (matches && matches.length > 0) {
      results[pat.label] = {
        name: pat.name,
        count: matches.length,
        examples: matches.slice(0, 3) // 保留最多3个示例
      };
    }
  }
  return results;
}

/**
 * 匹配身体反应
 */
function matchBodyReactions(text) {
  const results = {};
  for (const pat of BODY_REACTION_PATTERNS) {
    const matches = text.match(pat.regex);
    if (matches && matches.length > 0) {
      results[pat.label] = {
        name: pat.name,
        count: matches.length
      };
    }
  }
  return results;
}

/**
 * 统计意象词频
 */
function countImagery(text) {
  const results = {};
  for (const word of IMAGERY_WORDS) {
    // 使用全局搜索计数
    let count = 0;
    let idx = text.indexOf(word);
    while (idx !== -1) {
      count++;
      idx = text.indexOf(word, idx + word.length);
    }
    if (count > 0) {
      results[word] = count;
    }
  }
  return results;
}

/**
 * 标点节奏统计
 */
function countPunctuation(text) {
  const count = (regex) => (text.match(regex) || []).length;
  return {
    ellipsis: count(/…/g),           // 省略号
    dash: count(/——/g),              // 破折号
    exclaim: count(/[！!]/g),        // 感叹号
    question: count(/[？?]/g),       // 问号
    comma: count(/[，,]/g),          // 逗号
    period: count(/[。.]/g),         // 句号
    semicolon: count(/[；;]/g),      // 分号
    colon: count(/[：:]/g),          // 冒号
  };
}

/**
 * 句长统计与 burstiness（变异系数）
 */
function analyzeSentenceLength(text) {
  const sentences = [];
  let current = '';
  for (const char of text) {
    current += char;
    if (SENTENCE_END.has(char)) {
      const trimmed = current.trim();
      if (trimmed.length > 0) {
        sentences.push(trimmed);
      }
      current = '';
    }
  }
  if (current.trim().length > 0) {
    sentences.push(current.trim());
  }

  if (sentences.length === 0) {
    return { count: 0, mean: 0, std: 0, burstiness: 0, min: 0, max: 0 };
  }

  const lengths = sentences.map(s => s.length);
  const mean = lengths.reduce((a, b) => a + b, 0) / lengths.length;
  const variance = lengths.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / lengths.length;
  const std = Math.sqrt(variance);
  const burstiness = mean > 0 ? std / mean : 0; // 变异系数

  return {
    count: sentences.length,
    mean: parseFloat(mean.toFixed(1)),
    std: parseFloat(std.toFixed(1)),
    burstiness: parseFloat(burstiness.toFixed(3)),
    min: Math.min(...lengths),
    max: Math.max(...lengths),
  };
}

/**
 * 提取场景开篇签名（每章首句的 n-gram）
 */
function extractSceneOpeners(text, n = 4) {
  // 取前200字的 n-gram 签名
  const opener = text.substring(0, 200);
  const cleaned = opener.replace(/[^\u4e00-\u9fff]/g, '');
  const grams = [];
  for (let i = 0; i <= cleaned.length - n; i++) {
    grams.push(cleaned.substring(i, i + n));
  }
  return grams.slice(0, 10); // 返回前10个 n-gram 作为签名
}

/**
 * 分析单个章节
 */
function analyzeChapter(filepath) {
  const text = readFile(filepath);
  if (!text) return null;

  // 只取正文部分（跳过元数据标记）
  const bodyMatch = text.match(/<chapter_content>([\s\S]*?)<\/chapter_content>/);
  const body = bodyMatch ? bodyMatch[1] : text;

  return {
    file: path.basename(filepath),
    char_count: body.length,
    sentence_patterns: matchSentencePatterns(body),
    body_reactions: matchBodyReactions(body),
    imagery: countImagery(body),
    punctuation: countPunctuation(body),
    sentence_length: analyzeSentenceLength(body),
    scene_openers: extractSceneOpeners(body),
    char_3gram_top: getTopNgrams(extractCharNgrams(body, 3), 3),
  };
}

/**
 * 汇总多章数据
 */
function aggregateChapters(analyses, chapterRange) {
  // 汇总句式模式
  const allSentencePatterns = {};
  for (const analysis of analyses) {
    for (const [label, data] of Object.entries(analysis.sentence_patterns)) {
      if (!allSentencePatterns[label]) {
        allSentencePatterns[label] = { name: data.name, total_count: 0, chapters: [] };
      }
      allSentencePatterns[label].total_count += data.count;
      allSentencePatterns[label].chapters.push({ file: analysis.file, count: data.count, examples: data.examples });
    }
  }

  // 汇总身体反应
  const allBodyReactions = {};
  for (const analysis of analyses) {
    for (const [label, data] of Object.entries(analysis.body_reactions)) {
      if (!allBodyReactions[label]) {
        allBodyReactions[label] = { name: data.name, total_count: 0, chapters: [] };
      }
      allBodyReactions[label].total_count += data.count;
      allBodyReactions[label].chapters.push({ file: analysis.file, count: data.count });
    }
  }

  // 汇总意象
  const allImagery = {};
  for (const analysis of analyses) {
    for (const [word, count] of Object.entries(analysis.imagery)) {
      allImagery[word] = (allImagery[word] || 0) + count;
    }
  }

  // 汇总标点
  const allPunctuation = { ellipsis: [], dash: [], exclaim: [], question: [], comma: [], period: [] };
  for (const analysis of analyses) {
    allPunctuation.ellipsis.push(analysis.punctuation.ellipsis);
    allPunctuation.dash.push(analysis.punctuation.dash);
    allPunctuation.exclaim.push(analysis.punctuation.exclaim);
    allPunctuation.question.push(analysis.punctuation.question);
    allPunctuation.comma.push(analysis.punctuation.comma);
    allPunctuation.period.push(analysis.punctuation.period);
  }
  const avg = (arr) => parseFloat((arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(1));

  // 汇总句长
  const allBurstiness = analyses.map(a => a.sentence_length.burstiness);
  const allMeanLen = analyses.map(a => a.sentence_length.mean);

  // 汇总场景开篇签名（用于检测开篇模板重复）
  const allOpeners = analyses.map(a => ({ file: a.file, openers: a.scene_openers }));

  // 检测开篇签名重复
  const openerDuplicates = detectOpenerDuplicates(allOpeners);

  return {
    chapter_range: chapterRange,
    chapter_count: analyses.length,
    total_chars: analyses.reduce((sum, a) => sum + a.char_count, 0),

    sentence_patterns: allSentencePatterns,
    body_reactions: allBodyReactions,
    imagery_frequency: allImagery,

    punctuation_rhythm: {
      ellipsis_avg: avg(allPunctuation.ellipsis),
      dash_avg: avg(allPunctuation.dash),
      exclaim_avg: avg(allPunctuation.exclaim),
      question_avg: avg(allPunctuation.question),
      comma_avg: avg(allPunctuation.comma),
      period_avg: avg(allPunctuation.period),
    },

    sentence_length_stats: {
      burstiness_mean: avg(allBurstiness),
      burstiness_range: allBurstiness,
      mean_length_avg: avg(allMeanLen),
      burstiness_warning: Math.min(...allBurstiness) < 0.35, // 最低burstiness<0.35 = 节奏风险
    },

    scene_opener_duplicates: openerDuplicates,

    // 高频3-gram（跨章重复短语检测）
    cross_chapter_ngrams: detectCrossChapterNgrams(analyses),

    per_chapter: analyses.map(a => ({
      file: a.file,
      char_count: a.char_count,
      burstiness: a.sentence_length.burstiness,
      sentence_count: a.sentence_length.count,
    })),
  };
}

/**
 * 检测场景开篇签名重复
 */
function detectOpenerDuplicates(allOpeners) {
  const duplicates = [];
  for (let i = 0; i < allOpeners.length; i++) {
    for (let j = i + 1; j < allOpeners.length; j++) {
      const setA = new Set(allOpeners[i].openers);
      const setB = new Set(allOpeners[j].openers);
      const intersection = [...setA].filter(x => setB.has(x));
      if (intersection.length >= 3) {
        duplicates.push({
          chapter_a: allOpeners[i].file,
          chapter_b: allOpeners[j].file,
          shared_ngrams: intersection,
          severity: intersection.length >= 5 ? 'blocking' : 'advisory',
        });
      }
    }
  }
  return duplicates;
}

/**
 * 检测跨章重复高频 n-gram
 */
function detectCrossChapterNgrams(analyses) {
  const ngramChapters = {}; // ngram → [chapter files]
  for (const analysis of analyses) {
    const seen = new Set();
    for (const item of analysis.char_3gram_top) {
      if (!seen.has(item.pattern)) {
        if (!ngramChapters[item.pattern]) {
          ngramChapters[item.pattern] = [];
        }
        ngramChapters[item.pattern].push(analysis.file);
        seen.add(item.pattern);
      }
    }
  }
  // 只返回出现在 >=2 章中的 n-gram
  return Object.entries(ngramChapters)
    .filter(([_, chapters]) => chapters.length >= 2)
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, 20)
    .map(([gram, chapters]) => ({ ngram: gram, chapter_count: chapters.length, chapters }));
}

// ════════════════════════════════════════════════════════════
//  主流程
// ════════════════════════════════════════════════════════════

function main() {
  const args = process.argv.slice(2);
  const files = [];
  let n = DEFAULT_N;
  let jsonMode = false;

  for (const arg of args) {
    if (arg === '--json') {
      jsonMode = true;
    } else if (arg.startsWith('--n=')) {
      n = parseInt(arg.substring(4), 10) || DEFAULT_N;
    } else if (arg === '--help' || arg === '-h') {
      console.log(USAGE);
      process.exit(0);
    } else {
      files.push(arg);
    }
  }

  if (files.length === 0) {
    console.error(USAGE);
    process.exit(1);
  }

  // 只取最近 N 章
  const recentFiles = files.slice(-n);
  const chapterRange = `${path.basename(recentFiles[0])} ~ ${path.basename(recentFiles[recentFiles.length - 1])}`;

  // 分析每章
  const analyses = [];
  for (const file of recentFiles) {
    const analysis = analyzeChapter(file);
    if (analysis) {
      analyses.push(analysis);
    } else {
      console.error(`Warning: could not read ${file}`);
    }
  }

  if (analyses.length === 0) {
    console.error('Error: no readable chapter files found.');
    process.exit(1);
  }

  // 汇总
  const result = aggregateChapters(analyses, chapterRange);

  // 输出
  if (jsonMode) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    printReport(result);
  }
}

/**
 * 人类可读报告
 */
function printReport(result) {
  console.log('═══════════════════════════════════════════════════════');
  console.log('  跨章已用模式提取报告');
  console.log('═══════════════════════════════════════════════════════');
  console.log(`章节范围: ${result.chapter_range}`);
  console.log(`章节数: ${result.chapter_count}  |  总字数: ${result.total_chars}`);
  console.log('');

  // 句式模式
  console.log('── 已用句式模式 ──');
  const sortedPatterns = Object.entries(result.sentence_patterns).sort((a, b) => b[1].total_count - a[1].total_count);
  for (const [label, data] of sortedPatterns) {
    const flag = data.total_count >= 3 ? ' ⚠️高频' : '';
    console.log(`  ${label}: ${data.total_count}次 (出现在${data.chapters.length}章)${flag}`);
  }
  console.log('');

  // 身体反应
  console.log('── 已用身体反应 ──');
  const sortedReactions = Object.entries(result.body_reactions).sort((a, b) => b[1].total_count - a[1].total_count);
  for (const [label, data] of sortedReactions) {
    const flag = data.total_count >= 3 ? ' ⚠️高频' : '';
    console.log(`  ${label}: ${data.total_count}次${flag}`);
  }
  console.log('');

  // 意象
  console.log('── 高频意象 (>=3次) ──');
  const sortedImagery = Object.entries(result.imagery_frequency).filter(([_, c]) => c >= 3).sort((a, b) => b[1] - a[1]);
  for (const [word, count] of sortedImagery) {
    console.log(`  ${word}: ${count}次`);
  }
  console.log('');

  // 标点节奏
  console.log('── 标点节奏 (平均/章) ──');
  const pr = result.punctuation_rhythm;
  console.log(`  省略号: ${pr.ellipsis_avg}  破折号: ${pr.dash_avg}  感叹号: ${pr.exclaim_avg}`);
  console.log(`  问号: ${pr.question_avg}  逗号: ${pr.comma_avg}  句号: ${pr.period_avg}`);
  console.log('');

  // 句长
  console.log('── 句长与节奏 ──');
  const sl = result.sentence_length_stats;
  console.log(`  Burstiness均值: ${sl.burstiness_mean}  ${sl.burstiness_warning ? '⚠️ 有章节节奏过于均匀' : '✓'}`);
  console.log(`  各章Burstiness: [${sl.burstiness_range.join(', ')}]`);
  console.log(`  平均句长: ${sl.mean_length_avg}字`);
  console.log('');

  // 场景开篇重复
  if (result.scene_opener_duplicates.length > 0) {
    console.log('── ⚠️ 场景开篇签名重复 ──');
    for (const dup of result.scene_opener_duplicates) {
      console.log(`  ${dup.chapter_a} ↔ ${dup.chapter_b}: ${dup.shared_ngrams.length}个共享n-gram [${dup.severity}]`);
    }
    console.log('');
  }

  // 跨章重复短语
  if (result.cross_chapter_ngrams.length > 0) {
    console.log('── 跨章重复高频短语 (出现在>=2章) ──');
    for (const item of result.cross_chapter_ngrams.slice(0, 10)) {
      console.log(`  "${item.ngram}": ${item.chapter_count}章`);
    }
    console.log('');
  }

  // 逐章概览
  console.log('── 逐章概览 ──');
  for (const ch of result.per_chapter) {
    const burstFlag = ch.burstiness < 0.35 ? ' ⚠️' : '';
    console.log(`  ${ch.file}: ${ch.char_count}字, ${ch.sentence_count}句, burstiness=${ch.burstiness}${burstFlag}`);
  }

  console.log('');
  console.log('提示: 使用 --json 获取机器可读的 JSON 输出，供 03a 加载为 <used_patterns>。');
}

main();

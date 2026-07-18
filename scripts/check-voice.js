#!/usr/bin/env node
'use strict';

/**
 * check-voice.js — 角色声口同质化检测脚本（V5.3.1 新增, P2-5）
 *
 * 功能：提取每个角色的对话行，计算角色间声口相似度。
 * 当角色间余弦相似度 >0.7 时标红（声口同质化），提示各角色说话方式过于雷同。
 *
 * 检测维度：
 *   1. 词汇丰富度（TTR）— 用词多样性
 *   2. 平均句长 — 对话句子的平均长度
 *   3. 口头禅频率 — 语气词（啊/呢/吧/嘛/哦/呀/哩/呗）使用频率
 *   4. 句式分布 — 短句/中句/长句/疑问句/感叹句占比
 *
 * 用法：node scripts/check-voice.js --input <章节文件> --characters <角色名列表>
 *   --input       章节正文文件路径（required）
 *   --characters  角色名列表，逗号分隔（required，如 "张三,李四,王五"）
 *   --json        仅输出 JSON 到 stdout
 *
 * 只报告不修改。零 npm 依赖。
 */

const fs = require('fs');
const path = require('path');
const { segmentChinese, visibleLength, splitSentences } = require('./lib/prose-utils.js');

const USAGE = `Usage: node scripts/check-voice.js --input <chapter> --characters <name1,name2,...> [--json]

Voice consistency check: extract per-character dialogue, compute inter-character voice similarity.
Flags pairs with cosine similarity > 0.7 as voice homogenization (blocking).

Options:
  --input       Path to chapter prose file (required)
  --characters  Comma-separated character names (required, e.g. "张三,李四,王五")
  --json        Output JSON only to stdout

Report-only. Never rewrites text.`;

// ============================================================
//  CLI 参数解析
// ============================================================

function parseArgs(argv) {
  const opts = { input: null, characters: [], json: false };
  const args = argv.slice(2);

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];

    if (arg === '-h' || arg === '--help') {
      process.stdout.write(`${USAGE}\n`);
      process.exit(0);
    }

    if (arg.startsWith('--input=')) {
      opts.input = arg.slice('--input='.length);
    } else if (arg === '--input') {
      opts.input = args[++i] || null;
    } else if (arg.startsWith('--characters=')) {
      opts.characters = arg.slice('--characters='.length).split(',').map(s => s.trim()).filter(Boolean);
    } else if (arg === '--characters') {
      opts.characters = (args[++i] || '').split(',').map(s => s.trim()).filter(Boolean);
    } else if (arg === '--json') {
      opts.json = true;
    }
  }

  if (!opts.input) {
    console.error('Error: --input is required');
    console.error(USAGE);
    process.exit(2);
  }

  if (opts.characters.length < 2) {
    console.error('Error: --characters requires at least 2 names (comma-separated)');
    console.error(USAGE);
    process.exit(2);
  }

  return opts;
}

// ============================================================
//  对话提取与角色归属
// ============================================================

/**
 * 从正文中提取每个角色的对话内容
 * 支持中文小说常见对话格式：
 *   1. 角色名 + 说/道/问/答等 + ：/:"..."  → 前置标签
 *   2. "..." + 角色名 + 说/道/问/答等       → 后置标签
 *   3. 角色名 + 笑/叹/怒等 + 道："..."      → 动作+道
 *
 * @param {string} text - 原始全文
 * @param {string[]} characters - 角色名列表
 * @returns {Object<string, string[]>} - { 角色名: [对话内容1, 对话内容2, ...] }
 */
function extractDialogueByCharacter(text, characters) {
  const dialogueMap = {};
  for (const name of characters) {
    dialogueMap[name] = [];
  }

  // 按行处理
  const lines = text.split(/\r?\n/);

  // 对话引号正则：中文弯引号 / 直角引号 / ASCII双引号
  const dialogueRe = /[\u201c"]([^\u201d"]*)[\u201d"]|[\u300c\u300e]([^\u300d\u300f]*)[\u300d\u300f]/g;

  // 说话动词列表
  const speechVerbs = '说|道|问|答|叫|喊|嚷|骂|笑|叹|怒|吼|喝|回|答|道|低声道|轻声说|喃喃道|低语|呢喃|冷声道|沉声道|怒道|笑道|哭道|喊道|问道|答道|叫道';

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // 尝试匹配所有对话内容
    dialogueRe.lastIndex = 0;
    let match;
    while ((match = dialogueRe.exec(trimmed)) !== null) {
      const dialogueContent = match[1] || match[2] || '';
      if (!dialogueContent) continue;

      const matchStart = match.index;
      const matchEnd = match.index + match[0].length;
      const beforeText = trimmed.slice(0, matchStart);
      const afterText = trimmed.slice(matchEnd);

      // 尝试从前置文本中找角色名（"张三道："格式）
      let attributedTo = null;
      for (const name of characters) {
        // 前置标签：角色名 + 说话动词 + 可选标点
        const prefixRe = new RegExp(name + '\\s*(?:' + speechVerbs + ')\\s*[：:。！？]?\s*$');
        if (prefixRe.test(beforeText)) {
          attributedTo = name;
          break;
        }
        // 前置标签：角色名 + 动作 + 说话动词
        const actionPrefixRe = new RegExp(name + '[^，。！？\\n]{0,10}(?:' + speechVerbs + ')\\s*[：:]?\s*$');
        if (actionPrefixRe.test(beforeText)) {
          attributedTo = name;
          break;
        }
      }

      // 如果前置文本没找到，尝试后置文本（"...张三道"格式）
      if (!attributedTo) {
        for (const name of characters) {
          const suffixRe = new RegExp('^[，。！？]?\\s*' + name + '\\s*(?:' + speechVerbs + ')');
          if (suffixRe.test(afterText)) {
            attributedTo = name;
            break;
          }
        }
      }

      // 如果仍未归属，检查整行是否只包含一个角色名
      if (!attributedTo) {
        for (const name of characters) {
          if (beforeText.includes(name) && !characters.some(other => other !== name && beforeText.includes(other))) {
            attributedTo = name;
            break;
          }
        }
      }

      if (attributedTo) {
        dialogueMap[attributedTo].push(dialogueContent);
      }
    }
  }

  return dialogueMap;
}

// ============================================================
//  声口特征计算
// ============================================================

/** 语气词列表 */
const PARTICLES = new Set(['啊', '呢', '吧', '嘛', '哦', '呀', '哩', '呗', '哈', '唉', '嗯', '哇', '哎', '喂']);

/**
 * 计算单个角色的声口特征向量
 * 维度：TTR, 平均句长, 语气词频率, 短句占比, 中句占比, 长句占比, 疑问句占比, 感叹句占比
 *
 * @param {string[]} dialogues - 该角色的对话内容数组
 * @returns {{vector: number[], labels: string[], details: Object, sampleCount: number}}
 */
function computeVoiceProfile(dialogues) {
  const allText = dialogues.join('');
  const allSentences = [];
  for (const d of dialogues) {
    for (const s of splitSentences(d)) {
      if (visibleLength(s) > 0) allSentences.push(s);
    }
  }

  const sampleCount = dialogues.length;
  const totalChars = visibleLength(allText);

  // 样本不足时返回零向量
  if (sampleCount === 0 || totalChars === 0) {
    return {
      vector: [0, 0, 0, 0, 0, 0, 0, 0],
      labels: ['ttr', 'avg_sentence_length', 'particle_frequency', 'short_ratio', 'medium_ratio', 'long_ratio', 'question_ratio', 'exclamation_ratio'],
      details: {
        sample_count: 0,
        total_chars: 0,
        ttr: 0,
        avg_sentence_length: 0,
        particle_frequency: 0,
        short_ratio: 0,
        medium_ratio: 0,
        long_ratio: 0,
        question_ratio: 0,
        exclamation_ratio: 0,
      },
      sampleCount: 0,
    };
  }

  // 1. 词汇丰富度（TTR）— 词级
  const tokens = segmentChinese(allText);
  const uniqueTokens = new Set(tokens);
  const ttr = tokens.length > 0 ? uniqueTokens.size / tokens.length : 0;

  // 2. 平均句长
  const sentenceLengths = allSentences.map(s => visibleLength(s));
  const avgLen = sentenceLengths.length > 0
    ? sentenceLengths.reduce((a, b) => a + b, 0) / sentenceLengths.length
    : 0;

  // 3. 语气词频率（每百字）
  let particleCount = 0;
  for (const ch of allText) {
    if (PARTICLES.has(ch)) particleCount++;
  }
  const particleFreq = totalChars > 0 ? (particleCount / totalChars) * 100 : 0;

  // 4. 句式分布
  let shortCount = 0, mediumCount = 0, longCount = 0;
  let questionCount = 0, exclamationCount = 0;
  for (const d of dialogues) {
    // 疑问句/感叹句检测
    if (/[？?]/.test(d)) questionCount++;
    if (/[！!]/.test(d)) exclamationCount++;
  }
  for (const len of sentenceLengths) {
    if (len <= 10) shortCount++;
    else if (len <= 25) mediumCount++;
    else longCount++;
  }
  const totalSentences = sentenceLengths.length || 1;
  const shortRatio = shortCount / totalSentences;
  const mediumRatio = mediumCount / totalSentences;
  const longRatio = longCount / totalSentences;
  const questionRatio = dialogues.length > 0 ? questionCount / dialogues.length : 0;
  const exclamationRatio = dialogues.length > 0 ? exclamationCount / dialogues.length : 0;

  // 特征向量（归一化处理，使各维度量纲可比）
  // TTR: 0-1, avgLen: 归一化到 0-1 (除以50), particleFreq: 归一化到 0-1 (除以10)
  // ratios: 已经是 0-1
  const vector = [
    ttr,
    Math.min(avgLen / 50, 1),
    Math.min(particleFreq / 10, 1),
    shortRatio,
    mediumRatio,
    longRatio,
    questionRatio,
    exclamationRatio,
  ];

  return {
    vector,
    labels: ['ttr', 'avg_sentence_length', 'particle_frequency', 'short_ratio', 'medium_ratio', 'long_ratio', 'question_ratio', 'exclamation_ratio'],
    details: {
      sample_count: sampleCount,
      total_chars: totalChars,
      ttr: parseFloat(ttr.toFixed(4)),
      avg_sentence_length: parseFloat(avgLen.toFixed(1)),
      particle_frequency: parseFloat(particleFreq.toFixed(2)),
      short_ratio: parseFloat(shortRatio.toFixed(3)),
      medium_ratio: parseFloat(mediumRatio.toFixed(3)),
      long_ratio: parseFloat(longRatio.toFixed(3)),
      question_ratio: parseFloat(questionRatio.toFixed(3)),
      exclamation_ratio: parseFloat(exclamationRatio.toFixed(3)),
    },
    sampleCount,
  };
}

// ============================================================
//  余弦相似度计算
// ============================================================

/**
 * 计算两个向量的余弦相似度
 * @param {number[]} v1 - 向量1
 * @param {number[]} v2 - 向量2
 * @returns {number} - 余弦相似度 [0, 1]（非负维度时）
 */
function cosineSimilarity(v1, v2) {
  if (v1.length !== v2.length || v1.length === 0) return 0;
  let dot = 0, mag1 = 0, mag2 = 0;
  for (let i = 0; i < v1.length; i++) {
    dot += v1[i] * v2[i];
    mag1 += v1[i] * v1[i];
    mag2 += v2[i] * v2[i];
  }
  if (mag1 === 0 || mag2 === 0) return 0;
  return dot / (Math.sqrt(mag1) * Math.sqrt(mag2));
}

// ============================================================
//  报告生成
// ============================================================

/** 相似度告警阈值 */
const SIMILARITY_THRESHOLD = 0.7;

/**
 * 生成完整的声口检测报告
 * @param {string} filePath - 输入文件路径
 * @param {string[]} characters - 角色名列表
 * @param {Object} voiceProfiles - { 角色名: voiceProfile }
 * @param {Array} similarityPairs - [{ char_a, char_b, similarity, flagged }]
 * @returns {Object} - JSON 报告
 */
function buildReport(filePath, characters, voiceProfiles, similarityPairs) {
  const flaggedPairs = similarityPairs.filter(p => p.flagged);
  return {
    file: filePath,
    characters,
    timestamp: new Date().toISOString(),
    voice_profiles: Object.fromEntries(
      characters.map(name => [name, voiceProfiles[name].details])
    ),
    similarity_matrix: similarityPairs,
    summary: {
      total_characters: characters.length,
      total_pairs: similarityPairs.length,
      flagged_pairs: flaggedPairs.length,
      max_similarity: similarityPairs.length > 0
        ? parseFloat(Math.max(...similarityPairs.map(p => p.similarity)).toFixed(4))
        : 0,
      has_voice_homogenization: flaggedPairs.length > 0,
    },
    threshold: SIMILARITY_THRESHOLD,
  };
}

/**
 * 打印人类可读的声口检测摘要到 stderr
 * @param {Object} report - 完整报告
 * @param {string} filePath - 文件路径
 */
function printHumanReadable(report, filePath) {
  const lines = [];
  lines.push('=== 角色声口同质化检测报告 ===');
  lines.push(`文件: ${filePath}`);
  lines.push(`角色: ${report.characters.join(', ')}`);
  lines.push('');

  // 各角色声口特征
  lines.push('--- 各角色声口特征 ---');
  for (const name of report.characters) {
    const p = report.voice_profiles[name];
    if (p.sample_count === 0) {
      lines.push(`[${name}] 未检测到对话行`);
    } else {
      lines.push(`[${name}] 对话${p.sample_count}段, ${p.total_chars}字, TTR=${p.ttr}, 均句长=${p.avg_sentence_length}, 语气词=${p.particle_frequency}/百字, 短句占比=${p.short_ratio}, 长句占比=${p.long_ratio}`);
    }
  }
  lines.push('');

  // 相似度矩阵
  lines.push('--- 角色间声口相似度 ---');
  for (const pair of report.similarity_matrix) {
    const flag = pair.flagged ? ' *** 声口同质化 ***' : '';
    const icon = pair.flagged ? 'RED' : 'OK';
    lines.push(`[${icon}] ${pair.char_a} <-> ${pair.char_b}: ${pair.similarity.toFixed(4)} (阈值>${SIMILARITY_THRESHOLD})${flag}`);
  }
  lines.push('');

  // 总结
  if (report.summary.has_voice_homogenization) {
    lines.push(`>>> 检测到 ${report.summary.flagged_pairs} 对角色声口同质化（相似度>${SIMILARITY_THRESHOLD}）`);
    lines.push('    建议：为每个角色设计独特的口头禅、句式偏好、语气词使用模式。');
  } else {
    lines.push('>>> 各角色声口差异充分，未检测到同质化问题。');
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
    text = fs.readFileSync(path.resolve(options.input), 'utf8');
  } catch (e) {
    console.error(`Error reading file ${options.input}: ${e.message}`);
    process.exit(2);
  }

  // 提取每个角色的对话
  const dialogueMap = extractDialogueByCharacter(text, options.characters);

  // 计算每个角色的声口特征
  const voiceProfiles = {};
  for (const name of options.characters) {
    voiceProfiles[name] = computeVoiceProfile(dialogueMap[name]);
  }

  // 计算角色间余弦相似度
  const similarityPairs = [];
  for (let i = 0; i < options.characters.length; i++) {
    for (let j = i + 1; j < options.characters.length; j++) {
      const a = options.characters[i];
      const b = options.characters[j];
      const v1 = voiceProfiles[a].vector;
      const v2 = voiceProfiles[b].vector;
      // 如果任一角色无对话样本，跳过（相似度=0）
      let sim = 0;
      if (voiceProfiles[a].sampleCount > 0 && voiceProfiles[b].sampleCount > 0) {
        sim = cosineSimilarity(v1, v2);
      }
      similarityPairs.push({
        char_a: a,
        char_b: b,
        similarity: parseFloat(sim.toFixed(4)),
        flagged: sim > SIMILARITY_THRESHOLD,
      });
    }
  }

  // 构建报告
  const report = buildReport(options.input, options.characters, voiceProfiles, similarityPairs);

  // 输出
  if (!options.json) {
    printHumanReadable(report, options.input);
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);

  // 退出码：有声口同质化时返回 1
  if (report.summary.has_voice_homogenization) {
    process.exit(1);
  }
  process.exit(0);
}

main();

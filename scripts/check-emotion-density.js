#!/usr/bin/env node
'use strict';

/**
 * check-emotion-density.js — 情绪密度与多样性检测（V5.1新增）
 *
 * 与 check-ai-patterns.js 的 emotion-direct 检测互补：
 *   - emotion-direct 检测"直给情绪词"（悲伤/愤怒/绝望等，应外化）
 *   - 本脚本检测"情绪密度/多样性/曲线"（是否有足够情绪变化，是否单调）
 *
 * 检测 5 类问题：
 *   - emotion-density（情绪密度）：每千字情绪词数量，过低=情绪平淡，过高=情绪泛滥
 *   - emotion-variety（情绪多样性）：全章出现了几种情绪类别，<3=单调
 *   - emotion-monotony（情绪单调）：同一情绪词重复次数，≥5=advisory，≥8=blocking
 *   - emotion-curve（情绪曲线）：前1/3/中1/3/后1/3的情绪分布是否变化
 *   - anchor-delivery（锚点交付）：用户情绪锚点是否在正文中体现（需--anchor参数）
 *
 * 用法：node check-emotion-density.js [--json] [--anchor=解气] <file...>
 * 只报告不修改。
 */

const fs = require('fs');
const path = require('path');

const USAGE = `Usage: node check-emotion-density.js [--json] [--anchor=解气] <file...>

Detect emotion density, variety, monotony, and curve shape:
  - emotion-density: per-1000-chars emotion word count
  - emotion-variety: number of distinct emotion categories
  - emotion-monotony: same emotion word repeated too many times
  - emotion-curve: emotion distribution across chapter thirds
  - anchor-delivery: check if user emotion anchor is delivered (requires --anchor)

Report-only. Never rewrites text.`;

// ============================================================
// 情绪词库（6大类，每类含正向/负向）
// ============================================================

const EMOTION_CATEGORIES = {
  // 爽类：满足、释放、胜利
  '爽': {
    words: ['爽', '痛快', '畅快', '解气', '过瘾', '舒坦', '舒服', '满足', '得意', '痛快淋漓', '扬眉吐气', '酣畅', '尽兴', '快意', '快活', '惬意', '顺心', '如愿'],
    weight: 1.0
  },
  // 燃类：热血、激昂、振奋
  '燃': {
    words: ['燃', '热血', '激昂', '振奋', '激动', '兴奋', '激荡', '澎湃', '汹涌', '沸腾', '燃烧', '冲锋', '拼搏', '战斗', '崛起', '爆发', '怒吼', '咆哮'],
    weight: 1.0
  },
  // 虐类：痛苦、悲伤、绝望
  '虐': {
    words: ['虐', '痛', '苦', '悲', '伤', '绝望', '痛苦', '悲伤', '心碎', '心酸', '心寒', '心死', '凄凉', '凄惨', '悲凉', '悲恸', '哀伤', '哀恸', '痛彻心扉', '撕心裂肺', '肝肠寸断'],
    weight: 0.8
  },
  // 酸类：感动、温暖、柔情
  '酸': {
    words: ['酸', '感动', '心疼', '心软', '温暖', '温柔', '柔情', '怜惜', '不舍', '牵挂', '惦念', '想念', '思念', '怀念', '惆怅', '感伤', '鼻酸', '眼眶', '泪目', '哽咽'],
    weight: 0.9
  },
  // 惧类：恐惧、紧张、不安
  '惧': {
    words: ['惧', '怕', '恐惧', '害怕', '畏惧', '惊恐', '惶恐', '不安', '紧张', '焦虑', '慌张', '慌乱', '惊慌', '胆寒', '战栗', '颤抖', '发抖', '毛骨悚然', '不寒而栗'],
    weight: 0.8
  },
  // 暖类：安心、放松、幸福
  '暖': {
    words: ['暖', '安心', '放心', '踏实', '宁静', '平和', '安详', '欣慰', '释然', '轻松', '自在', '从容', '坦然', '幸福', '甜蜜', '温馨', '和睦', '安好'],
    weight: 1.0
  }
};

// 反向映射：word -> category
const WORD_TO_CATEGORY = {};
for (const [cat, data] of Object.entries(EMOTION_CATEGORIES)) {
  for (const word of data.words) {
    WORD_TO_CATEGORY[word] = cat;
  }
}

// ============================================================
// 排除搭配表：含情绪字但非情绪表达的常见复合词
// 在 Trie 中标记 $exclude=true，FMM 匹配后跳过不计数
// ============================================================

const EMOTION_EXCLUDE_COMPOUNDS = [
  // 痛：身体疼痛/非情绪表达
  '头痛', '痛点', '痛风', '痛经',
  // 苦：辛苦/劳苦
  '刻苦', '苦力', '苦水', '苦心', '苦工', '苦于',
  // 伤：伤害/伤口
  '伤亡', '伤口', '伤害', '伤势', '伤员', '伤身',
  // 怕：哪怕/怕生
  '哪怕', '怕生',
  // 酸：身体酸软（非情绪）
  '酸软', '酸痛',
  // 暖：暖和/暖流（非情绪表达）
  '暖和', '暖流',
];

// ============================================================
// Trie 树 + 正向最大匹配（FMM）
// 解决 indexOf 子串匹配导致的重复计数与误匹配
// ============================================================

/**
 * 从 EMOTION_CATEGORIES 构建情绪词 Trie 树
 * 同时插入排除搭配词（标记 $exclude=true）
 * 排除词不覆盖已存在的情绪词
 * @returns {Object} Trie 根节点
 */
function buildEmotionTrie() {
  const trie = {};
  // 插入情绪词
  for (const [category, data] of Object.entries(EMOTION_CATEGORIES)) {
    for (const word of data.words) {
      let node = trie;
      for (const char of word) {
        if (!node[char]) node[char] = {};
        node = node[char];
      }
      node.$word = word;
      node.$category = category;
      node.$exclude = false;
    }
  }
  // 插入排除搭配词（不覆盖已存在的情绪词）
  for (const word of EMOTION_EXCLUDE_COMPOUNDS) {
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
  return trie;
}

/**
 * 正向最大匹配（FMM）提取情绪词
 * 从每个位置尝试最长匹配，匹配成功后跳过已匹配字符
 * 排除词（$exclude=true）跳过不计数但消耗字符
 * @param {string} text - 待扫描文本
 * @param {Object} trie - buildEmotionTrie 返回的 Trie 根节点
 * @returns {Array<{word: string, category: string, position: number}>}
 */
function extractEmotionWordsFMM(text, trie) {
  const results = [];
  let i = 0;
  while (i < text.length) {
    // 从位置 i 开始，尝试最长匹配
    let node = trie;
    let bestMatch = null;   // { word, category, exclude, length }
    let depth = 0;
    for (let j = i; j < text.length; j++) {
      const char = text[j];
      if (!node[char]) break;
      node = node[char];
      depth++;
      if (node.$word) {
        bestMatch = {
          word: node.$word,
          category: node.$category,
          exclude: node.$exclude === true,
          length: depth,
        };
      }
    }
    if (bestMatch) {
      if (!bestMatch.exclude) {
        results.push({
          word: bestMatch.word,
          category: bestMatch.category,
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
const EMOTION_TRIE = buildEmotionTrie();

// ============================================================
// 情绪密度阈值
// ============================================================

const DENSITY_LOW = 3.0;    // 每千字 <3个情绪词 = 情绪平淡
const DENSITY_HIGH = 15.0;  // 每千字 >15个情绪词 = 情绪泛滥
const DENSITY_OPTIMAL_MIN = 5.0;
const DENSITY_OPTIMAL_MAX = 12.0;

const VARIETY_MIN = 3;      // 至少3种情绪类别
const MONOTONY_WARN = 5;    // 同一情绪词出现≥5次 = advisory
const MONOTONY_BLOCK = 8;   // 同一情绪词出现≥8次 = blocking

// ============================================================
// 核心检测函数
// ============================================================

function analyzeEmotion(text, anchor) {
  const results = {
    total_chars: 0,
    total_emotion_words: 0,
    density_per_1000: 0,
    categories_found: {},
    word_frequency: {},
    curve: { beginning: {}, middle: {}, end: {} },
    anchor_delivered: false,
    anchor_count: 0,
    findings: []
  };

  // 清理文本（去除markdown标记）
  const cleanText = text.replace(/```[\s\S]*?```/g, '').replace(/#{1,6}\s/g, '').replace(/\*\*/g, '');
  results.total_chars = cleanText.replace(/\s/g, '').length;

  if (results.total_chars < 100) {
    results.findings.push({
      type: 'too-short',
      severity: 'advisory',
      message: `文本过短（${results.total_chars}字），无法有效分析情绪密度`
    });
    return results;
  }

  // 分三段
  const third = Math.floor(cleanText.length / 3);
  const segments = [
    { name: 'beginning', text: cleanText.substring(0, third) },
    { name: 'middle', text: cleanText.substring(third, third * 2) },
    { name: 'end', text: cleanText.substring(third * 2) }
  ];

  // 扫描全文情绪词（Trie + FMM，避免子串重复匹配与误匹配）
  const allEmotionWords = extractEmotionWordsFMM(cleanText, EMOTION_TRIE);

  for (const ew of allEmotionWords) {
    results.word_frequency[ew.word] = (results.word_frequency[ew.word] || 0) + 1;
  }

  results.total_emotion_words = allEmotionWords.length;
  results.density_per_1000 = (results.total_emotion_words / results.total_chars) * 1000;

  // 分类统计
  for (const ew of allEmotionWords) {
    results.categories_found[ew.category] = (results.categories_found[ew.category] || 0) + 1;
  }

  // 曲线分析（FMM 分段提取，与全文扫描一致）
  for (const seg of segments) {
    const segWords = extractEmotionWordsFMM(seg.text, EMOTION_TRIE);
    for (const ew of segWords) {
      results.curve[seg.name][ew.category] = (results.curve[seg.name][ew.category] || 0) + 1;
    }
  }

  // 锚点交付检查
  if (anchor) {
    const anchorCategory = WORD_TO_CATEGORY[anchor];
    if (anchorCategory) {
      results.anchor_count = results.categories_found[anchorCategory] || 0;
      results.anchor_delivered = results.anchor_count >= 2;
    } else {
      // 直接搜索锚点词
      let idx = 0;
      while ((idx = cleanText.indexOf(anchor, idx)) !== -1) {
        results.anchor_count++;
        idx += anchor.length;
      }
      results.anchor_delivered = results.anchor_count >= 1;
    }
  }

  // ============================================================
  // 生成 Findings
  // ============================================================

  // 1. 情绪密度
  if (results.density_per_1000 < DENSITY_LOW) {
    results.findings.push({
      type: 'emotion-density',
      severity: 'advisory',
      message: `情绪密度过低：${results.density_per_1000.toFixed(1)}/千字（建议${DENSITY_OPTIMAL_MIN}-${DENSITY_OPTIMAL_MAX}/千字），全章情绪平淡`,
      data: { density: results.density_per_1000, total_words: results.total_emotion_words }
    });
  } else if (results.density_per_1000 > DENSITY_HIGH) {
    results.findings.push({
      type: 'emotion-density',
      severity: 'blocking',
      message: `情绪密度过高：${results.density_per_1000.toFixed(1)}/千字（建议≤${DENSITY_HIGH}/千字），情绪词泛滥，缺乏留白`,
      data: { density: results.density_per_1000, total_words: results.total_emotion_words }
    });
  }

  // 2. 情绪多样性
  const categoryCount = Object.keys(results.categories_found).length;
  if (categoryCount < VARIETY_MIN) {
    results.findings.push({
      type: 'emotion-variety',
      severity: 'advisory',
      message: `情绪多样性不足：仅出现${categoryCount}种情绪类别（${Object.keys(results.categories_found).join('、')}），建议至少${VARIETY_MIN}种`,
      data: { categories: Object.keys(results.categories_found), count: categoryCount }
    });
  }

  // 3. 情绪单调（同一词重复）
  for (const [word, count] of Object.entries(results.word_frequency)) {
    if (count >= MONOTONY_BLOCK) {
      results.findings.push({
        type: 'emotion-monotony',
        severity: 'blocking',
        message: `情绪词"${word}"重复${count}次（≥${MONOTONY_BLOCK}次=blocking），情绪表达单调`,
        data: { word, count }
      });
    } else if (count >= MONOTONY_WARN) {
      results.findings.push({
        type: 'emotion-monotony',
        severity: 'advisory',
        message: `情绪词"${word}"重复${count}次（≥${MONOTONY_WARN}次=advisory），建议替换部分为身体反应/动作外化`,
        data: { word, count }
      });
    }
  }

  // 4. 情绪曲线
  const begCats = Object.keys(results.curve.beginning);
  const midCats = Object.keys(results.curve.middle);
  const endCats = Object.keys(results.curve.end);

  if (begCats.length > 0 && midCats.length > 0 && endCats.length > 0) {
    // 检查三段是否完全相同的情绪组合
    const begSet = begCats.sort().join(',');
    const midSet = midCats.sort().join(',');
    const endSet = endCats.sort().join(',');
    if (begSet === midSet && midSet === endSet) {
      results.findings.push({
        type: 'emotion-curve',
        severity: 'advisory',
        message: `情绪曲线平坦：前/中/后三段情绪类别完全一致（${begSet}），缺乏情绪变化`,
        data: { beginning: begCats, middle: midCats, end: endCats }
      });
    }
  } else if (begCats.length === 0 || endCats.length === 0) {
    results.findings.push({
      type: 'emotion-curve',
      severity: 'advisory',
      message: `情绪曲线不完整：开头或结尾段缺乏情绪词，可能首尾情绪缺失`,
      data: { beginning: begCats, middle: midCats, end: endCats }
    });
  }

  // 5. 锚点交付
  if (anchor) {
    if (!results.anchor_delivered) {
      results.findings.push({
        type: 'anchor-delivery',
        severity: 'blocking',
        message: `用户情绪锚点"${anchor}"未在正文中体现（出现${results.anchor_count}次），03a扩写未交付用户期望的情绪体验`,
        data: { anchor, count: results.anchor_count }
      });
    } else {
      results.findings.push({
        type: 'anchor-delivery',
        severity: 'info',
        message: `用户情绪锚点"${anchor}"已交付（出现${results.anchor_count}次）`,
        data: { anchor, count: results.anchor_count }
      });
    }
  }

  return results;
}

// ============================================================
// 文件处理
// ============================================================

function processFile(filePath, anchor) {
  const text = fs.readFileSync(filePath, 'utf-8');
  return analyzeEmotion(text, anchor);
}

function formatReport(filePath, result) {
  const lines = [];
  lines.push(`\n📊 情绪密度检测报告：${path.basename(filePath)}`);
  lines.push(`${'─'.repeat(50)}`);
  lines.push(`总字数：${result.total_chars}`);
  lines.push(`情绪词总数：${result.total_emotion_words}`);
  lines.push(`情绪密度：${result.density_per_1000.toFixed(1)}/千字`);
  lines.push(`情绪类别：${Object.keys(result.categories_found).join('、') || '（无）'}（${Object.keys(result.categories_found).length}种）`);
  lines.push('');

  // 情绪曲线
  lines.push('情绪曲线：');
  lines.push(`  开头：${Object.entries(result.curve.beginning).map(([k, v]) => `${k}×${v}`).join(' ') || '（无）'}`);
  lines.push(`  中段：${Object.entries(result.curve.middle).map(([k, v]) => `${k}×${v}`).join(' ') || '（无）'}`);
  lines.push(`  结尾：${Object.entries(result.curve.end).map(([k, v]) => `${k}×${v}`).join(' ') || '（无）'}`);
  lines.push('');

  // 高频情绪词
  const topWords = Object.entries(result.word_frequency).sort((a, b) => b[1] - a[1]).slice(0, 5);
  if (topWords.length > 0) {
    lines.push(`高频情绪词：${topWords.map(([w, c]) => `${w}(${c})`).join(' ')}`);
  }
  lines.push('');

  // Findings
  if (result.findings.length === 0) {
    lines.push('✅ 未发现问题');
  } else {
    const blocking = result.findings.filter(f => f.severity === 'blocking');
    const advisory = result.findings.filter(f => f.severity === 'advisory');
    const info = result.findings.filter(f => f.severity === 'info');

    if (blocking.length > 0) {
      lines.push(`❌ Blocking（${blocking.length}项）：`);
      blocking.forEach(f => lines.push(`  • [${f.type}] ${f.message}`));
    }
    if (advisory.length > 0) {
      lines.push(`⚠️ Advisory（${advisory.length}项）：`);
      advisory.forEach(f => lines.push(`  • [${f.type}] ${f.message}`));
    }
    if (info.length > 0) {
      lines.push(`ℹ️ Info（${info.length}项）：`);
      info.forEach(f => lines.push(`  • [${f.type}] ${f.message}`));
    }
  }
  lines.push(`${'─'.repeat(50)}`);

  return lines.join('\n');
}

// ============================================================
// 主入口
// ============================================================

function main() {
  const args = process.argv.slice(2);
  let anchor = null;
  let jsonOutput = false;
  const files = [];

  for (const arg of args) {
    if (arg === '--json') {
      jsonOutput = true;
    } else if (arg.startsWith('--anchor=')) {
      anchor = arg.substring('--anchor='.length);
    } else if (arg === '--help' || arg === '-h') {
      console.log(USAGE);
      process.exit(0);
    } else if (!arg.startsWith('--')) {
      files.push(arg);
    }
  }

  if (files.length === 0) {
    console.error(USAGE);
    process.exit(1);
  }

  const allResults = {};
  let hasBlocking = false;

  for (const file of files) {
    if (!fs.existsSync(file)) {
      console.error(`文件不存在：${file}`);
      continue;
    }

    const result = processFile(file, anchor);
    allResults[path.basename(file)] = result;

    if (!jsonOutput) {
      console.log(formatReport(file, result));
    }

    if (result.findings.some(f => f.severity === 'blocking')) {
      hasBlocking = true;
    }
  }

  if (jsonOutput) {
    console.log(JSON.stringify(allResults, null, 2));
  }

  // 汇总
  if (files.length > 1 && !jsonOutput) {
    console.log('\n📊 汇总：');
    for (const [name, result] of Object.entries(allResults)) {
      const blocking = result.findings.filter(f => f.severity === 'blocking').length;
      const advisory = result.findings.filter(f => f.severity === 'advisory').length;
      console.log(`  ${name}：${blocking} blocking / ${advisory} advisory / 密度${result.density_per_1000.toFixed(1)}/千字`);
    }
  }

  process.exit(hasBlocking ? 1 : 0);
}

main();

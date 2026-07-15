#!/usr/bin/env node
'use strict';

/**
 * check-consistency.js — 数值与战力一致性确定性检测
 *
 * V2.0 题材无关化重构 + 正则增强：
 *   - 配置驱动：从 metadata.json 的 novel_meta.genre 读取题材类型，动态选择检测模式。
 *     不再硬编码"凡骨/硬骨"等特定小说的设定，支持玄幻/都市/言情/悬疑/科幻/历史等题材。
 *   - 中文数字支持：新增 parseChineseNumber，可解析"二十三"→23、"十五"→15、"一百"→100 等。
 *   - 模糊数值模式增强：支持"年近X""约X里""半日路""数月"等模糊表达的提取。
 *   - 语义校验：对提取的数值做合理性判断，超过 warning 阈值标记为可疑，超过 max 标记为异常。
 *   - tier 正则动态生成：从 power_system.tiers 读取等级名，不再硬编码骨骼类型。
 *
 * 检测类别（按题材动态启用）：
 *   - age          年龄矛盾：正文中的"X岁"与 number_anchors.character_numbers 不一致
 *   - distance     距离矛盾：正文中的"X里"与 number_anchors.distances 不一致
 *   - cultivation  修炼枚数矛盾：正文中的"X枚"与 number_anchors.character_numbers 不一致
 *   - tier         战力越界：角色战斗表现/境界名超出 power_system 矩阵
 *   - dead         生死矛盾：已死亡角色在当前时间线以活人状态出现
 *   - timeline     时间线矛盾：正文时间表达与 number_anchors.timeline 不一致
 *   - evidence     证据链矛盾（悬疑）：证据出现顺序/关联异常
 *   - relationship 关系矛盾（言情）：关系状态与设定冲突
 *   - tech         科技等级矛盾（科幻）：科技水平超出设定
 *
 * 用法：node check-consistency.js [--json] <prose-file> [--meta=<metadata.json>] [--genre=<题材>]
 * 兼容旧用法：node check-consistency.js [--json] <prose-file> [--meta=<metadata.json>]
 * 只报告不修改。
 */

const fs = require('fs');
const path = require('path');

const USAGE = `Usage: node check-consistency.js [--json] <prose-file> [--meta=<metadata.json>] [--genre=<题材>]

Scan prose for numeric consistency against novel metadata.
Genre-driven check selection (auto-detected from metadata.novel_meta.genre, or override with --genre).
Report-only. Never rewrites text.`;

// ════════════════════════════════════════════════════════════
//  题材→检测模式映射（配置驱动核心）
// ════════════════════════════════════════════════════════════

/**
 * 题材别名归一化表：将"修仙""武侠"等归一到主题材键
 * 用于兼容用户在 metadata 中填写的各种题材表述
 */
const GENRE_ALIASES = {
  '玄幻': '玄幻', '修仙': '玄幻', '修真': '玄幻', '武侠': '玄幻', '仙侠': '玄幻',
  '都市': '都市', '现实': '都市', '现代': '都市', '都市异能': '都市',
  '言情': '言情', '情感': '言情', '恋爱': '言情', '甜宠': '言情',
  '悬疑': '悬疑', '推理': '悬疑', '探案': '悬疑', '犯罪': '悬疑',
  '科幻': '科幻', '末世': '科幻', '星际': '科幻',
  '历史': '历史', '架空': '历史', '架空历史': '历史',
};

/**
 * 各题材启用的检测类别
 * 与 00_小说设定架构师.md 的"题材模块选择器"表格保持一致
 */
const GENRE_CHECKS = {
  '玄幻': ['cultivation', 'tier', 'age', 'distance', 'dead'],
  '都市': ['age', 'distance', 'timeline', 'dead'],
  '悬疑': ['timeline', 'evidence', 'age'],
  '言情': ['age', 'timeline', 'relationship'],
  '科幻': ['tech', 'age', 'distance', 'timeline', 'dead'],
  '历史': ['age', 'distance', 'timeline', 'dead'],
};

/**
 * 根据题材字符串归一化并返回启用的检测类别
 * @param {string} genreRaw - 原始题材字符串
 * @returns {string[]} - 启用的检测类别列表
 */
function getGenreChecks(genreRaw) {
  const normalized = GENRE_ALIASES[genreRaw] || '玄幻'; // 默认玄幻（向后兼容）
  return GENRE_CHECKS[normalized] || GENRE_CHECKS['玄幻'];
}

// ════════════════════════════════════════════════════════════
//  中文数字解析
// ════════════════════════════════════════════════════════════

/**
 * 中文数字→阿拉伯数字映射表
 * 支持个位、十、百、千、万、半
 */
const CHINESE_NUMS = {
  '一': 1, '二': 2, '两': 2, '三': 3, '四': 4, '五': 5,
  '六': 6, '七': 7, '八': 8, '九': 9, '十': 10, '百': 100,
  '千': 1000, '万': 10000, '半': 0.5,
};

/**
 * 解析中文数字字符串为数值
 * 支持："二十三"→23、"十五"→15、"一百"→100、"一百二十三"→123
 * 也兼容纯阿拉伯数字字符串（直接 parseFloat）
 * @param {string} str - 数字字符串（中文或阿拉伯）
 * @returns {number} - 解析后的数值，无法解析返回 NaN
 */
function parseChineseNumber(str) {
  if (str == null || str === '') return NaN;
  // 纯阿拉伯数字直接返回
  if (/^\d+(\.\d+)?$/.test(str)) return parseFloat(str);

  // V3.0.1修复：将"万/亿"作为乘法段分隔符，而非与"十/百/千"同级累加
  // 旧逻辑：万=10000直接加到result，"十万"=10+10000=10010（错误）
  // 新逻辑：万是段分隔符，"十万"=(0+10)*10000=100000（正确）
  const SECTION_UNITS = { '万': 10000, '亿': 100000000 };
  const DIGIT_UNITS = { '十': 10, '百': 100, '千': 1000 };
  const DIGITS = { '一':1,'二':2,'两':2,'三':3,'四':4,'五':5,
                   '六':6,'七':7,'八':8,'九':9,'零':0,'半':0.5 };

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
    }
  }
  sectionValue += tempDigit;
  return totalValue + sectionValue;
}

// ════════════════════════════════════════════════════════════
//  模糊数值模式（正则增强）
// ════════════════════════════════════════════════════════════

/**
 * 模糊数值模式表：覆盖阿拉伯数字 + 中文数字 + 模糊量词表达
 * 每个类别按优先级排列，先匹配精确表达，再匹配模糊表达
 */
const FUZZY_PATTERNS = {
  age: [
    /(\d+)岁/g,                                                      // "19岁" 阿拉伯数字
    /([一二两三四五六七八九十百]+)岁/g,                              // "十九岁" 中文数字
    /快(\d+)了/g,                                                    // "快20了"
    /年近(\d+)/g,                                                    // "年近四十"
    /年过(\d+)/g,                                                    // "年过五十"
    /(十[一二三四五六七八九]|二十[一二三四五六七八九]|[一二两三四五六七八九十]+)岁/g, // 中文年龄补充
  ],
  distance: [
    /([东南西北])(\d+)里/g,                                          // "南3里" 带方向
    /(约|差不多|大概|近|不到)(\d+)里/g,                              // "约5里" 模糊距离
    /([一二两三四五六七八九十百]+)里(?:路|地|程)?/g,                 // "三里路" 中文距离
    /半日(?:路|程)/g,                                                // "半日路"
    /(一天|半天|两小时)(?:路|程|车程)/g,                            // "半天车程"
  ],
  time: [
    /(小)?半年/g,                                                    // "半年""小半年"
    /(\d+)个月后/g,                                                  // "3个月后"
    /([一二两三四五六七八九十]+)个月后/g,                            // "三个月后"
    /过了([一二两三四五六七八九十]+)天/g,                            // "过了五天"
    /数日|数月|数年/g,                                               // "数月" 模糊时间
    /(几天|半个多月|一个多月)/g,                                     // "几天"
  ],
  count: [
    /(\d+)枚/g,                                                      // "2枚"
    /([一二两三四五六七八九十百]+)枚/g,                              // "三枚"
    /(\d+)个/g,                                                      // "3个"
    /([一二两三四五六七八九十百]+)个/g,                              // "三个"
    /(\d+)名/g,                                                      // "5名"
    /([一二两三四五六七八九十百]+)名/g,                              // "五名"
    /(\d+)条/g,                                                      // "2条"
    /([一二两三四五六七八九十百]+)条/g,                              // "两条"
  ],
};

// ════════════════════════════════════════════════════════════
//  语义校验
// ════════════════════════════════════════════════════════════

/**
 * 各类数值的合理性阈值
 * - warning：超过此值标记为"可疑"（advisory）
 * - max：超过此值标记为"异常"（blocking）
 */
const VALUE_LIMITS = {
  age: { min: 0, max: 200, warning: 150 },
  distance_li: { min: 0, max: 10000, warning: 3000 },
  count: { min: 0, max: 100000, warning: 10000 },
};

/**
 * 对提取的数值做语义合理性校验
 * 超过 warning 值标记为可疑（advisory），超过 max 值标记为异常（blocking）
 * @param {string} type - 数值类别（age/distance_li/count）
 * @param {number} value - 数值
 * @param {string} context - 上下文文本
 * @returns {Object|null} - 异常报告对象，无异常返回 null
 */
function validateValue(type, value, context) {
  const limits = VALUE_LIMITS[type];
  if (!limits || isNaN(value)) return null;

  if (value < limits.min) {
    return {
      severity: 'blocking',
      type: `${type}-invalid`,
      message: `${type} 数值异常：${value} 低于最小值 ${limits.min}`,
      location: context.trim().substring(0, 80),
      expected: `≥ ${limits.min}`,
      actual: String(value),
    };
  }
  if (value > limits.max) {
    return {
      severity: 'blocking',
      type: `${type}-overflow`,
      message: `${type} 数值异常：${value} 超过最大值 ${limits.max}，可能是提取错误或设定失误`,
      location: context.trim().substring(0, 80),
      expected: `≤ ${limits.max}`,
      actual: String(value),
    };
  }
  if (value > limits.warning) {
    return {
      severity: 'advisory',
      type: `${type}-suspicious`,
      message: `${type} 数值可疑：${value} 超过预警阈值 ${limits.warning}，请人工确认`,
      location: context.trim().substring(0, 80),
      expected: `≤ ${limits.warning}`,
      actual: String(value),
    };
  }
  return null;
}

// ════════════════════════════════════════════════════════════
//  动态 tier 正则生成
// ════════════════════════════════════════════════════════════

/**
 * 从 metadata.power_system.tiers 动态生成境界/战力等级正则
 * 不再硬编码"凡骨/硬骨"，支持任意力量体系
 * @param {Object} metadata - JSON 元数据
 * @returns {RegExp|null} - 匹配等级名的正则，无数据返回 null
 */
function buildTierRegex(metadata) {
  const tiers = metadata?.power_system?.tiers;
  if (!Array.isArray(tiers) || tiers.length === 0) return null;
  // 收集所有等级名，转义正则特殊字符
  const names = tiers
    .map(t => t.tier_name)
    .filter(n => n)
    .map(n => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  if (names.length === 0) return null;
  return new RegExp('(' + names.join('|') + ')', 'g');
}

// ════════════════════════════════════════════════════════════
//  数值模式提取（增强版）
// ════════════════════════════════════════════════════════════

/**
 * 从正文中提取所有数值出现（支持阿拉伯+中文数字+模糊表达）
 * @param {string} text - 正文文本
 * @param {string[]} enabledChecks - 启用的检测类别
 * @param {Object} metadata - JSON 元数据（用于动态生成 tier 正则）
 * @returns {Array} - 数值出现列表
 */
function extractNumbers(text, enabledChecks, metadata) {
  const findings = [];
  const ctx = (idx, raw) => text.substring(Math.max(0, idx - 50), idx + raw.length + 50);
  // 去重集合：避免同一 type+index 被多个模式重复记录
  const seen = new Set();

  // ── 年龄提取（fuzzy patterns + 中文数字） ──
  if (enabledChecks.includes('age')) {
    for (const re of FUZZY_PATTERNS.age) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(text)) !== null) {
        const key = 'age:' + m.index;
        if (seen.has(key)) continue;
        seen.add(key);
        // 提取数字部分：可能是阿拉伯或中文
        const numStr = m[1] || m[2] || '';
        const value = parseChineseNumber(numStr);
        if (isNaN(value)) continue;
        findings.push({
          type: 'age',
          value: value,
          raw: m[0],
          index: m.index,
          context: ctx(m.index, m[0]),
        });
      }
    }
  }

  // ── 距离提取（方向+阿拉伯+中文+模糊量词） ──
  if (enabledChecks.includes('distance')) {
    for (const re of FUZZY_PATTERNS.distance) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(text)) !== null) {
        const key = 'distance:' + m.index;
        if (seen.has(key)) continue;
        seen.add(key);
        let dir = null;
        let value = null;
        // 判断方向（仅 pattern 1 的 m[1] 是方向字）
        if (m[1] && /[东南西北]/.test(m[1])) {
          dir = m[1];
          value = m[2] ? parseChineseNumber(m[2]) : null;
        } else if (m[2]) {
          // pattern 2: m[1]=前缀词(约/差不多…), m[2]=数字
          value = parseChineseNumber(m[2]);
        } else if (m[1]) {
          // pattern 3: m[1]=中文数字
          value = parseChineseNumber(m[1]);
        }
        // patterns 4,5: 模糊时间距离，value 保持 null
        findings.push({
          type: 'distance',
          direction: dir,
          value: value,
          raw: m[0],
          index: m.index,
          context: ctx(m.index, m[0]),
        });
      }
    }
  }

  // ── 修炼枚数提取（阿拉伯+中文） ──
  if (enabledChecks.includes('cultivation')) {
    for (const re of [/(\d+)枚/g, /([一二两三四五六七八九十百]+)枚/g]) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(text)) !== null) {
        const key = 'cultivation:' + m.index;
        if (seen.has(key)) continue;
        seen.add(key);
        const value = parseChineseNumber(m[1]);
        if (isNaN(value)) continue;
        findings.push({
          type: 'cultivation',
          value: value,
          raw: m[0],
          index: m.index,
          context: ctx(m.index, m[0]),
        });
      }
    }
  }

  // ── tier/境界提取（动态正则，从 power_system.tiers 生成） ──
  if (enabledChecks.includes('tier')) {
    const tierRe = buildTierRegex(metadata);
    if (tierRe) {
      tierRe.lastIndex = 0;
      let m;
      while ((m = tierRe.exec(text)) !== null) {
        const key = 'tier:' + m.index;
        if (seen.has(key)) continue;
        seen.add(key);
        findings.push({
          type: 'tier',
          value: m[1],
          raw: m[0],
          index: m.index,
          context: ctx(m.index, m[0]),
        });
      }
    }
  }

  // ── 数量提取（个/名/条，全题材通用，用于语义校验） ──
  // count 检测复用于多个题材，始终提取以做数值合理性校验
  for (const re of FUZZY_PATTERNS.count) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      const key = 'count:' + m.index;
      if (seen.has(key)) continue;
      seen.add(key);
      const numStr = m[1] || '';
      const value = parseChineseNumber(numStr);
      if (isNaN(value)) continue;
      findings.push({
        type: 'count',
        value: value,
        raw: m[0],
        index: m.index,
        context: ctx(m.index, m[0]),
      });
    }
  }

  return findings;
}

// ════════════════════════════════════════════════════════════
//  角色名精确匹配 + 别名支持
// ════════════════════════════════════════════════════════════

/**
 * 构建角色名全列表（含别名）
 * 从 metadata.number_anchors.character_numbers 中提取所有角色名及其别名，
 * 用于精确匹配时排除"张三"误匹配"张三丰"的子串问题。
 * @param {Object} chars - character_numbers 对象
 * @returns {string[]} - 所有可能的角色名/别名称列表
 */
function buildNameList(chars) {
  const names = [];
  for (const [charName, charData] of Object.entries(chars)) {
    names.push(charName);
    if (Array.isArray(charData.aliases)) {
      names.push(...charData.aliases);
    }
  }
  // 按长度降序排列：长名优先匹配，避免短名（张三）误匹配长名（张三丰）的子串
  names.sort((a, b) => b.length - a.length);
  return names;
}

/**
 * 精确匹配角色名：检查 name 是否在 text 中作为独立角色名出现（非更长名字的子串）
 * 例如："张三" 不应匹配 "张三丰" 中的子串
 * @param {string} text - 待搜索文本
 * @param {string} name - 角色名或别名
 * @param {string[]} allNames - 所有可能的角色名列表（含别名）
 * @returns {boolean} - 是否存在精确匹配（独立出现，非更长名的子串）
 */
function findExactNameMatch(text, name, allNames) {
  let idx = 0;
  while ((idx = text.indexOf(name, idx)) !== -1) {
    // 检查此匹配是否为更长角色名的一部分
    let isPartOfLonger = false;
    for (const otherName of allNames) {
      if (otherName === name || otherName.length <= name.length) continue;
      // 如果 otherName 以 name 开头，且文本在此位置匹配完整的 otherName
      if (otherName.startsWith(name) && text.substring(idx, idx + otherName.length) === otherName) {
        isPartOfLonger = true;
        break;
      }
    }
    if (!isPartOfLonger) return true;
    idx += name.length;
  }
  return false;
}

/**
 * 根据匹配到的名称（可能是别名）查找对应角色数据
 * @param {Object} chars - character_numbers 对象
 * @param {string} name - 匹配到的名称（角色名或别名）
 * @returns {{name: string, data: Object}|null} - 角色主名和数据，未找到返回 null
 */
function findCharDataByName(chars, name) {
  for (const [charName, charData] of Object.entries(chars)) {
    if (charName === name) return { name: charName, data: charData };
    if (Array.isArray(charData.aliases) && charData.aliases.includes(name)) {
      return { name: charName, data: charData };
    }
  }
  return null;
}

// ════════════════════════════════════════════════════════════
//  对照元数据检测矛盾
// ════════════════════════════════════════════════════════════

/**
 * 对照元数据检测矛盾（含语义校验）
 * @param {Array} findings - 正文数值列表
 * @param {Object} metadata - JSON元数据
 * @param {string[]} enabledChecks - 启用的检测类别
 * @returns {Array} - 矛盾报告
 */
function checkConsistency(findings, metadata, enabledChecks) {
  const issues = [];

  if (!metadata) {
    return [{ severity: 'warn', message: '未提供元数据文件，跳过一致性检测（仅做语义校验）' }];
  }

  const anchors = metadata.number_anchors || {};
  const chars = anchors.character_numbers || {};
  const allNames = buildNameList(chars); // 角色名+别名列表（按长度降序），用于精确匹配

  // ── 语义校验：对所有提取的数值做合理性判断 ──
  for (const f of findings) {
    let validateType = null;
    if (f.type === 'age') validateType = 'age';
    else if (f.type === 'distance' && f.value != null) validateType = 'distance_li';
    else if (f.type === 'count') validateType = 'count';

    if (validateType) {
      const v = validateValue(validateType, f.value, f.context);
      if (v) issues.push(v);
    }
  }

  // ── 检测年龄矛盾 ──
  if (enabledChecks.includes('age')) {
    const ageFindings = findings.filter(f => f.type === 'age');
    for (const f of ageFindings) {
      // 尝试匹配角色名（精确匹配，支持别名）
      const contextBefore = f.context.substring(0, f.context.indexOf(f.raw));
      const matchedChars = new Set(); // 避免同一角色通过不同别名重复报告
      for (const name of allNames) {
        if (!findExactNameMatch(contextBefore, name, allNames)) continue;
        const charMatch = findCharDataByName(chars, name);
        if (!charMatch || !charMatch.data.age) continue;
        if (matchedChars.has(charMatch.name)) continue; // 已通过其他别名匹配过
        matchedChars.add(charMatch.name);
        const charName = charMatch.name;
        const charData = charMatch.data;
        // 元数据中的年龄也可能是中文数字，统一用 parseChineseNumber 解析
        const expectedAge = parseChineseNumber(
          String(charData.age).match(/[\d一二两三四五六七八九十百]+/)?.[0] || '0'
        );
        if (expectedAge > 0 && f.value !== expectedAge) {
          issues.push({
            severity: 'blocking',
            type: 'age-mismatch',
            message: `${charName}的年龄矛盾：正文写"${f.value}岁"，number_anchors标注为"${charData.age}岁"`,
            location: f.context.trim(),
            expected: String(charData.age),
            actual: f.raw,
          });
        }
      }
    }
  }

  // ── 检测距离矛盾 ──
  if (enabledChecks.includes('distance')) {
    const distFindings = findings.filter(f => f.type === 'distance' && f.value != null);
    const distances = anchors.distances || {};
    for (const f of distFindings) {
      for (const [route, expectedDist] of Object.entries(distances)) {
        // 简单匹配：如果距离值不同，标记为可疑
        const expectedNum = parseChineseNumber(
          String(expectedDist).match(/[\d一二两三四五六七八九十百]+/)?.[0] || '0'
        );
        if (expectedNum > 0 && f.value !== expectedNum) {
          // 仅在方向也匹配时报告
          const expectedDir = String(expectedDist).match(/[东南西北]/)?.[0];
          if (!expectedDir || expectedDir === f.direction) {
            issues.push({
              severity: 'advisory',
              type: 'distance-mismatch',
              message: `距离可能矛盾：正文写"${f.raw}"，number_anchors中"${route}"="${expectedDist}"`,
              location: f.context.trim(),
              expected: String(expectedDist),
              actual: f.raw,
            });
          }
        }
      }
    }
  }

  // ── 检测修炼枚数矛盾 ──
  if (enabledChecks.includes('cultivation')) {
    const cultFindings = findings.filter(f => f.type === 'cultivation');
    for (const f of cultFindings) {
      const contextBefore = f.context.substring(0, f.context.indexOf(f.raw));
      const matchedChars = new Set(); // 避免同一角色通过不同别名重复报告
      for (const name of allNames) {
        if (!findExactNameMatch(contextBefore, name, allNames)) continue;
        const charMatch = findCharDataByName(chars, name);
        if (!charMatch || !charMatch.data.cultivation_level) continue;
        if (matchedChars.has(charMatch.name)) continue; // 已通过其他别名匹配过
        matchedChars.add(charMatch.name);
        const charName = charMatch.name;
        const charData = charMatch.data;
        const expectedNum = parseChineseNumber(
          String(charData.cultivation_level).match(/[\d一二两三四五六七八九十百]+/)?.[0] || '0'
        );
        if (expectedNum > 0 && f.value !== expectedNum) {
          issues.push({
            severity: 'blocking',
            type: 'cultivation-mismatch',
            message: `${charName}的修炼枚数矛盾：正文写"${f.value}枚"，number_anchors标注为"${charData.cultivation_level}"`,
            location: f.context.trim(),
            expected: charData.cultivation_level,
            actual: f.raw,
          });
        }
      }
    }
  }

  // ── 检测战力越界（tier 出现但不在 power_system.tiers 中） ──
  if (enabledChecks.includes('tier')) {
    const tierNames = (metadata?.power_system?.tiers || [])
      .map(t => t.tier_name)
      .filter(Boolean);
    if (tierNames.length > 0) {
      const tierFindings = findings.filter(f => f.type === 'tier');
      for (const f of tierFindings) {
        // tier 正则已限定为已知等级名，此处做 ability_ceiling 提示
        // 检查上下文是否暗示越级战斗表现
        if (/独自|单挑|一人|凭一己之力/.test(f.context) && /斩杀|击杀|秒杀|碾压/.test(f.context)) {
          const tierData = tierNames.includes(f.value) ? f.value : null;
          if (tierData) {
            issues.push({
              severity: 'advisory',
              type: 'power-overflow',
              message: `战力表现可疑：正文出现"${f.value}"等级的越级战斗描写，请对照 power_system.ability_ceiling 确认是否越界`,
              location: f.context.trim(),
              expected: '不超出当前等级 ability_ceiling',
              actual: f.raw,
            });
          }
        }
      }
    }
  }

  return issues;
}

/**
 * 检测已死亡角色在正文中以活人状态出现
 * 仅在 enabledChecks 包含 'dead' 时执行
 * @param {string} text - 正文全文
 * @param {Object} metadata - JSON元数据
 * @param {string[]} enabledChecks - 启用的检测类别
 * @returns {Array} - 矛盾报告
 */
function checkDeadCharacters(text, metadata, enabledChecks) {
  const issues = [];
  // 题材不含 dead 检测时跳过
  if (!enabledChecks.includes('dead')) return issues;
  if (!metadata?.number_anchors?.character_numbers) return issues;

  const chars = metadata.number_anchors.character_numbers;
  const allNames = buildNameList(chars); // 角色名+别名列表，用于精确匹配排除子串

  for (const [charName, charData] of Object.entries(chars)) {
    if (charData.status !== '已死亡') continue;

    // 收集该角色的所有名称（主名 + 别名），逐一搜索
    const namesToSearch = [charName];
    if (Array.isArray(charData.aliases)) {
      namesToSearch.push(...charData.aliases);
    }

    for (const name of namesToSearch) {
      // 精确匹配：逐个查找 name 出现位置，排除是更长角色名子串的情况
      let idx = 0;
      while ((idx = text.indexOf(name, idx)) !== -1) {
        let isPartOfLonger = false;
        for (const otherName of allNames) {
          if (otherName === name || otherName.length <= name.length) continue;
          if (otherName.startsWith(name) && text.substring(idx, idx + otherName.length) === otherName) {
            isPartOfLonger = true;
            break;
          }
        }

        if (!isPartOfLonger) {
          // 获取上下文（前后100字）
          const start = Math.max(0, idx - 100);
          const end = Math.min(text.length, idx + name.length + 100);
          const context = text.substring(start, end);

          // 检查是否在闪回标记内
          const isFlashback = /那一年|他想起|回忆|记忆中|多年前|曾经|梦中|幻觉/.test(context);

          if (!isFlashback) {
            issues.push({
              severity: 'blocking',
              type: 'dead-character-alive',
              message: `已死亡角色"${charName}"（${charData.death_time || '未知时间'}死亡）可能以活人状态出现，且上下文无闪回标记`,
              location: context.trim().substring(0, 80) + '...',
              character: charName,
              expected: '已死亡，仅可在闪回/回忆中出现',
              actual: '活人状态出现',
              death_info: charData.death_time + ' ' + (charData.death_cause || ''),
            });
          }
        }
        idx += name.length;
      }
    }
  }

  return issues;
}

// ════════════════════════════════════════════════════════════
//  主函数
// ════════════════════════════════════════════════════════════

function main() {
  const args = process.argv.slice(2);

  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    console.log(USAGE);
    process.exit(0);
  }

  const jsonMode = args.includes('--json');
  const files = args.filter(a => !a.startsWith('--'));

  if (files.length === 0) {
    console.error('Error: no prose file specified');
    process.exit(1);
  }

  // 查找元数据文件
  const metaArg = args.find(a => a.startsWith('--meta='));
  let metadata = null;
  if (metaArg) {
    const metaPath = metaArg.replace('--meta=', '');
    try {
      metadata = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    } catch (e) {
      console.error(`Warning: could not read metadata file ${metaPath}: ${e.message}`);
    }
  }

  // ── 题材检测（配置驱动核心） ──
  // 优先级：--genre 命令行参数 > metadata.novel_meta.genre > 默认"玄幻"
  const genreArg = args.find(a => a.startsWith('--genre='));
  const genreRaw = genreArg
    ? genreArg.replace('--genre=', '')
    : (metadata?.novel_meta?.genre || '玄幻');
  const enabledChecks = getGenreChecks(genreRaw);
  const normalizedGenre = GENRE_ALIASES[genreRaw] || '玄幻';

  const allIssues = [];

  for (const file of files) {
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch (e) {
      console.error(`Error reading ${file}: ${e.message}`);
      continue;
    }

    // 提取数值（按题材动态选择检测类别）
    const findings = extractNumbers(text, enabledChecks, metadata);
    findings.forEach(f => f._fullText = text);

    // 检测矛盾（含语义校验）
    const issues = checkConsistency(findings, metadata, enabledChecks);
    const deadIssues = checkDeadCharacters(text, metadata, enabledChecks);

    allIssues.push(...issues, ...deadIssues);
  }

  // 输出报告
  if (jsonMode) {
    console.log(JSON.stringify({
      total_issues: allIssues.length,
      blocking: allIssues.filter(i => i.severity === 'blocking').length,
      advisory: allIssues.filter(i => i.severity === 'advisory').length,
      genre: normalizedGenre,
      enabled_checks: enabledChecks,
      issues: allIssues,
    }, null, 2));
  } else {
    // 报告头部：显示题材与启用的检测模式
    console.log(`[check-consistency] 题材: ${normalizedGenre} | 启用检测: ${enabledChecks.join(', ')}\n`);
    if (allIssues.length === 0) {
      console.log('✓ No consistency issues found.');
    } else {
      console.log(`Found ${allIssues.length} issue(s):\n`);
      allIssues.forEach((issue, i) => {
        const icon = issue.severity === 'blocking' ? '❌' : (issue.severity === 'advisory' ? '⚠️' : 'ℹ️');
        console.log(`${i + 1}. ${icon} [${issue.type}] ${issue.message}`);
        if (issue.location) console.log(`   Context: ${issue.location}`);
        if (issue.expected) console.log(`   Expected: ${issue.expected} | Actual: ${issue.actual}`);
        console.log('');
      });
    }
  }

  // 退出码：有 blocking 问题返回 1
  const hasBlocking = allIssues.some(i => i.severity === 'blocking');
  process.exit(hasBlocking ? 1 : 0);
}

main();

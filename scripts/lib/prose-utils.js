'use strict';

/**
 * prose-utils.js — 散文检测脚本共享工具函数库
 *
 * 从 check-ai-patterns.js / check-degeneration.js / check-rhythm.js /
 * normalize-punctuation.js 中提取的公共函数，消除重复定义。
 *
 * 用法：
 *   const { stripQuoted, visibleLength, isDivider, isStructural,
 *           hasYamlFrontMatter, splitSentences, parseFenceMarker } = require('./lib/prose-utils.js');
 *
 * 注意：require 路径相对于调用脚本所在目录（scripts/），因此 './lib/prose-utils.js'
 * 解析为 scripts/lib/prose-utils.js。
 */

// ──────────────────────────────────────────────────────────
//  对话引用去除
// ──────────────────────────────────────────────────────────

/**
 * 去除文本中的对话引用内容（引号/书名号内的内容）
 * 支持中文引号（""''）、日文引号（「」『』）、书名号（【】）、英文引号（"'）
 * @param {string} t - 原始文本
 * @returns {string} - 去除对话后的纯叙述文本
 */
function stripQuoted(t) {
  return t
    .replace(/「[^」]*」/g, '')
    .replace(/『[^』]*』/g, '')
    .replace(/【[^】]*】/g, '')
    .replace(/"[^"]*"/g, '')
    .replace(/'[^']*'/g, '')
    .replace(/\u201c[^\u201d]*\u201d/g, '')
    .replace(/\u2018[^\u2019]*\u2019/g, '');
}

// ──────────────────────────────────────────────────────────
//  可见字符长度
// ──────────────────────────────────────────────────────────

/**
 * 计算可见字符长度（中日韩统一表意文字 + 全角字母 + ASCII 字母数字）
 * 不计入标点、空格、换行等不可见字符
 * @param {string} s - 输入字符串
 * @returns {number} - 可见字符数量
 */
function visibleLength(s) {
  const m = s.match(/[\u4e00-\u9fff\uFF21-\uFF5AA-Za-z0-9]/g);
  return m ? m.length : 0;
}

// ──────────────────────────────────────────────────────────
//  结构标记检测
// ──────────────────────────────────────────────────────────

/**
 * 判断文本是否为 markdown 分隔线（--- / *** / ___）
 * @param {string} t - 待检测文本（已 trim）
 * @returns {boolean}
 */
function isDivider(t) {
  return /^-{3,}$/.test(t) || /^[*_]{3,}$/.test(t);
}

/**
 * 判断文本是否为 markdown 结构性标记（标题/引用/列表/表格行）
 * @param {string} t - 待检测文本（已 trim）
 * @returns {boolean}
 */
function isStructural(t) {
  return /^(#{1,6}\s|>\s?|[-*+]\s|\d+[.)]\s|\|)/.test(t);
}

// ──────────────────────────────────────────────────────────
//  YAML 前置标记检测
// ──────────────────────────────────────────────────────────

/**
 * 检测文本行数组是否以 YAML front matter 开头
 * front matter 格式：首行 ---，后续为 key: value，以 --- 闭合
 * @param {string[]} lines - 文本行数组
 * @returns {boolean} - 是否存在有效的 YAML front matter
 */
function hasYamlFrontMatter(lines) {
  if (!lines[0] || lines[0].trim() !== '---') return false;
  let s = false;
  for (let i = 1; i < Math.min(lines.length, 40); i += 1) {
    const t = lines[i].trim();
    if (t === '---') return s;
    if (/^[A-Za-z0-9_-]+:\s*/.test(t)) s = true;
  }
  return false;
}

// ──────────────────────────────────────────────────────────
//  句子分割
// ──────────────────────────────────────────────────────────

/**
 * 按句末标点分割文本为句子数组
 * 分隔符：。！？!?…\n（连续分隔符合并，不产生空句子）
 * @param {string} t - 输入文本
 * @returns {string[]} - 分割后的句子数组（已 trim，过滤空串）
 */
function splitSentences(t) {
  return t.split(/[。！？!?…\n]+/).map((s) => s.trim()).filter(Boolean);
}

// ──────────────────────────────────────────────────────────
//  代码块标记解析
// ──────────────────────────────────────────────────────────

/**
 * 解析 markdown 代码块围栏标记（``` 或 ~~~）
 * @param {string} t - 待检测文本（已 trim）
 * @returns {{char: string, length: number}|null} - 标记字符与长度，非围栏行返回 null
 */
function parseFenceMarker(t) {
  const m = /^(?:`{3,}|~{3,})/.exec(t);
  if (!m) return null;
  return { char: m[0][0], length: m[0].length };
}

// ──────────────────────────────────────────────────────────
//  导出
// ──────────────────────────────────────────────────────────

module.exports = {
  stripQuoted,
  visibleLength,
  isDivider,
  isStructural,
  hasYamlFrontMatter,
  splitSentences,
  parseFenceMarker,
};

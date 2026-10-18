#!/usr/bin/env node
'use strict';

/**
 * normalize-punctuation.js — 标点规范化确定性工具
 * 
 * 对标 oh-story-claudecode 的 normalize-punctuation.js，适配本地 04/05 标点规则。
 * 功能：
 *   - 清理残留省略号（……/...）、破折号（——/—/--）
 *   - 移除正文中的 markdown 分隔线（---）
 *   - 可选引号风格转换（keep/ascii/yan）
 * 
 * 用法：
 *   --write     执行实际修改（默认不修改，只报告）
 *   --check     向后兼容别名（report-only，现为默认行为）
 *   --quote-mode keep|ascii|yan  引号风格（默认 keep 不动）
 * 
 * 默认模式：report-only（只报告不修改）。使用 --write 参数执行实际修改。
 * 配合 05_去AI味精修师 Post-Step 使用。
 * 本地标点规则：省略号≤5/破折号≤8/感叹号≤15 每章。
 */

const fs = require('fs');
const path = require('path');
const { hasYamlFrontMatter } = require('./lib/prose-utils.js');

const USAGE = `Usage: node normalize-punctuation.js [--write] [--check] [--quote-mode keep|ascii|yan] <file...>

Normalize punctuation in prose files:
  - Replace ellipses (……/...), em-dashes (——/—/--), double-hyphens
  - Remove markdown divider lines (---)
  - Optional quote style conversion

Default: report-only (do not modify files). Use --write to modify files in place.`;

const options = { write: false, quoteMode: 'keep', files: [] };

for (let i = 2; i < process.argv.length; i++) {
  const arg = process.argv[i];
  if (arg === '--write') { options.write = true; }
  else if (arg === '--check') { /* backward-compat: report-only is now the default */ }
  else if (arg === '--quote-mode') { options.quoteMode = process.argv[++i]; }
  else if (arg.startsWith('--quote-mode=')) { options.quoteMode = arg.slice('--quote-mode='.length); }
  else if (arg === '-h' || arg === '--help') { process.stdout.write(USAGE); process.exit(0); }
  else if (arg.startsWith('-')) { die(`Unknown option: ${arg}`); }
  else { options.files.push(arg); }
}

if (!['keep', 'ascii', 'yan'].includes(options.quoteMode)) die(`Invalid --quote-mode: ${options.quoteMode}`);
if (options.files.length === 0) die('No files provided');

let totalFindings = 0, changedFiles = 0, failed = false;

for (const file of options.files) {
  const fullPath = path.resolve(file);
  let input;
  try { input = fs.readFileSync(fullPath, 'utf8'); }
  catch (e) { failed = true; console.error(`${file}: unable to read (${e.message})`); continue; }

  const result = normalizeDocument(input, options.quoteMode);
  totalFindings += result.findings.length;

  if (!options.write) {
    // report-only 模式：输出修改建议报告（列出每处替换的位置和内容），不修改文件
    if (result.findings.length > 0) {
      console.log(`${file}: 发现 ${result.findings.length} 处标点问题（report-only，未修改文件）:`);
      for (const f of result.findings) {
        console.log(`  L${f.line}:C${f.column} [${f.type}] ${f.message}`);
      }
    } else {
      console.log(`${file}: 无标点问题`);
    }
    continue;
  }

  if (result.output !== input) {
    fs.writeFileSync(fullPath, result.output, 'utf8');
    changedFiles++;
    console.log(`${file}: normalized (${result.findings.length} issue${result.findings.length === 1 ? '' : 's'})`);
  }
}

if (failed) process.exit(2);
if (!options.write && totalFindings > 0) process.exit(1);
if (options.write) console.log(`Done. Changed files: ${changedFiles}`);

function die(m) { console.error(m); console.error(USAGE.trimEnd()); process.exit(2); }

function normalizeDocument(input, quoteMode) {
  const newline = input.includes('\r\n') ? '\r\n' : '\n';
  const trailingNewline = input.endsWith('\n');
  const lines = input.split(/\r?\n/);
  if (trailingNewline) lines.pop();

  const findings = [], outputLines = [];
  let inFence = false, inFrontMatter = hasYamlFrontMatter(lines), quoteOpen = false;

  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1;
    let line = lines[i];
    const trimmed = line.trim();

    if (trimmed.startsWith('```')) { inFence = !inFence; outputLines.push(line); continue; }
    if (inFrontMatter) { outputLines.push(line); if (i > 0 && trimmed === '---') inFrontMatter = false; continue; }
    if (inFence) { outputLines.push(line); continue; }

    if (trimmed === '---') {
      findings.push({ line: lineNo, column: line.indexOf('-') + 1, type: 'markdown-divider',
        message: '正文中不要使用 markdown 分隔线；已移除该行。' });
      continue;
    }

    const pr = normalizePausePunctuation(line, lineNo);
    findings.push(...pr.findings);
    line = pr.line;

    const qr = normalizeQuotes(line, quoteMode, quoteOpen, lineNo);
    findings.push(...qr.findings);
    line = qr.line;
    quoteOpen = qr.quoteOpen;

    outputLines.push(line);
  }

  return { output: outputLines.join(newline) + (trailingNewline ? newline : ''), findings };
}

function normalizePausePunctuation(line, lineNo) {
  const findings = [];
  const original = line;
  const pattern = /…+|\.{3,}|——|—|--+/g;
  let output = '', lastIndex = 0, match;

  while ((match = pattern.exec(original)) !== null) {
    output += original.slice(lastIndex, match.index);
    const token = match[0];
    const replacement = choosePauseReplacement(original, match.index, token.length);
    output += replacement;
    findings.push({ line: lineNo, column: match.index + 1, type: getPauseType(token),
      message: replacement ? `替换为「${replacement}」。` : '移除重复标点。' });
    lastIndex = match.index + token.length;
  }
  output += original.slice(lastIndex);
  return { line: output, findings };
}

// hasYamlFrontMatter — 已提取至 ./lib/prose-utils.js
function getPauseType(t) { if (t.startsWith('-')) return 'double-hyphen'; if (t.includes('—')) return 'em-dash'; return 'ellipsis'; }

function choosePauseReplacement(text, start, length) {
  const before = previousNonSpace(text, start - 1);
  const after = nextNonSpace(text, start + length);
  const rest = text.slice(start + length).trimStart();

  if (before === '') return '';
  if (isOpeningDelimiter(before)) return '';
  if (/\d/.test(before) && /\d/.test(after)) return '到';
  if (isClosingQuote(after)) return isSentencePunctuation(before) ? '' : '。';
  if (!after) return isSentencePunctuation(before) ? '' : '。';
  if (isSentencePunctuation(before) || isPunctuation(after)) return '';
  if (/^(因为|原来|这是|那是|也就是|换句话|说白了|所谓|答案|原因|结果|真相|问题在于)/.test(rest)) return '：';
  if (/(原因|答案|真相|结果|结论|问题|选择|意思)$/.test(text.slice(0, start).trim())) return '：';
  return '，';
}

function previousNonSpace(t, i) { for (let j=i;j>=0;j--) if(!/\s/.test(t[j])) return t[j]; return ''; }
function nextNonSpace(t, i) { for (let j=i;j<t.length;j++) if(!/\s/.test(t[j])) return t[j]; return ''; }
function isSentencePunctuation(c) { return /[，,。.!！?？;；:：…]$/.test(c || ''); }
function isPunctuation(c) { return /[，,。.!！?？;；:：、…""''」』）)]/.test(c || ''); }
function isClosingQuote(c) { return /[""」』]/.test(c || ''); }
function isOpeningDelimiter(c) { return /[「『（("']/.test(c || ''); }

function normalizeQuotes(line, quoteMode, quoteOpen, lineNo) {
  if (quoteMode === 'keep') return { line, findings: [], quoteOpen };
  const findings = [];
  let output = '';
  // V5.3修复：用栈深度替代布尔值，支持嵌套引号
  let depth = quoteOpen ? 1 : 0;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoteMode === 'ascii' && /[「」『』""]/.test(ch)) {
      output += '"';
      findings.push({ line: lineNo, column: i + 1, type: 'quote-style', message: '按 quote-mode 转为半角双引号。' });
      continue;
    }
    if (quoteMode === 'yan' && (ch === '"' || ch === '\u201c' || ch === '\u201d')) {
      // V5.3修复：基于栈深度的引号配对，解决嵌套场景下运算符优先级导致的误判
      // Unicode开引号\u201c（"）总是输出「，闭引号\u201d（"）总是输出」
      // ASCII双引号"用启发式判断：depth=0时必为开引号；depth>0时检查前一个非空字符
      let replacement;
      if (ch === '\u201c') {
        // 左弯引号 — 总是开引号
        replacement = '「';
        depth++;
      } else if (ch === '\u201d') {
        // 右弯引号 — 总是闭引号
        replacement = '」';
        if (depth > 0) depth--;
      } else {
        // ASCII双引号 — 启发式判断
        if (depth === 0) {
          replacement = '「';
          depth++;
        } else {
          // 查找前一个非空字符
          let prevChar = '';
          for (let j = i - 1; j >= 0; j--) {
            if (!/\s/.test(line[j])) { prevChar = line[j]; break; }
          }
          // 前字符为空/标点/行首 → 开引号；前字符为汉字/字母 → 闭引号
          if (prevChar === '' || isPunctuation(prevChar) || isOpeningDelimiter(prevChar)) {
            replacement = '「';
            depth++;
          } else {
            replacement = '」';
            depth--;
          }
        }
      }
      output += replacement;
      findings.push({ line: lineNo, column: i + 1, type: 'quote-style', message: '按 quote-mode 转为盐言引号。' });
      continue;
    }
    output += ch;
  }
  // V5.3修复：返回时将depth转回布尔值（depth>0表示有未闭合的引号）
  return { line: output, findings, quoteOpen: depth > 0 };
}

#!/usr/bin/env node
'use strict';

/**
 * check-degeneration.js — 模型退化确定性检测
 * 
 * 对标 oh-story-claudecode 的 check-degeneration.js，适配本地 05_去AI味精修师。
 * 检测 5 类模型退化指纹（模型自身无法自检）：
 *   - verbatim-repeat（逐字复读/打转）: blocking
 *   - truncated（截断）: 正文末尾未以句末标点结束 → blocking
 *   - placeholder-leak（占位符/拒绝语/元信息泄漏）: blocking
 *   - meta-leak tier1（纯工程词泄漏）: blocking（对话行降为 advisory）
 *   - meta-leak tier2（章节结构词泄漏）: advisory
 * 
 * 用法：node check-degeneration.js [--check] [--json] [--fail-on=blocking|all] <file...>
 * 只报告不修改。网文中的排比/复沓/弹幕刷屏/重复台词是体裁手法，短句和对话复读豁免。
 */

const fs = require('fs');
const path = require('path');

const USAGE = `Usage: node check-degeneration.js [--check] [--json] [--fail-on=blocking|all] <file...>

Detect model-degeneration fingerprints:
  - verbatim-repeat (逐字复读/打转): blocking
  - truncated (截断): blocking
  - placeholder-leak (占位符/拒绝语): blocking
  - meta-leak tier1 (纯工程词): blocking
  - meta-leak tier2 (章节结构词): advisory

Report-only. Conservative: short/dialogue repetition exempt (体裁手法).`;

const REPEAT_MIN_LEN = 12;
const REPEAT_MIN_COUNT = 3;
const ADJACENT_MIN_LEN = 8;

const PLACEHOLDER_PATTERNS = [
  { re: /作为(一个)?(AI|人工智能|大?语言模型|智能助手|聊天助手)(?=[，,。、；;：:！!？?\s）)」』"】]|我|无法|不能|没法|$)/, label: '元信息泄漏（AI 自指）', hard: false },
  { re: /\uFFFD/, label: '乱码（替换字符）', hard: true },
  { re: /^(Sure|Certainly|Here'?s|As an AI|I (?:cannot|can't|am unable|apologize))/, label: '元信息泄漏（英文 AI 腔）', hard: true },
  { re: /[（(](此处|以下|这里|下文|后续)?\s*(省略|略)(去|过)?[^）)]{0,10}[）)]/, label: '占位符（括号省略）', hard: true },
  { re: /(未完待续|TODO|占位符|placeholder)/, label: '占位符', hard: true },
  { re: /我(无法|不能)(继续(写|创作|生成|下去)|生成(内容|文本|正文)?|创作|续写|完成(这个|本)?(章|篇|创作|请求))/, label: '元信息泄漏（生成拒绝语）', hard: false },
];

const META_TIER1_RE = /细纲|情节点|卷纲|功能标签|目标情绪|字数目标|章首钩子|章尾钩子/;
const META_TIER2_RE = /第[一二三四五六七八九十百千万两0-9]+章|本章|这一章|上一章|下一章|上章|下章|前一章|后一章|前文|后文|伏笔|读者|任务描述/;

const options = { json: false, files: [], failOn: 'all' };

for (let i = 2; i < process.argv.length; i += 1) {
  const arg = process.argv[i];
  if (arg === '--check') { /* check-only */ }
  else if (arg === '--json') { options.json = true; }
  else if (arg.startsWith('--fail-on=')) {
    const v = arg.slice('--fail-on='.length);
    if (v !== 'blocking' && v !== 'all') die(`--fail-on must be 'blocking' or 'all'`);
    options.failOn = v;
  } else if (arg === '-h' || arg === '--help') {
    process.stdout.write(`${USAGE}\n`); process.exit(0);
  } else if (arg.startsWith('-')) { die(`Unknown option: ${arg}`); }
  else { options.files.push(arg); }
}

if (options.files.length === 0) die('No files provided');

let failed = false;
const allFindings = [];

for (const file of options.files) {
  const fullPath = path.resolve(file);
  let input;
  try { input = fs.readFileSync(fullPath, 'utf8'); }
  catch (e) { failed = true; if (!options.json) console.error(`${file}: unable to read (${e.message})`); continue; }
  allFindings.push(...scanDocument(input).map(f => ({ file, ...f })));
}

if (options.json) { process.stdout.write(`${JSON.stringify({ findings: allFindings }, null, 2)}\n`); }
else { for (const f of allFindings) console.log(`${f.file}:${f.line}:${f.column}: [${f.severity}] ${f.type}: ${f.message} (${f.excerpt})`); }

if (failed) process.exit(2);
const hasBlocking = allFindings.some(f => f.severity === 'blocking');
if (options.failOn === 'blocking' ? hasBlocking : allFindings.length > 0) process.exit(1);

function die(m) { console.error(m); console.error(USAGE.trimEnd()); process.exit(2); }

function scanDocument(input) {
  const lines = input.split(/\r?\n/);
  const content = [];
  let fence = null, inFrontMatter = hasYamlFrontMatter(lines);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i], trimmed = line.trim();
    if (inFrontMatter) { if (i > 0 && trimmed === '---') inFrontMatter = false; continue; }
    const fm = /^(?:`{3,}|~{3,})/.exec(trimmed);
    if (fence) { if (fm && trimmed[0] === fence) fence = null; continue; }
    if (fm) { fence = trimmed[0]; continue; }
    content.push({ text: line, trimmed, lineNo: i + 1 });
  }
  const findings = [];
  findings.push(...findRepetition(content));
  findings.push(...findTruncation(content));
  findings.push(...findPlaceholders(content));
  findings.push(...findMetaLeak(content));
  findings.sort((a, b) => a.line - b.line || a.column - b.column);
  return findings;
}

function isContent(t) { return t && !t.startsWith('#') && !/^-{3,}$/.test(t); }
function isDialogueLike(t) { return /[""'\'「」『』【】]/.test(t); }
function stripQuoted(t) { return t.replace(/「[^」]*」/g,'').replace(/『[^』]*』/g,'').replace(/【[^】]*】/g,'').replace(/"[^"]*"/g,'').replace(/'[^']*'/g,'').replace(/"[^"]*"/g,'').replace(/'[^']*'/g,''); }
function visibleLength(t) { const m = t.match(/[一-鿿Ａ-ｚA-Za-z0-9]/g); return m ? m.length : 0; }
function hasYamlFrontMatter(l) { if(!l[0]||l[0].trim()!=='---')return false;let s=false;for(let i=1;i<Math.min(l.length,40);i++){const t=l[i].trim();if(t==='---')return s;if(/^[A-Za-z0-9_-]+:\s*/.test(t))s=true;}return false; }
function compact(t) { const n = t.replace(/\s+/g, ' ').trim(); return n.length > 80 ? `${n.slice(0, 77)}...` : n; }

function findRepetition(content) {
  const findings = [];
  const body = content.filter(c => isContent(c.trimmed));
  // (1) adjacent identical lines
  for (let i = 1; i < body.length; i++) {
    if (body[i].trimmed === body[i-1].trimmed && visibleLength(stripQuoted(body[i].trimmed)) >= ADJACENT_MIN_LEN) {
      findings.push({ line: body[i].lineNo, column: 1, type: 'verbatim-repeat', severity: 'blocking',
        message: '逐行复读（紧邻整行重复）：疑似模型打转，重写本段。', excerpt: compact(body[i].trimmed) });
    }
  }
  // (2) repeated long sentences
  const counts = new Map();
  for (const { trimmed } of body) {
    for (const s of stripQuoted(trimmed).split(/[。！？!?]/)) {
      const st = s.trim(); if (visibleLength(st) < REPEAT_MIN_LEN) continue;
      const e = counts.get(st) || { count: 0 }; e.count++; counts.set(st, e);
    }
  }
  const flagged = new Set();
  for (const [s, e] of counts) { if (e.count >= REPEAT_MIN_COUNT) flagged.add(s); }
  if (flagged.size) {
    for (const { trimmed, lineNo } of body) {
      for (const s of stripQuoted(trimmed).split(/[。！？!?]/)) {
        const st = s.trim();
        if (flagged.has(st)) {
          findings.push({ line: lineNo, column: 1, type: 'verbatim-repeat', severity: 'blocking',
            message: `长句复读（同句出现 ${counts.get(st).count} 次）：疑似模型打转，重写保留一处。`, excerpt: compact(st) });
          flagged.delete(st);
        }
      }
    }
  }
  return findings;
}

function findTruncation(content) {
  const body = content.filter(c => isContent(c.trimmed));
  if (!body.length) return [];
  const last = body[body.length - 1];
  if (/[。！？!?…"''』」）)】]$/.test(last.trimmed)) return [];
  return [{ line: last.lineNo, column: last.trimmed.length, type: 'truncated', severity: 'blocking',
    message: '疑似截断：正文末尾未以句末/收尾标点结束，可能被模型中途切断。', excerpt: compact(last.trimmed.slice(-24)) }];
}

function findPlaceholders(content) {
  const findings = [];
  for (const { trimmed, lineNo } of content) {
    if (!isContent(trimmed)) continue;
    const dialogue = isDialogueLike(trimmed);
    for (const { re, label, hard } of PLACEHOLDER_PATTERNS) {
      if (!hard && dialogue) continue;
      const m = re.exec(trimmed);
      if (m) {
        findings.push({ line: lineNo, column: (m.index||0)+1, type: 'placeholder-leak', severity: 'blocking',
          message: `${label}：正文混入元信息/拒绝语/占位符，重写本段。`,
          excerpt: compact(trimmed.slice(Math.max(0,(m.index||0)-4),(m.index||0)+20)) });
        break;
      }
    }
  }
  return findings;
}

function findMetaLeak(content) {
  const findings = [];
  let firstSeen = false;
  for (const { trimmed, lineNo } of content) {
    if (!isContent(trimmed)) continue;
    if (!firstSeen) { firstSeen = true; if (/^第[一二三四五六七八九十百千万两0-9]+章/.test(trimmed)) continue; }
    const dialogue = isDialogueLike(trimmed);
    let m = META_TIER1_RE.exec(trimmed);
    if (m) {
      findings.push({ line: lineNo, column: m.index+1, type: 'meta-leak', severity: dialogue?'advisory':'blocking',
        message: `工程词泄漏：「${m[0]}」是写作流水线术语，正文不该出现。${dialogue?'例外：角色为作者在故事内讨论创作时可能合法。':''}`,
        excerpt: compact(trimmed.slice(Math.max(0,m.index-6),m.index+18)) });
      continue;
    }
    m = META_TIER2_RE.exec(trimmed);
    if (m) {
      findings.push({ line: lineNo, column: m.index+1, type: 'meta-leak', severity: 'advisory',
        message: `元信息泄漏：「${m[0]}」疑似工程/章节结构词混入正文。`,
        excerpt: compact(trimmed.slice(Math.max(0,m.index-6),m.index+18)) });
    }
  }
  return findings;
}

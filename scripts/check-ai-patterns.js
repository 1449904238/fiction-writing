#!/usr/bin/env node
'use strict';

/**
 * check-ai-patterns.js — 高危 AI 句式确定性检测
 * 
 * 对标 oh-story-claudecode 的 check-ai-patterns.js，适配本地 11 Gate 体系。
 * 检测 4 类 AI 模式：
 *   - not-is-comparison（否定翻转）: "不是A，而是B" 高频 AI 对比句式 → blocking
 *   - em-dash（破折号）: —— / — / -- → blocking（按功能改写，勿一律改句号）
 *   - period-stutter（碎句号）: 连续短叙述句无呼吸 → advisory
 *   - long-paragraph（长段落）: 单段超长，按镜头断段 → advisory
 * 
 * 用法：node check-ai-patterns.js [--check] [--json] [--fail-on=blocking|all] <file...>
 * 只报告不修改。配合 05_去AI味精修师 的 Post-Step 确定性收尾使用。
 */

const fs = require('fs');
const path = require('path');

const USAGE = `Usage: node check-ai-patterns.js [--check] [--json] [--fail-on=blocking|all] <file...>

Detect high-risk AI-flavor prose patterns:
  - not-is-comparison (否定翻转): blocking
  - em-dash (破折号): blocking
  - period-stutter (碎句号): advisory
  - long-paragraph (长段落): advisory

Report-only. Never rewrites text.`;

const STOP_CHARS = new Set(['。', '！', '？', '!', '?', '\n']);
const SOFT_SEPARATORS = new Set(['，', ',', '、', '；', ';', '：', ':']);
const HARD_SEPARATORS = new Set(['。', '.', '！', '!', '？', '?']);
const MAX_NEGATIVE_SPAN = 80;
const MAX_POSITIVE_SPAN = 80;

const STUTTER_MIN_RUN = 6;
const STUTTER_MAX_SENTENCE = 5;
const LONG_PARAGRAPH_CHARS = 200;

const COMPACT_EITHER_OR_PREV = new Set(['不', '就', '也']);
const TAG_PARTICLES = new Set(['吗', '吧', '嘛']);

const options = { json: false, files: [], failOn: 'all' };

for (let i = 2; i < process.argv.length; i += 1) {
  const arg = process.argv[i];
  if (arg === '--check') { /* check-only mode */ }
  else if (arg === '--json') { options.json = true; }
  else if (arg.startsWith('--fail-on=')) {
    const v = arg.slice('--fail-on='.length);
    if (v !== 'blocking' && v !== 'all') die(`--fail-on must be 'blocking' or 'all'`);
    options.failOn = v;
  } else if (arg === '-h' || arg === '--help') {
    process.stdout.write(`${USAGE}\n`);
    process.exit(0);
  } else if (arg.startsWith('-')) {
    die(`Unknown option: ${arg}`);
  } else {
    options.files.push(arg);
  }
}

if (options.files.length === 0) die('No files provided');

let failed = false;
const allFindings = [];

for (const file of options.files) {
  const fullPath = path.resolve(file);
  let input;
  try { input = fs.readFileSync(fullPath, 'utf8'); }
  catch (error) { failed = true; if (!options.json) console.error(`${file}: unable to read (${error.message})`); continue; }
  const findings = scanDocument(input).map((f) => ({ file, ...f }));
  allFindings.push(...findings);
}

if (options.json) {
  process.stdout.write(`${JSON.stringify({ findings: allFindings }, null, 2)}\n`);
} else {
  for (const f of allFindings) {
    console.log(`${f.file}:${f.line}:${f.column}: [${f.severity}] ${f.type}: ${f.message} (${f.excerpt})`);
  }
}

if (failed) process.exit(2);
const hasBlocking = allFindings.some((f) => f.severity === 'blocking');
if (options.failOn === 'blocking' ? hasBlocking : allFindings.length > 0) process.exit(1);

function die(message) { console.error(message); console.error(USAGE.trimEnd()); process.exit(2); }

function scanDocument(input) {
  const lines = input.split(/\r?\n/);
  const findings = [];
  let fence = null;
  let inFrontMatter = hasYamlFrontMatter(lines);
  let block = [];
  const proseLines = [];
  const flushBlock = () => { if (block.length === 0) return; findings.push(...scanBlock(block)); block = []; };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const trimmed = line.trim();
    if (inFrontMatter) { if (index > 0 && trimmed === '---') inFrontMatter = false; continue; }
    const fenceMarker = parseFenceMarker(trimmed);
    if (fence) { if (fenceMarker && fenceMarker.char === fence.char && fenceMarker.length >= fence.length) fence = null; continue; }
    if (fenceMarker) { flushBlock(); fence = fenceMarker; continue; }
    block.push({ text: line, lineNo: index + 1 });
    proseLines.push({ text: line, lineNo: index + 1 });
  }
  flushBlock();
  findings.push(...scanProsePatterns(proseLines));
  findings.sort((a, b) => a.line - b.line || a.column - b.column);
  return findings;
}

function scanProsePatterns(proseLines) {
  const findings = [];
  for (const { text, lineNo } of proseLines) {
    const trimmed = text.trim();
    if (!trimmed || isDivider(trimmed) || isStructural(trimmed)) continue;
    const dashPattern = /——|—|--+/g;
    let dash;
    while ((dash = dashPattern.exec(text)) !== null) {
      findings.push({ line: lineNo, column: dash.index + 1, type: 'em-dash', severity: 'blocking',
        message: '破折号按功能改写：打断→动作beat/短句，拖长音→省略或动作，插入说明→逗号/冒号。',
        excerpt: compact(text.slice(Math.max(0, dash.index - 8), dash.index + dash[0].length + 8)) });
    }
    if (trimmed.length > LONG_PARAGRAPH_CHARS) {
      findings.push({ line: lineNo, column: 1, type: 'long-paragraph', severity: 'advisory',
        message: `段落过长（${trimmed.length} 字）：按镜头/新动作/新线索/视线切换断段。`,
        excerpt: compact(trimmed.slice(0, 40)) });
    }
  }
  findings.push(...findPeriodStutter(proseLines));
  return findings;
}

function findPeriodStutter(proseLines) {
  const findings = [];
  let runLen = 0, runStartLine = null, runSample = [];
  const flush = () => {
    if (runLen >= STUTTER_MIN_RUN) {
      findings.push({ line: runStartLine, column: 1, type: 'period-stutter', severity: 'advisory',
        message: `碎句号：连续 ${runLen} 个短句无呼吸；合并碎句成中长句、补回画面与连接。`,
        excerpt: compact(runSample.join(' ')) });
    }
    runLen = 0; runStartLine = null; runSample = [];
  };
  for (const { text, lineNo } of proseLines) {
    const trimmed = text.trim();
    if (!trimmed) continue;
    if (isDivider(trimmed) || isStructural(trimmed)) { flush(); continue; }
    const narrative = stripQuoted(trimmed);
    if (visibleLength(narrative) === 0) { flush(); continue; }
    for (const sentence of splitSentences(narrative)) {
      if (visibleLength(sentence) <= STUTTER_MAX_SENTENCE) {
        if (runLen === 0) runStartLine = lineNo;
        runLen += 1;
        if (runSample.length < 6) runSample.push(sentence);
      } else { flush(); }
    }
  }
  flush();
  return findings;
}

function isDivider(t) { return /^-{3,}$/.test(t) || /^[*_]{3,}$/.test(t); }
function isStructural(t) { return /^(#{1,6}\s|>\s?|[-*+]\s|\d+[.)]\s|\|)/.test(t); }
function stripQuoted(t) { return t.replace(/「[^」]*」/g,'').replace(/『[^』]*』/g,'').replace(/【[^】]*】/g,'').replace(/"[^"]*"/g,'').replace(/'[^']*'/g,'').replace(/"[^"]*"/g,'').replace(/'[^']*'/g,''); }
function splitSentences(t) { return t.split(/[。！？!?]/).map(s=>s.trim()).filter(Boolean); }
function visibleLength(s) { const m = s.match(/[一-鿿Ａ-ｚA-Za-z0-9]/g); return m ? m.length : 0; }
function parseFenceMarker(t) { const m = /^(?:`{3,}|~{3,})/.exec(t); if (!m) return null; return { char: m[0][0], length: m[0].length }; }
function hasYamlFrontMatter(lines) { if (!lines[0]||lines[0].trim()!=='---') return false; let s=false; for(let i=1;i<Math.min(lines.length,40);i++){const t=lines[i].trim();if(t==='---')return s;if(/^[A-Za-z0-9_-]+:\s*/.test(t))s=true;} return false; }

function scanBlock(block) {
  const text = block.map(e=>e.text).join('\n');
  const lineStarts = []; let cursor = 0;
  for (const entry of block) { lineStarts.push({ offset: cursor, lineNo: entry.lineNo }); cursor += entry.text.length + 1; }
  return findNotIsComparisons(text, (offset) => positionForOffset(lineStarts, offset));
}

function positionForOffset(lineStarts, offset) {
  let low=0, high=lineStarts.length-1;
  while(low<=high){const mid=Math.floor((low+high)/2);const c=lineStarts[mid];const n=lineStarts[mid+1];if(offset<c.offset)high=mid-1;else if(n&&offset>=n.offset)low=mid+1;else return{line:c.lineNo,column:offset-c.offset+1};}
  return{line:lineStarts[0].lineNo,column:1};
}

function findNotIsComparisons(text, getPosition) {
  const findings = []; let offset = 0;
  while (offset < text.length) {
    const start = text.indexOf('不是', offset);
    if (start === -1) break;
    if (start > 0 && text[start - 1] === '是') { offset = start + 2; continue; }
    const candidate = text.slice(start);
    const markerEnd = findPositiveFlipEnd(candidate);
    if (markerEnd === -1) { offset = start + 2; continue; }
    const raw = trimTrailingNoise(extractFinding(candidate, markerEnd));
    if (raw.length >= 4) {
      const position = getPosition(start);
      findings.push({ line: position.line, column: position.column, type: 'not-is-comparison', severity: 'blocking',
        message: '高频 AI 对比句式；删掉否定铺垫，直接写后项，或改成动作/细节呈现。', excerpt: compact(raw) });
    }
    offset = start + Math.max(raw.length, 2);
  }
  return findings;
}

function findPositiveFlipEnd(c) {
  let i=2,scanned=0,crossed=false;
  while(i<c.length&&scanned<=MAX_NEGATIVE_SPAN){
    const ch=c[i];
    if(startsWithAt(c,i,'而是'))return i+2;
    if(SOFT_SEPARATORS.has(ch)){const n=skipGap(c,i+1);if(startsWithAt(c,n,'而是'))return n+2;if(c[n]==='是'&&!TAG_PARTICLES.has(c[n+1]))return n+1;crossed=true;}
    if(HARD_SEPARATORS.has(ch)){const n=skipGap(c,i+1);if(c[n]==='是'&&!TAG_PARTICLES.has(c[n+1]))return n+1;if(ch!=='.')break;crossed=true;}
    if(STOP_CHARS.has(ch))break;
    if(ch==='是'&&!COMPACT_EITHER_OR_PREV.has(c[i-1])&&!crossed)return i+1;
    i+=1;scanned+=1;
  }
  return -1;
}

function extractFinding(c,me){let e=me;const l=Math.min(c.length,me+MAX_POSITIVE_SPAN);while(e<l){if(STOP_CHARS.has(c[e]))break;e+=1;}return c.slice(0,e);}
function startsWithAt(t,i,n){return t.slice(i,i+n.length)===n;}
function skipGap(t,i){while(i<t.length&&isInlineSpace(t[i]))i+=1;if(t[i]==='\n'){i+=1;while(i<t.length&&isInlineSpace(t[i]))i+=1;}return i;}
function isInlineSpace(c){return c===' '||c==='\t'||c==='\r';}
function trimTrailingNoise(t){return t.replace(/[\s|）)】\]]+$/u,'');}
function compact(t){const n=t.replace(/\s+/g,' ').trim();return n.length>80?`${n.slice(0,77)}...`:n;}

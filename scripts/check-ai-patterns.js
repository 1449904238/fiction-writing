#!/usr/bin/env node
'use strict';

/**
 * check-ai-patterns.js — 高危 AI 句式确定性检测
 * 
 * 对标 oh-story-claudecode 的 check-ai-patterns.js，适配本地 11 Gate 体系。
 * 检测 4 类 AI 模式：
 *   - not-is-comparison（否定翻转）: "不是A，而是B" 高频 AI 对比句式 → blocking
 *   - em-dash（破折号）: —— / — / -- → 计数模式：≤4处/章合规，5-7处advisory，≥8处blocking
 *   - period-stutter（碎句号）: 连续短叙述句无呼吸 → advisory
 *   - long-paragraph（长段落）: 单段超长，按镜头断段 → advisory
 *   - sentence-variance（突发度不足）: 句长标准差过低 → advisory（V2.2新增）
 *   - ai-connector（AI高频连接词）: 然而/此外/与此同时等 → advisory（V2.2新增）
 *   - emotion-direct（情绪词直给）: 悲伤/愤怒/绝望等 → advisory（V2.2新增）
 * 
 * 用法：node check-ai-patterns.js [--check] [--json] [--fail-on=blocking|all] <file...>
 * 只报告不修改。配合 05_去AI味精修师 的 Post-Step 确定性收尾使用。
 */

const fs = require('fs');
const path = require('path');
const { stripQuoted, visibleLength, isDivider, isStructural, hasYamlFrontMatter, splitSentences, parseFenceMarker } = require('./lib/prose-utils.js');

const USAGE = `Usage: node check-ai-patterns.js [--check] [--json] [--fail-on=blocking|all] <file...>

Detect high-risk AI-flavor prose patterns:
  - not-is-comparison (否定翻转): blocking
  - em-dash (破折号): advisory (5-7/章) / blocking (≥8/章)
  - period-stutter (碎句号): advisory
  - long-paragraph (长段落): advisory
  - metaphor-density (比喻密度): advisory/blocking (≥3/千字=advisory, ≥5/千字=blocking)

Report-only. Never rewrites text.`;

const STOP_CHARS = new Set(['。', '！', '？', '!', '?', '\n']);
const SOFT_SEPARATORS = new Set(['，', ',', '、', '；', ';', '：', ':']);
const HARD_SEPARATORS = new Set(['。', '.', '！', '!', '？', '?']);
const MAX_NEGATIVE_SPAN = 50;
const MAX_POSITIVE_SPAN = 80;

const STUTTER_MIN_RUN = 6;
const STUTTER_MAX_SENTENCE = 5;
const LONG_PARAGRAPH_CHARS = 200;

// Metaphor density thresholds (per 1000 characters)
const METAPHOR_DENSITY_WARN = 3.0;   // ⚠️ 偏高
const METAPHOR_DENSITY_BLOCK = 5.0;  // ❌ 超标
const METAPHOR_DENSITY_CRITICAL = 7.0; // ❌❌ 严重超标

// Simile markers — "像"字明喻 + 仿佛/如同/似的/宛若/好似
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

// AI characteristic connector words — 知网AIGC检测"特征词汇检测"维度
// 来源：知网AIGC检测指南 + GPTZero/Originality.ai交叉验证
// 这些词在AI生成文本中密度异常高，在人类口语化写作中极少出现
const AI_CONNECTOR_WORDS = [
  { pattern: /然而[,，。！？!?]/g, word: '然而', message: 'AI高频连接词：人或人说话不会先说"然而"。改为自然转折或直接删除。' },
  { pattern: /此外[,，。！？!?]/g, word: '此外', message: 'AI高频连接词：改为自然过渡或直接删除。' },
  { pattern: /与此同时[,，。！？!?]/g, word: '与此同时', message: 'AI高频连接词：改为动作beat过渡或直接删除。' },
  { pattern: /值得注意的是[,，。！？!?]/g, word: '值得注意的是', message: 'AI高频连接词：改为具体观察或直接删除。' },
  { pattern: /综上所述[,，。！？!?]/g, word: '综上所述', message: 'AI高频连接词：网文不需要总结性收束。直接删除。' },
  { pattern: /不可否认[,，。！？!?]/g, word: '不可否认', message: 'AI高频连接词：改为角色态度或直接删除。' },
  { pattern: /毋庸置疑[,，。！？!?]/g, word: '毋庸置疑', message: 'AI高频连接词：改为具体物证或直接删除。' },
  { pattern: /总而言之[,，。！？!?]/g, word: '总而言之', message: 'AI高频连接词：网文不需要总结收束。直接删除。' },
  { pattern: /换言之[,，。！？!?]/g, word: '换言之', message: 'AI高频连接词：改为自然解释或直接删除。' },
];

// AI emotion-word list — 情绪工程协议第五章"情绪词残留扫描"
const AI_EMOTION_WORDS = [
  '悲伤', '愤怒', '绝望', '心碎', '痛苦', '震惊', '恐惧', '哀伤',
  '悲凉', '凄凉', '心酸', '心寒', '胆寒', '震撼', '震怒', '狂怒',
  '悲愤', '哀怨', '忧伤', '惶恐', '惊恐', '惶惑', '焦灼', '焦躁',
];

// V2.6新增：叙述语AI味预警词分级检测（与03/04铁律5同步）
// A级=零容忍(blocking), B级=每章≤2次(advisory), C级=对话豁免(不检测)
const AI_NARRATIVE_BAN_A = [
  '意味着', '是因为', '这说明', '他发现', '他心里明白', '他在等',
  '他意识到', '显然', '可见', '看出规律', '异乎寻常'
];
const AI_NARRATIVE_BAN_B = ['觉得', '知道', '看来'];
const B_LEVEL_LIMIT = 2; // B级词每章允许≤2次

const COMPACT_EITHER_OR_PREV = new Set(['不', '就', '也']);
const TAG_PARTICLES = new Set(['吗', '吧', '嘛']);

// 反问句前缀：当"不是"前紧跟这些字时，属于反问/推测语气（莫不是/岂不是/别不是），
// 而非"不是A而是B"的AI对比句式，应排除
const RHETORICAL_PREFIX = new Set(['莫', '岂', '别']);

// 对话引导字符：当"不是"出现在这些对话标记之后时，可能是对话内合法使用
const DIALOGUE_OPEN_RE = /[\u201c\u2018\u300c\u300e]/g;  // 左弯引号、左单引号、「、『
const DIALOGUE_CLOSE_RE = /[\u201d\u2019\u300d\u300f]/g; // 右弯引号、右单引号、」、』

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
  findings.push(...scanEmDashCount(proseLines));
  findings.push(...scanMetaphorDensity(proseLines));
  findings.push(...scanAIConnectorWords(proseLines));
  findings.push(...scanEmotionWords(proseLines));
  findings.push(...scanNarrativeBanWords(proseLines));
  findings.push(...scanSentenceVariance(proseLines));
  findings.push(...scanNegationParallelism(proseLines));
  findings.push(...scanImageryRepeat(proseLines));
  findings.sort((a, b) => a.line - b.line || a.column - b.column);
  return findings;
}

function scanProsePatterns(proseLines) {
  const findings = [];
  for (const { text, lineNo } of proseLines) {
    const trimmed = text.trim();
    if (!trimmed || isDivider(trimmed) || isStructural(trimmed)) continue;
    // em-dash 逐处检测已移除，改为文档级计数模式（见 scanEmDashCount）
    if (trimmed.length > LONG_PARAGRAPH_CHARS) {
      findings.push({ line: lineNo, column: 1, type: 'long-paragraph', severity: 'advisory',
        message: `段落过长（${trimmed.length} 字）：按镜头/新动作/新线索/视线切换断段。`,
        excerpt: compact(trimmed.slice(0, 40)) });
    }
  }
  findings.push(...findPeriodStutter(proseLines));
  return findings;
}

// em-dash 计数模式：全章统计破折号数量，≤4合规/5-7 advisory/≥8 blocking
function scanEmDashCount(proseLines) {
  const findings = [];
  let dashCount = 0;
  let firstDashLine = -1;
  const dashPattern = /——|—|--+/g;
  for (const { text, lineNo } of proseLines) {
    const trimmed = text.trim();
    if (!trimmed || isDivider(trimmed) || isStructural(trimmed)) continue;
    let dash;
    dashPattern.lastIndex = 0;
    while ((dash = dashPattern.exec(text)) !== null) {
      dashCount++;
      if (firstDashLine === -1) firstDashLine = lineNo;
    }
  }
  if (dashCount >= 5) {
    const severity = dashCount >= 8 ? 'blocking' : 'advisory';
    const level = dashCount >= 8 ? '超标' : '偏高';
    findings.push({
      line: firstDashLine, column: 1, type: 'em-dash', severity,
      message: `破折号数量${level}：全章${dashCount}处（规则限≤4处/章）。${dashCount >= 8 ? '超出过多，需删减至4处以内。' : '接近上限，建议精简至4处以内。'}保留有表达功能的破折号（打断/拖音/插入说明），其余改写。`,
      excerpt: `破折号共${dashCount}处`
    });
  }
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

// AI connector word detection — 知网AIGC检测"特征词汇检测"维度
function scanAIConnectorWords(proseLines) {
  const findings = [];
  for (const { text, lineNo } of proseLines) {
    const trimmed = text.trim();
    if (!trimmed || isDivider(trimmed) || isStructural(trimmed)) continue;
    const narrative = stripQuoted(trimmed); // 只检测叙述语，不检测对话
    for (const { pattern, word, message } of AI_CONNECTOR_WORDS) {
      pattern.lastIndex = 0;
      let match;
      while ((match = pattern.exec(narrative)) !== null) {
        findings.push({ line: lineNo, column: match.index + 1, type: 'ai-connector', severity: 'advisory',
          message, excerpt: compact(narrative.slice(Math.max(0, match.index - 6), match.index + word.length + 6)) });
      }
    }
  }
  return findings;
}

// Emotion word detection — 情绪工程协议第五章"情绪词残留扫描"
// 只检测叙述语中的情绪词直给，对话中的情绪词可保留
function scanEmotionWords(proseLines) {
  const findings = [];
  for (const { text, lineNo } of proseLines) {
    const trimmed = text.trim();
    if (!trimmed || isDivider(trimmed) || isStructural(trimmed)) continue;
    const narrative = stripQuoted(trimmed);
    for (const word of AI_EMOTION_WORDS) {
      let idx = narrative.indexOf(word);
      while (idx !== -1) {
        findings.push({ line: lineNo, column: idx + 1, type: 'emotion-direct', severity: 'advisory',
          message: `情绪词直给"${word}"：改为情绪锚点（小而具体的物理动作/物件）或五感榨汁机法。见 references/03_情绪工程协议.md。`,
          excerpt: compact(narrative.slice(Math.max(0, idx - 6), idx + word.length + 6)) });
        idx = narrative.indexOf(word, idx + word.length);
      }
    }
  }
  return findings;
}

// V2.6新增：叙述语AI味预警词分级扫描（A级blocking, B级计数限流, 对话豁免）
function scanNarrativeBanWords(proseLines) {
  var findings = [];
  var bLevelCounts = {}; // B级词全章计数

  for (var i = 0; i < proseLines.length; i++) {
    var line = proseLines[i];
    var text = line.text.trim();
    if (!text || isDivider(text) || isStructural(text)) continue;
    var narrative = stripQuoted(text); // C级豁免：只检测叙述语

    // A级词：零容忍，逐处标记blocking
    for (var ai = 0; ai < AI_NARRATIVE_BAN_A.length; ai++) {
      var wordA = AI_NARRATIVE_BAN_A[ai];
      var idxA = narrative.indexOf(wordA);
      while (idxA !== -1) {
        findings.push({
          line: line.lineNo, column: idxA + 1, type: 'narrative-ban-a', severity: 'blocking',
          message: 'A级违禁词「' + wordA + '」出现在叙述语中（零容忍）。删除并替换为客观物证。',
          excerpt: compact(narrative.slice(Math.max(0, idxA - 6), idxA + wordA.length + 6))
        });
        idxA = narrative.indexOf(wordA, idxA + wordA.length);
      }
    }

    // B级词：计数，全章统计后判定
    for (var bi = 0; bi < AI_NARRATIVE_BAN_B.length; bi++) {
      var wordB = AI_NARRATIVE_BAN_B[bi];
      var idxB = narrative.indexOf(wordB);
      while (idxB !== -1) {
        if (!bLevelCounts[wordB]) bLevelCounts[wordB] = [];
        bLevelCounts[wordB].push({ line: line.lineNo, col: idxB + 1, excerpt: compact(narrative.slice(Math.max(0, idxB - 6), idxB + wordB.length + 6)) });
        idxB = narrative.indexOf(wordB, idxB + wordB.length);
      }
    }
  }

  // B级词全章统计后判定
  for (var word in bLevelCounts) {
    var hits = bLevelCounts[word];
    if (hits.length > B_LEVEL_LIMIT) {
      findings.push({
        line: hits[0].line, column: hits[0].col, type: 'narrative-ban-b', severity: 'advisory',
        message: 'B级预警词「' + word + '」在叙述语中出现' + hits.length + '次（限制≤' + B_LEVEL_LIMIT + '次/章）。超出部分交04精修处理。',
        excerpt: '全章共' + hits.length + '处'
      });
    }
  }

  return findings;
}

// Sentence variance / burstiness detection — 突发度检测（V2.2新增）
// 对标 GPTZero/知网AIGC检测的 burstiness 维度
// AI文本句长分布异常均匀（标准差低），人类长短句交替变化剧烈
function scanSentenceVariance(proseLines) {
  const findings = [];
  var allLens = [];
  for (const { text, lineNo } of proseLines) {
    const trimmed = text.trim();
    if (!trimmed || isDivider(trimmed) || isStructural(trimmed)) continue;
    const narrative = stripQuoted(trimmed);
    if (visibleLength(narrative) === 0) continue;
    for (const sentence of splitSentences(narrative)) {
      var len = visibleLength(sentence);
      if (len > 0) allLens.push(len);
    }
  }
  if (allLens.length < 8) return findings; // 句子太少不检测
  var mean = allLens.reduce(function(a, b) { return a + b; }, 0) / allLens.length;
  var variance = allLens.reduce(function(s, l) { return s + (l - mean) * (l - mean); }, 0) / allLens.length;
  var stdDev = Math.sqrt(variance);
  if (stdDev < 8) {
    findings.push({
      line: 1, column: 1, type: 'sentence-variance', severity: 'advisory',
      message: '突发度不足：全章句长标准差=' + stdDev.toFixed(1) + '（<8），句式过于均匀，疑似AI节奏指纹。人类写作长短句交替，标准差通常>15。建议：三短一长交替（3个15字短句+1个40字长句）。',
      excerpt: '平均句长' + mean.toFixed(1) + '字, 标准差' + stdDev.toFixed(1) + ', 句子数' + allLens.length
    });
  }
  return findings;
}

function scanMetaphorDensity(proseLines) {
  const findings = [];
  let totalChars = 0;
  let metaphorCount = 0;
  const metaphorLocations = [];

  for (const { text, lineNo } of proseLines) {
    const trimmed = text.trim();
    if (!trimmed || isDivider(trimmed) || isStructural(trimmed)) continue;
    // Strip dialogue — metaphors in dialogue are character voice, not narrator AI-flavor
    const narrative = stripQuoted(trimmed);
    if (visibleLength(narrative) === 0) continue;

    totalChars += visibleLength(narrative);

    for (const pattern of SIMILE_PATTERNS) {
      pattern.lastIndex = 0;
      let match;
      while ((match = pattern.exec(narrative)) !== null) {
        metaphorCount += 1;
        if (metaphorLocations.length < 20) {
          metaphorLocations.push({ line: lineNo, excerpt: compact(match[0]) });
        }
      }
    }
  }

  if (totalChars < 200) return findings; // Too short for meaningful density

  const density = (metaphorCount / (totalChars / 1000));

  if (density > METAPHOR_DENSITY_WARN) {
    const severity = density > METAPHOR_DENSITY_CRITICAL ? 'blocking' :
                     density > METAPHOR_DENSITY_BLOCK ? 'blocking' : 'advisory';
    const level = density > METAPHOR_DENSITY_CRITICAL ? '严重超标（比喻轰炸）' :
                  density > METAPHOR_DENSITY_BLOCK ? '超标' : '偏高';
    findings.push({
      line: metaphorLocations[0] ? metaphorLocations[0].line : 1,
      column: 1,
      type: 'metaphor-density',
      severity,
      message: `比喻密度${level}：${metaphorCount}个比喻 / ${(totalChars / 1000).toFixed(1)}千字 = ${density.toFixed(1)}/千字（人类基准≤3，AI检测红线≤5）。精简装饰性比喻，保留每章≤3个有记忆点的比喻。`,
      excerpt: `比喻句：${metaphorLocations.slice(0, 5).map(m => m.excerpt).join(' / ')}${metaphorCount > 5 ? ' ...' : ''}`
    });

    // Also report individual metaphor locations for targeted editing
    for (const loc of metaphorLocations.slice(0, 10)) {
      findings.push({
        line: loc.line, column: 1, type: 'metaphor-instance', severity: 'advisory',
        message: '比喻句实例（按优先级决定保留/删除）。',
        excerpt: loc.excerpt
      });
    }
  }

  return findings;
}

// stripQuoted, visibleLength, isDivider, isStructural, hasYamlFrontMatter,
// splitSentences, parseFenceMarker — 已提取至 ./lib/prose-utils.js

// 判断指定位置是否在对话引号内（用于"不是…而是…"在对话中的合法使用白名单）
function isInsideDialogue(text, position) {
  const before = text.substring(0, position);
  const opens = (before.match(DIALOGUE_OPEN_RE) || []).length;
  const closes = (before.match(DIALOGUE_CLOSE_RE) || []).length;
  if (opens > closes) return true;
  // ASCII 引号：奇数个 = 在引号内
  const asciiQuotes = (before.match(/"/g) || []).length;
  return asciiQuotes % 2 === 1;
}

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
    // 排除反问/推测语气：莫不是 / 岂不是 / 别不是
    if (start > 0 && RHETORICAL_PREFIX.has(text[start - 1])) { offset = start + 2; continue; }
    const candidate = text.slice(start);
    const markerEnd = findPositiveFlipEnd(candidate);
    if (markerEnd === -1) { offset = start + 2; continue; }
    const raw = trimTrailingNoise(extractFinding(candidate, markerEnd));
    if (raw.length >= 4) {
      const position = getPosition(start);
      // 对话中合法使用"不是…而是…"时，降为 advisory 并给出白名单提示
      const inDialogue = isInsideDialogue(text, start);
      if (inDialogue) {
        findings.push({ line: position.line, column: position.column, type: 'not-is-comparison', severity: 'advisory',
          message: '对话中出现"不是…而是…"句式（白名单提示）。对话中可能是角色语言习惯的合法使用，已降为 advisory。如确为角色口语特征可保留，但需确认非叙述语中的 AI 对比句式。',
          excerpt: compact(raw) });
      } else {
        findings.push({ line: position.line, column: position.column, type: 'not-is-comparison', severity: 'blocking',
          message: '高频 AI 对比句式；删掉否定铺垫，直接写后项，或改成动作/细节呈现。', excerpt: compact(raw) });
      }
    }
    offset = start + Math.max(raw.length, 2);
  }
  return findings;
}

// V2.5新增：否定排比三连检测
// 检测"没有…没有…没有…" / "不是…不是…不是…" / "并非…并非…并非…" 以及否定排比+升华句
// 这种句式让所有角色的内心戏听起来一模一样，是AI味"高级感"的核心来源
function scanNegationParallelism(proseLines) {
  var findings = [];
  // 否定排比三连：连续2个以上否定分句构成排比
  // 匹配：没有…，没有…，没有…  / 不是…，不是…，不是…  / 并非…，并非…，并非…
  var negationTrioPattern = /(?:没有|不是|并非)[^，。；！？\n]{2,30}[，](?:没有|不是|并非)[^，。；！？\n]{2,30}[，]/g;
  // 否定排比+升华句：结尾接"而是…"/"只有…"/"那是一种…"
  var negationSublimationPattern = /(?:没有|不是|并非)[^，。；！？\n]{2,60}[，].*?(?:而是|只有|那是一种|那是|只剩|唯有)/g;

  for (var mi = 0; mi < proseLines.length; mi++) {
    var m = proseLines[mi];
    var text = m.text.trim();
    if (!text || isDivider(text) || isStructural(text)) continue;
    var narrative = stripQuoted(text);
    if (visibleLength(narrative) === 0) continue;

    // 检测否定排比三连
    var match;
    negationTrioPattern.lastIndex = 0;
    while ((match = negationTrioPattern.exec(narrative)) !== null) {
      findings.push({
        line: m.lineNo, column: match.index + 1, type: 'negation-parallelism', severity: 'blocking',
        message: '否定排比三连：连续否定分句构成排比（"没有…没有…" / "不是…不是…"），会让所有角色内心戏听起来一模一样。全章容忍度0次。改为：具体动作/场景/对话。',
        excerpt: compact(match[0])
      });
    }

    // 检测否定排比+升华句
    negationSublimationPattern.lastIndex = 0;
    while ((match = negationSublimationPattern.exec(narrative)) !== null) {
      // 避免和上面的trio pattern重复标记
      var alreadyReported = false;
      for (var k = 0; k < findings.length; k++) {
        if (findings[k].line === m.lineNo && findings[k].type === 'negation-parallelism') {
          alreadyReported = true;
          break;
        }
      }
      if (!alreadyReported) {
        findings.push({
          line: m.lineNo, column: match.index + 1, type: 'negation-parallelism', severity: 'blocking',
          message: '否定排比+升华句：否定排比结尾接"而是…"/"只有…"/"那是一种…"，AI味"高级感"标志句式。全章容忍度0次。',
          excerpt: compact(match[0])
        });
      }
    }
  }
  return findings;
}

// V2.5新增：意象/环境/身体反应重复检测
// 检测同一意象词、同一环境要素、同一身体反应在叙述语中重复≥3次(advisory) / ≥5次(blocking)
// 注意：已移除"光/风/呼吸/心跳"等超高频通用词（4000字中必然出现3+次，误报率极高）
function scanImageryRepeat(proseLines) {
  var findings = [];

  // 特异性意象词（非通用词，出现3+次才有检测意义）
  var imageryWords = ['阴影', '光斑', '碎片', '铜钱', '灰尘', '风铃', '钟表', '走针', '裂痕', '裂缝', '回声', '倒影', '水纹', '涟漪', '雾气', '余烬', '锈迹', '裂纹', '碎屑', '残影', '波纹', '寒意', '腥味', '霉味', '焦味', '铁锈味', '潮气', '湿气', '暮色', '晨光', '残阳', '冷月', '烛火', '灯影'];
  // 特异性身体反应（非通用词）
  var bodyReactions = ['后脖颈', '发凉', '手心出汗', '喉结', '指节发白', '脊背', '头皮发麻', '太阳穴', '脉搏', '屏住呼吸', '瞳孔收缩', '嘴角抽搐', '眼皮跳', '牙关紧咬', '掌心湿润', '后背发凉', '膝盖发软', '手指发抖', '胃部痉挛', '胸口发闷'];

  // 收集叙述语文本
  var narrativeTexts = [];
  for (var i = 0; i < proseLines.length; i++) {
    var line = proseLines[i];
    var text = line.text.trim();
    if (!text || isDivider(text) || isStructural(text)) continue;
    var narrative = stripQuoted(text);
    if (visibleLength(narrative) === 0) continue;
    narrativeTexts.push({ text: narrative, lineNo: line.lineNo });
  }

  // 检测意象重复（≥3 advisory, ≥5 blocking）
  for (var wi = 0; wi < imageryWords.length; wi++) {
    var word = imageryWords[wi];
    var count = 0;
    var firstLine = -1;
    for (var ni = 0; ni < narrativeTexts.length; ni++) {
      if (narrativeTexts[ni].text.indexOf(word) !== -1) {
        count++;
        if (firstLine === -1) firstLine = narrativeTexts[ni].lineNo;
      }
    }
    if (count >= 3) {
      var severity = count >= 5 ? 'blocking' : 'advisory';
      findings.push({
        line: firstLine, column: 1, type: 'imagery-repeat', severity: severity,
        message: '意象重复：「' + word + '」在叙述语中出现' + count + '次' + (count >= 5 ? '（≥5，削弱描写力量严重）' : '（≥3）') + '。保留第1次，第2次换表达，第3次起删除或换不同意象。',
        excerpt: '意象"' + word + '"出现' + count + '次'
      });
    }
  }

  // 检测身体反应重复（≥3 advisory, ≥5 blocking）
  for (var bi = 0; bi < bodyReactions.length; bi++) {
    var reaction = bodyReactions[bi];
    var rCount = 0;
    var rFirstLine = -1;
    for (var nj = 0; nj < narrativeTexts.length; nj++) {
      if (narrativeTexts[nj].text.indexOf(reaction) !== -1) {
        rCount++;
        if (rFirstLine === -1) rFirstLine = narrativeTexts[nj].lineNo;
      }
    }
    if (rCount >= 3) {
      var rSeverity = rCount >= 5 ? 'blocking' : 'advisory';
      findings.push({
        line: rFirstLine, column: 1, type: 'imagery-repeat', severity: rSeverity,
        message: '身体反应重复：「' + reaction + '」在叙述语中出现' + rCount + '次' + (rCount >= 5 ? '（≥5，角色生理反应模式化严重）' : '（≥3）') + '。同一角色最多保留2次，超出换不同的生理反应。',
        excerpt: '身体反应"' + reaction + '"出现' + rCount + '次'
      });
    }
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

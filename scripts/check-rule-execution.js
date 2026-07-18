#!/usr/bin/env node
'use strict';

/**
 * check-rule-execution.js — 规则执行遥测
 *
 * 扫描正文文件，对照 samples/config/rules.json 中的规则清单，统计每条规则的执行情况。
 * 对可内联检测的规则调用 prose-utils.js 的检测函数；对需要外部脚本或人工检查的规则
 * 标记为 skipped。
 *
 * 输出结构化遥测报告：
 *   total_rules_checked / rules_passed / rules_failed / rules_skipped / execution_rate
 * 每条失败规则输出：rule_id / rule_name / actual_value / threshold / severity
 *
 * 将遥测结果写入 追踪/rule-execution-telemetry.json（追加模式，每章一条记录）。
 *
 * 用法：node check-rule-execution.js [--json] [--chapter=N] [--project=<path>] [--rules=<path>] <file...>
 * 只报告不修改（遥测文件除外，遥测文件为追加写入）。
 *
 * Exit codes: 0=全部通过, 1=有warning(advisory), 2=有blocking error或文件读取失败
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
  detectParallelismAbuse,
  detectVagueTimeJump,
  detectClichedAppearance,
  detectBreathyDialogueTags,
  detectTransitionStacking,
  TTR_THRESHOLD,
  BURSTINESS_CV_THRESHOLD,
  METAPHOR_DENSITY_BLOCK,
} = require('./lib/prose-utils.js');

const USAGE = `Usage: node check-rule-execution.js [--json] [--chapter=N] [--project=<path>] [--rules=<path>] <file...>

Scan prose files against rules.json checklist, output structured execution telemetry.
  --json          output JSON to stdout
  --chapter=N     chapter number for telemetry record
  --project=<path> project root (default: cwd) — telemetry written to <project>/追踪/
  --rules=<path>  path to rules.json (default: <skill>/samples/config/rules.json)

Report-only. Telemetry file is append-only.`;

// ════════════════════════════════════════════════════════════
//  内联检测词表（与 check-ai-patterns.js 保持一致）
// ════════════════════════════════════════════════════════════

// 比喻明喻模式
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

// AI 高频连接词
const AI_CONNECTOR_WORDS = [
  '然而', '此外', '与此同时', '值得注意的是', '综上所述',
  '不可否认', '毋庸置疑', '总而言之', '换言之',
];

// 情绪词直给词表
const AI_EMOTION_WORDS = [
  '悲伤', '愤怒', '绝望', '心碎', '痛苦', '震惊', '恐惧', '哀伤',
  '悲凉', '凄凉', '心酸', '心寒', '胆寒', '震撼', '震怒', '狂怒',
  '悲愤', '哀怨', '忧伤', '惶恐', '惊恐', '惶惑', '焦灼', '焦躁',
];

// 解释腔预警词（A级，零容忍）
const EXPLANATION_TONE_WORDS = [
  '意味着', '是因为', '这说明', '他发现', '他心里明白', '他在等',
  '他意识到', '显然', '可见', '看出规律', '异乎寻常',
];

// 破折号正则
const EM_DASH_PATTERN = /——|—|--+/g;

// 比喻密度告警阈值（每千字）
const METAPHOR_DENSITY_WARN = 3.0;

// ════════════════════════════════════════════════════════════
//  参数解析
// ════════════════════════════════════════════════════════════

const options = {
  json: false,
  chapter: null,
  project: process.cwd(),
  rulesPath: null,
  files: [],
};

for (let i = 2; i < process.argv.length; i += 1) {
  const arg = process.argv[i];
  if (arg === '--json') {
    options.json = true;
  } else if (arg.startsWith('--chapter=')) {
    options.chapter = parseInt(arg.slice('--chapter='.length), 10) || null;
  } else if (arg.startsWith('--project=')) {
    options.project = path.resolve(arg.slice('--project='.length));
  } else if (arg.startsWith('--rules=')) {
    options.rulesPath = path.resolve(arg.slice('--rules='.length));
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

// ════════════════════════════════════════════════════════════
//  辅助函数
// ════════════════════════════════════════════════════════════

function die(message) {
  console.error(message);
  console.error(USAGE.trimEnd());
  process.exit(2);
}

/**
 * 从文件内容中提取纯正文行（去除 YAML front matter / 代码块 / 结构性标记）
 */
function extractProseLines(input) {
  const lines = input.split(/\r?\n/);
  const proseLines = [];
  let fence = null;
  let inFrontMatter = hasYamlFrontMatter(lines);

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const trimmed = line.trim();
    if (inFrontMatter) {
      if (index > 0 && trimmed === '---') inFrontMatter = false;
      continue;
    }
    const fenceMarker = parseFenceMarker(trimmed);
    if (fence) {
      if (fenceMarker && fenceMarker.char === fence.char && fenceMarker.length >= fence.length) fence = null;
      continue;
    }
    if (fenceMarker) { fence = fenceMarker; continue; }
    proseLines.push({ text: line, lineNo: index + 1 });
  }
  return proseLines;
}

/**
 * 拼接全文叙述文本（去除对话）
 */
function buildNarrativeText(proseLines) {
  let fullText = '';
  for (const { text } of proseLines) {
    const trimmed = text.trim();
    if (!trimmed || isDivider(trimmed) || isStructural(trimmed)) continue;
    const narrative = stripQuoted(trimmed);
    if (visibleLength(narrative) > 0) fullText += narrative;
  }
  return fullText;
}

/**
 * 统计词在叙述文本中出现次数
 */
function countWordOccurrences(text, word) {
  let count = 0;
  let idx = text.indexOf(word);
  while (idx !== -1) {
    count += 1;
    idx = text.indexOf(word, idx + word.length);
  }
  return count;
}

/**
 * 统计破折号数量
 */
function countEmDashes(proseLines) {
  let count = 0;
  for (const { text } of proseLines) {
    const trimmed = text.trim();
    if (!trimmed || isDivider(trimmed) || isStructural(trimmed)) continue;
    EM_DASH_PATTERN.lastIndex = 0;
    let match;
    while ((match = EM_DASH_PATTERN.exec(text)) !== null) {
      count += 1;
    }
  }
  return count;
}

/**
 * 统计比喻句数量和密度
 */
function countMetaphors(proseLines) {
  let totalChars = 0;
  let metaphorCount = 0;
  for (const { text } of proseLines) {
    const trimmed = text.trim();
    if (!trimmed || isDivider(trimmed) || isStructural(trimmed)) continue;
    const narrative = stripQuoted(trimmed);
    if (visibleLength(narrative) === 0) continue;
    totalChars += visibleLength(narrative);
    for (const pattern of SIMILE_PATTERNS) {
      pattern.lastIndex = 0;
      let match;
      while ((match = pattern.exec(narrative)) !== null) {
        metaphorCount += 1;
      }
    }
  }
  const density = totalChars > 0 ? (metaphorCount / (totalChars / 1000)) : 0;
  return { count: metaphorCount, density, totalChars };
}

// ════════════════════════════════════════════════════════════
//  规则检测器映射
//  每个检测器返回: { passed: boolean, actual_value: any, threshold: any,
//                   severity: string, details: string }
// ════════════════════════════════════════════════════════════

const ruleCheckers = {
  // R001: 否定排比拦截 — detectParallelismAbuse
  R001: function (proseLines, fullText) {
    const result = detectParallelismAbuse(fullText);
    const passed = !result.detected;
    return {
      passed,
      actual_value: result.count,
      threshold: 0,
      severity: passed ? 'info' : result.severity,
      details: passed ? '无否定排比句式' : `检测到${result.count}处否定排比/排比滥用`,
    };
  },

  // R002: 破折号复读检测 — em-dash count ≤ 4
  R002: function (proseLines) {
    const count = countEmDashes(proseLines);
    const passed = count <= 4;
    let severity = 'info';
    if (count >= 8) severity = 'blocking';
    else if (count >= 5) severity = 'advisory';
    return {
      passed,
      actual_value: count,
      threshold: 4,
      severity,
      details: passed ? `破折号${count}处（≤4合规）` : `破折号${count}处（超限≤4）`,
    };
  },

  // R003: 比喻质量三重门 — 比喻密度 ≤ 3/千字
  R003: function (proseLines) {
    const { count, density } = countMetaphors(proseLines);
    const passed = density <= METAPHOR_DENSITY_WARN;
    let severity = 'info';
    if (density > METAPHOR_DENSITY_BLOCK) severity = 'blocking';
    else if (density > METAPHOR_DENSITY_WARN) severity = 'advisory';
    return {
      passed,
      actual_value: parseFloat(density.toFixed(2)),
      threshold: METAPHOR_DENSITY_WARN,
      severity,
      details: passed ? `比喻密度${density.toFixed(1)}/千字（≤3合规）` : `比喻密度${density.toFixed(1)}/千字（超标）`,
    };
  },

  // R005: 解释腔检测 — A级预警词零容忍
  R005: function (proseLines, fullText) {
    const narrative = buildNarrativeText(proseLines);
    let totalCount = 0;
    const foundWords = [];
    for (const word of EXPLANATION_TONE_WORDS) {
      const c = countWordOccurrences(narrative, word);
      if (c > 0) {
        totalCount += c;
        foundWords.push(`${word}(${c})`);
      }
    }
    const passed = totalCount === 0;
    return {
      passed,
      actual_value: totalCount,
      threshold: 0,
      severity: passed ? 'info' : 'blocking',
      details: passed ? '无解释腔预警词' : `解释腔预警词：${foundWords.join(', ')}`,
    };
  },

  // R006: 套话检测 — AI高频连接词
  R006: function (proseLines) {
    const narrative = buildNarrativeText(proseLines);
    let totalCount = 0;
    const foundWords = [];
    for (const word of AI_CONNECTOR_WORDS) {
      const c = countWordOccurrences(narrative, word);
      if (c > 0) {
        totalCount += c;
        foundWords.push(`${word}(${c})`);
      }
    }
    const passed = totalCount === 0;
    return {
      passed,
      actual_value: totalCount,
      threshold: 0,
      severity: passed ? 'info' : 'advisory',
      details: passed ? '无AI高频连接词' : `AI套话词：${foundWords.join(', ')}`,
    };
  },

  // R009: burstiness检测 — CV ≥ 0.35
  R009: function (proseLines) {
    const allSentences = [];
    for (const { text } of proseLines) {
      const trimmed = text.trim();
      if (!trimmed || isDivider(trimmed) || isStructural(trimmed)) continue;
      const narrative = stripQuoted(trimmed);
      if (visibleLength(narrative) === 0) continue;
      for (const sentence of splitSentences(narrative)) {
        if (visibleLength(sentence) > 0) allSentences.push(sentence);
      }
    }
    if (allSentences.length < 8) {
      return { passed: true, actual_value: 'N/A', threshold: BURSTINESS_CV_THRESHOLD, severity: 'info', details: '句子数不足8，跳过burstiness检测' };
    }
    const { cv } = calculateBurstiness(allSentences);
    const passed = cv >= BURSTINESS_CV_THRESHOLD;
    let severity = 'info';
    if (cv < BURSTINESS_CV_THRESHOLD) severity = 'blocking';
    else if (cv < 0.5) severity = 'advisory';
    return {
      passed,
      actual_value: parseFloat(cv.toFixed(2)),
      threshold: BURSTINESS_CV_THRESHOLD,
      severity,
      details: passed ? `CV=${cv.toFixed(2)}（≥${BURSTINESS_CV_THRESHOLD}合规）` : `CV=${cv.toFixed(2)}（<${BURSTINESS_CV_THRESHOLD}突发度不足）`,
    };
  },

  // R010: 情绪词密度 — 情绪词直给检测
  R010: function (proseLines) {
    const narrative = buildNarrativeText(proseLines);
    let totalCount = 0;
    const foundWords = [];
    for (const word of AI_EMOTION_WORDS) {
      const c = countWordOccurrences(narrative, word);
      if (c > 0) {
        totalCount += c;
        foundWords.push(`${word}(${c})`);
      }
    }
    // 每章情绪词直给 ≤ 2次为合规（advisory级别），>2为超标
    const passed = totalCount <= 2;
    return {
      passed,
      actual_value: totalCount,
      threshold: 2,
      severity: passed ? 'info' : 'advisory',
      details: passed ? `情绪词直给${totalCount}处（≤2合规）` : `情绪词直给${totalCount}处：${foundWords.join(', ')}`,
    };
  },

  // R013: 退化检测 — 段首词重复 + 句式模板化
  R013: function (proseLines) {
    // 检测连续3+段以相同词开头
    const paraStarts = [];
    for (const { text } of proseLines) {
      const trimmed = text.trim();
      if (!trimmed || isDivider(trimmed) || isStructural(trimmed)) continue;
      const narrative = stripQuoted(trimmed);
      if (visibleLength(narrative) === 0) continue;
      const firstChars = narrative.slice(0, 2);
      paraStarts.push(firstChars);
    }
    let repeatCount = 0;
    for (let i = 0; i + 2 < paraStarts.length; i += 1) {
      if (paraStarts[i] === paraStarts[i + 1] && paraStarts[i + 1] === paraStarts[i + 2]) {
        repeatCount += 1;
      }
    }
    // 同时检测模糊时间跳跃词
    const fullText = proseLines.map(p => p.text).join('\n');
    const timeJumpResult = detectVagueTimeJump(fullText);
    const totalIssues = repeatCount + timeJumpResult.count;
    const passed = repeatCount === 0 && timeJumpResult.count < 2;
    return {
      passed,
      actual_value: totalIssues,
      threshold: 0,
      severity: passed ? 'info' : 'advisory',
      details: passed ? '无退化模式' : `段首重复${repeatCount}处, 模糊时间词${timeJumpResult.count}处`,
    };
  },

  // R018: TTR词汇多样性检测 — minWindowTTR ≥ 0.25
  R018: function (proseLines) {
    let fullText = '';
    for (const { text } of proseLines) {
      const trimmed = text.trim();
      if (!trimmed || isDivider(trimmed) || isStructural(trimmed)) continue;
      fullText += trimmed;
    }
    if (fullText.length < 200) {
      return { passed: true, actual_value: 'N/A', threshold: TTR_THRESHOLD, severity: 'info', details: '文本不足200字，跳过TTR检测' };
    }
    const { overallTTR, minWindowTTR } = calculateTTR(fullText);
    const passed = minWindowTTR >= TTR_THRESHOLD;
    return {
      passed,
      actual_value: parseFloat(minWindowTTR.toFixed(2)),
      threshold: TTR_THRESHOLD,
      severity: passed ? 'info' : 'advisory',
      details: passed ? `minWindowTTR=${minWindowTTR.toFixed(2)}（≥${TTR_THRESHOLD}合规）` : `minWindowTTR=${minWindowTTR.toFixed(2)}（<${TTR_THRESHOLD}词汇多样性偏低）`,
    };
  },

  // R019: AI过渡句模式检测 — 过渡词 < 5处
  R019: function (proseLines) {
    const narrative = buildNarrativeText(proseLines);
    if (narrative.length < 200) {
      return { passed: true, actual_value: 0, threshold: 5, severity: 'info', details: '文本不足200字，跳过过渡句检测' };
    }
    const { count } = detectTransitionPatterns(narrative);
    const passed = count < 5;
    return {
      passed,
      actual_value: count,
      threshold: 5,
      severity: passed ? 'info' : 'advisory',
      details: passed ? `过渡词${count}处（<5合规）` : `过渡词${count}处（≥5模式化）`,
    };
  },

  // R020: 信息密度均匀性检测 — 方差 ≥ 0.002
  R020: function (proseLines) {
    let fullText = '';
    for (const { text } of proseLines) {
      const trimmed = text.trim();
      if (!trimmed || isDivider(trimmed) || isStructural(trimmed)) continue;
      fullText += trimmed;
    }
    if (fullText.length < 1000) {
      return { passed: true, actual_value: 'N/A', threshold: 0.002, severity: 'info', details: '文本不足1000字，跳过信息密度检测' };
    }
    const { variance } = calculateInfoDensityVariance(fullText);
    const passed = variance >= 0.002;
    return {
      passed,
      actual_value: parseFloat(variance.toFixed(4)),
      threshold: 0.002,
      severity: passed ? 'info' : 'advisory',
      details: passed ? `信息密度方差=${variance.toFixed(4)}（≥0.002合规）` : `信息密度方差=${variance.toFixed(4)}（<0.002过于均匀）`,
    };
  },
};

// 需要外部脚本的规则 → 标记为 skipped
const EXTERNAL_SCRIPT_RULES = new Set([
  'R007', // extract-used-patterns.js
  'R008', // compress-handoff.js
  'R011', // check-consistency.js
  'R012', // check-rhythm.js
  'R014', // normalize-punctuation.js
  'R021', // check-quality-score.js
  'R022', // check-style-consistency.js
]);

// 需要人工检查的规则 → 标记为 skipped
const MANUAL_CHECK_RULES = new Set([
  'R004', // 情绪锚点密度检查
  'R015', // 用户情绪锚点
  'R016', // 冲突四件套检查
  'R017', // 锐度保护清单
  'R023', // 章中钩子
  'R024', // 读者留存预警
]);

// ════════════════════════════════════════════════════════════
//  主流程
// ════════════════════════════════════════════════════════════

function main() {
  // 定位 rules.json
  const rulesPath = options.rulesPath || path.join(__dirname, '..', 'samples', 'config', 'rules.json');
  let rulesConfig;
  try {
    let raw = fs.readFileSync(rulesPath, 'utf8');
    // 剥离 UTF-8 BOM
    if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
    rulesConfig = JSON.parse(raw);
  } catch (error) {
    die(`Unable to read rules.json at ${rulesPath}: ${error.message}`);
  }

  const rules = rulesConfig.rules || [];

  // 读取并合并所有正文文件
  let combinedProseLines = [];
  let combinedFullText = '';
  let fileReadFailed = false;
  for (const file of options.files) {
    const fullPath = path.resolve(file);
    let input;
    try {
      input = fs.readFileSync(fullPath, 'utf8');
    } catch (error) {
      fileReadFailed = true;
      if (!options.json) console.error(`${file}: unable to read (${error.message})`);
      continue;
    }
    const proseLines = extractProseLines(input);
    combinedProseLines.push(...proseLines);
    combinedFullText += proseLines.map(p => p.text).join('\n') + '\n';
  }

  if (fileReadFailed && combinedProseLines.length === 0) {
    process.exit(2);
  }

  // 逐条规则检测
  const results = [];
  let rulesPassed = 0;
  let rulesFailed = 0;
  let rulesSkipped = 0;
  let hasBlocking = false;
  let hasAdvisory = false;

  for (const rule of rules) {
    if (!rule.enabled) {
      results.push({
        rule_id: rule.id,
        rule_name: rule.name,
        status: 'disabled',
        severity: 'info',
        details: '规则已禁用',
      });
      continue;
    }

    const result = {
      rule_id: rule.id,
      rule_name: rule.name,
      step: rule.step || '',
      gate: rule.gate || null,
      script: rule.script || null,
    };

    if (EXTERNAL_SCRIPT_RULES.has(rule.id)) {
      result.status = 'skipped';
      result.reason = 'requires_external_script';
      result.severity = 'info';
      result.details = `需要外部脚本: ${rule.script || '未知'}`;
      rulesSkipped += 1;
    } else if (MANUAL_CHECK_RULES.has(rule.id)) {
      result.status = 'skipped';
      result.reason = 'manual_check_required';
      result.severity = 'info';
      result.details = '需要人工/LLM检查';
      rulesSkipped += 1;
    } else if (ruleCheckers[rule.id]) {
      try {
        const checkResult = ruleCheckers[rule.id](combinedProseLines, combinedFullText);
        result.status = checkResult.passed ? 'passed' : 'failed';
        result.actual_value = checkResult.actual_value;
        result.threshold = checkResult.threshold;
        result.severity = checkResult.severity;
        result.details = checkResult.details;
        if (checkResult.passed) {
          rulesPassed += 1;
        } else {
          rulesFailed += 1;
          if (checkResult.severity === 'blocking') hasBlocking = true;
          else if (checkResult.severity === 'advisory') hasAdvisory = true;
        }
      } catch (error) {
        result.status = 'skipped';
        result.reason = 'check_error';
        result.severity = 'info';
        result.details = `检测异常: ${error.message}`;
        rulesSkipped += 1;
      }
    } else {
      result.status = 'skipped';
      result.reason = 'no_checker_defined';
      result.severity = 'info';
      result.details = '未定义检测器';
      rulesSkipped += 1;
    }

    results.push(result);
  }

  const totalChecked = rulesPassed + rulesFailed;
  const executionRate = totalChecked > 0 ? parseFloat(((rulesPassed / totalChecked) * 100).toFixed(1)) : 0;

  const telemetry = {
    timestamp: new Date().toISOString(),
    chapter: options.chapter,
    files: options.files.map(f => path.basename(f)),
    summary: {
      total_rules: rules.length,
      total_rules_checked: totalChecked,
      rules_passed: rulesPassed,
      rules_failed: rulesFailed,
      rules_skipped: rulesSkipped,
      rules_disabled: rules.filter(r => !r.enabled).length,
      execution_rate: executionRate,
      has_blocking: hasBlocking,
      has_advisory: hasAdvisory,
    },
    results: results,
  };

  // 写入遥测文件（追加模式）
  const telemetryDir = path.join(options.project, '追踪');
  const telemetryPath = path.join(telemetryDir, 'rule-execution-telemetry.json');
  try {
    if (!fs.existsSync(telemetryDir)) {
      fs.mkdirSync(telemetryDir, { recursive: true });
    }
    let existing = [];
    if (fs.existsSync(telemetryPath)) {
      try {
        existing = JSON.parse(fs.readFileSync(telemetryPath, 'utf8'));
        if (!Array.isArray(existing)) existing = [existing];
      } catch (_e) {
        existing = [];
      }
    }
    existing.push(telemetry);
    fs.writeFileSync(telemetryPath, JSON.stringify(existing, null, 2), 'utf8');
    if (!options.json) {
      console.log(`遥测记录已追加至: ${telemetryPath}`);
    }
  } catch (error) {
    if (!options.json) {
      console.error(`警告: 无法写入遥测文件 ${telemetryPath}: ${error.message}`);
    }
  }

  // 输出报告
  if (options.json) {
    process.stdout.write(`${JSON.stringify(telemetry, null, 2)}\n`);
  } else {
    console.log('═══════════════════════════════════════════════════════');
    console.log('  规则执行遥测报告');
    console.log('═══════════════════════════════════════════════════════');
    console.log(`扫描文件: ${options.files.join(', ')}`);
    console.log(`章节编号: ${options.chapter || '未指定'}`);
    console.log(`扫描时间: ${telemetry.timestamp}`);
    console.log('');
    console.log('── 汇总 ──');
    console.log(`  规则总数:     ${telemetry.summary.total_rules}`);
    console.log(`  已检测:       ${telemetry.summary.total_rules_checked}`);
    console.log(`  通过:         ${telemetry.summary.rules_passed}`);
    console.log(`  失败:         ${telemetry.summary.rules_failed}`);
    console.log(`  跳过:         ${telemetry.summary.rules_skipped}`);
    console.log(`  已禁用:       ${telemetry.summary.rules_disabled}`);
    console.log(`  执行通过率:   ${telemetry.summary.execution_rate}%`);
    console.log(`  blocking:     ${hasBlocking ? '是' : '否'}`);
    console.log(`  advisory:     ${hasAdvisory ? '是' : '否'}`);
    console.log('');

    const failedRules = results.filter(r => r.status === 'failed');
    if (failedRules.length > 0) {
      console.log('── 失败规则 ──');
      for (const r of failedRules) {
        console.log(`  [${r.severity.toUpperCase()}] ${r.rule_id} ${r.rule_name}`);
        console.log(`    实际值: ${r.actual_value}  阈值: ${r.threshold}`);
        console.log(`    详情: ${r.details}`);
      }
      console.log('');
    }

    const skippedRules = results.filter(r => r.status === 'skipped');
    if (skippedRules.length > 0) {
      console.log('── 跳过规则 ──');
      for (const r of skippedRules) {
        console.log(`  ${r.rule_id} ${r.rule_name}: ${r.details}`);
      }
      console.log('');
    }

    if (rulesFailed === 0) {
      console.log('✅ 所有可检测规则均通过。');
    } else if (hasBlocking) {
      console.log(`🔴 检测到 blocking 级别失败 (${failedRules.filter(r => r.severity === 'blocking').length} 条)。`);
    } else {
      console.log(`🟡 检测到 advisory 级别警告 (${failedRules.filter(r => r.severity === 'advisory').length} 条)。`);
    }
  }

  // Exit code
  if (fileReadFailed) process.exit(2);
  if (hasBlocking) process.exit(2);
  if (hasAdvisory) process.exit(1);
  process.exit(0);
}

main();

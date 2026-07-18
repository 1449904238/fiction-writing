#!/usr/bin/env node
'use strict';

/**
 * merge-findings.js — 多 Agent Findings 自动仲裁合并脚本（V5.4 新增）
 *
 * 将 09 多视角审稿师 4 个 Agent 的 Findings YAML/JSON 自动合并并仲裁。
 * 仲裁规则：
 *   - blocking 级：任意 Agent 提出 → 标记"需修改"（一票否决）
 *   - advisory 级：≥2 个 Agent 提出 → 标记"建议修改"（多数票）
 *   - info 级：≥3 个 Agent 提出 → 标记"关注"（多数票）
 *
 * 综合评分公式：
 *   综合得分 = 编辑×30% + AI鉴定×25% + 读者×25% + 商业×20%
 *
 * 用法：
 *   node merge-findings.js --dir=<findings目录>
 *   node merge-findings.js --files=<f1.json>,<f2.json>,<f3.json>,<f4.json>
 *   node merge-findings.js --dir=<findings目录> --json
 *
 * 退出码：0=合并成功，1=有blocking问题，2=参数/运行错误
 */

const fs = require('fs');
const path = require('path');

const USAGE = `Usage: node merge-findings.js --dir=<findings目录>
       node merge-findings.js --files=<f1.json>,<f2.json>,<f3.json>,<f4.json>
       node merge-findings.js --dir=<findings目录> --json

多 Agent Findings 自动仲裁合并脚本（V5.4）。
将 09 多视角审稿师 4 个 Agent（story-editor/ai-detector/reader/commercial）的
Findings JSON 自动合并并仲裁，减少主线程手动判断。

Options:
  --dir=DIR       findings 目录（读取目录下所有 *.json 文件）
  --files=F1,F2   逗号分隔的 findings JSON 文件列表
  --json          输出合并后的 JSON（符合 findings.schema.json 格式）
  -h, --help      显示帮助

仲裁规则：
  blocking  任意 Agent 提出 → 需修改（一票否决）
  advisory  ≥2 个 Agent 提出 → 建议修改（多数票）
  info      ≥3 个 Agent 提出 → 关注（多数票）

退出码：0=合并成功，1=有blocking问题，2=参数/运行错误`;

// ============================================================
//  常量定义
// ============================================================

/**
 * 综合评分权重（与 09_多视角审稿师.md 一致）
 * editor=story-editor 编辑视角 / ai-detector=AI鉴定 / reader=读者视角 / commercial=商业化
 */
const WEIGHTS = { editor: 0.30, 'ai-detector': 0.25, reader: 0.25, commercial: 0.20 };

/** severity 严重程度排序（数值越大越严重） */
const SEVERITY_RANK = { blocking: 3, advisory: 2, info: 1 };

/** 有效的 Agent 来源标识 */
const VALID_SOURCES = ['editor', 'ai-detector', 'reader', 'commercial'];

/** Agent 来源中文名映射（用于人类可读输出） */
const SOURCE_LABELS = {
  editor: '编辑视角',
  'ai-detector': 'AI鉴定',
  reader: '读者视角',
  commercial: '商业化',
};

/** 有效的问题类别（与 findings.schema.json enum 一致） */
const VALID_CATEGORIES = [
  'plot', 'character', 'prose', 'consistency', 'commercial', 'consistency_audit',
];

/** 评分阈值（与 findings.schema.json threshold 一致） */
const SCORE_THRESHOLDS = { fast: 80, full: 60, rewrite: 60 };

/** objective_details 五维度及其满分（与 findings.schema.json 一致） */
const DIMENSION_MAX = {
  plot_propulsion: 15,
  rhythm_control: 15,
  texture_density: 10,
  character_consistency: 10,
  ai_baseline: 10,
};

// ============================================================
//  CLI 参数解析
// ============================================================

/**
 * 解析命令行参数
 * @param {string[]} argv - process.argv
 * @returns {{dir: string|null, files: string[]|null, json: boolean}}
 */
function parseArgs(argv) {
  const opts = { dir: null, files: null, json: false };
  const args = argv.slice(2);

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];

    if (arg === '-h' || arg === '--help') {
      process.stdout.write(`${USAGE}\n`);
      process.exit(0);
    }

    if (arg.startsWith('--dir=')) {
      opts.dir = arg.slice('--dir='.length);
    } else if (arg === '--dir') {
      opts.dir = args[++i] || null;
    } else if (arg.startsWith('--files=')) {
      opts.files = arg.slice('--files='.length)
        .split(',')
        .map(f => f.trim())
        .filter(f => f.length > 0);
    } else if (arg === '--files') {
      const raw = args[++i] || '';
      opts.files = raw.split(',').map(f => f.trim()).filter(f => f.length > 0);
    } else if (arg === '--json') {
      opts.json = true;
    }
  }

  if (!opts.dir && !opts.files) {
    console.error('Error: --dir 或 --files 至少需要指定一个');
    console.error(USAGE);
    process.exit(2);
  }

  if (opts.dir && opts.files) {
    console.error('Error: --dir 和 --files 不可同时使用');
    console.error(USAGE);
    process.exit(2);
  }

  return opts;
}

// ============================================================
//  JSON 加载与校验
// ============================================================

/**
 * 安全加载 JSON 文件
 * @param {string} filePath - 文件绝对路径
 * @param {string} label - 文件标签（用于错误消息）
 * @returns {{ok: boolean, data: Object|null, error: string|null}}
 */
function loadJSON(filePath, label) {
  if (!fs.existsSync(filePath)) {
    return { ok: false, data: null, error: `${label} 文件不存在: ${filePath}` };
  }
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return { ok: true, data: JSON.parse(raw), error: null };
  } catch (e) {
    return { ok: false, data: null, error: `${label} JSON 解析失败 (${filePath}): ${e.message}` };
  }
}

/**
 * 校验单个 Agent 的 Findings JSON 基本结构
 * 必须包含 chapter_no / step / findings / score 字段（与 findings.schema.json required 一致）
 * @param {Object} data - 解析后的 JSON 对象
 * @param {string} filePath - 文件路径（用于错误消息）
 * @returns {string[]} - 错误消息数组（空数组表示通过）
 */
function validateFindingsStructure(data, filePath) {
  const errors = [];
  const label = path.basename(filePath);

  if (!data || typeof data !== 'object') {
    errors.push(`${label}: 根节点不是对象`);
    return errors;
  }

  const required = ['chapter_no', 'step', 'findings', 'score'];
  for (const field of required) {
    if (!(field in data)) {
      errors.push(`${label}: 缺少必填字段 "${field}"`);
    }
  }

  if (data.findings !== undefined && !Array.isArray(data.findings)) {
    errors.push(`${label}: "findings" 字段必须是数组`);
  }

  if (data.chapter_no !== undefined && typeof data.chapter_no !== 'number') {
    errors.push(`${label}: "chapter_no" 字段必须是整数`);
  }

  // 校验每条 finding 的基本字段
  if (Array.isArray(data.findings)) {
    data.findings.forEach((f, i) => {
      if (!f || typeof f !== 'object') {
        errors.push(`${label}: findings[${i}] 不是对象`);
        return;
      }
      if (!f.severity || !SEVERITY_RANK.hasOwnProperty(f.severity)) {
        errors.push(`${label}: findings[${i}].severity 无效 (期望 blocking|advisory|info)`);
      }
      if (!f.category) {
        errors.push(`${label}: findings[${i}].category 缺失`);
      }
      if (!f.issue || typeof f.issue !== 'string') {
        errors.push(`${label}: findings[${i}].issue 缺失或非字符串`);
      }
    });
  }

  return errors;
}

// ============================================================
//  Agent 来源识别
// ============================================================

/**
 * 根据 findings 的 source 字段或文件名识别 Agent 来源
 * 优先级：findings.source 字段 > 文件名匹配
 * @param {string} filePath - 文件路径
 * @param {Object} data - 解析后的 JSON
 * @returns {string|null} - Agent 来源标识，无法识别返回 null
 */
function identifySource(filePath, data) {
  // 1. 优先从 findings 的 source 字段推断（取出现最多的有效来源）
  if (Array.isArray(data.findings) && data.findings.length > 0) {
    const counts = {};
    for (const f of data.findings) {
      if (f && typeof f.source === 'string') {
        // source 可能是合并格式 "editor+reader"，拆分后逐一统计
        for (const part of f.source.split('+')) {
          const trimmed = part.trim();
          if (VALID_SOURCES.includes(trimmed)) {
            counts[trimmed] = (counts[trimmed] || 0) + 1;
          }
        }
      }
    }
    const entries = Object.entries(counts);
    if (entries.length > 0) {
      entries.sort((a, b) => b[1] - a[1]);
      return entries[0][0];
    }
  }

  // 2. 回退到文件名匹配
  const base = path.basename(filePath, '.json').toLowerCase();
  if (base.includes('story-editor') || base.includes('editor')) return 'editor';
  if (base.includes('ai-detector') || base.includes('aidetector') || base.includes('ai_detector')) return 'ai-detector';
  if (base.includes('reader')) return 'reader';
  if (base.includes('commercial')) return 'commercial';

  // 3. 无法识别
  return null;
}

// ============================================================
//  评分提取
// ============================================================

/**
 * 从 score 字段提取 0-100 的数值评分
 * 兼容三种格式：
 *   - 纯数字（0-100）
 *   - 对象含 total_score（0-100）
 *   - 对象含 objective_score(0-60) + llm_subjective_score(0-40)
 * @param {*} scoreField - score 字段值
 * @returns {number|null} - 0-100 的评分，无法提取返回 null
 */
function extractScoreValue(scoreField) {
  if (typeof scoreField === 'number') {
    return scoreField;
  }
  if (scoreField && typeof scoreField === 'object') {
    if (typeof scoreField.total_score === 'number') {
      return scoreField.total_score;
    }
    const obj = typeof scoreField.objective_score === 'number' ? scoreField.objective_score : 0;
    const subj = typeof scoreField.llm_subjective_score === 'number' ? scoreField.llm_subjective_score : 0;
    if (typeof scoreField.objective_score === 'number' || typeof scoreField.llm_subjective_score === 'number') {
      return obj + subj;
    }
  }
  return null;
}

/**
 * 从 score 对象中提取 objective_details（如果存在）
 * @param {*} scoreField - score 字段值
 * @returns {Object|null}
 */
function extractObjectiveDetails(scoreField) {
  if (scoreField && typeof scoreField === 'object' && scoreField.objective_details) {
    return scoreField.objective_details;
  }
  return null;
}

// ============================================================
//  仲裁核心逻辑
// ============================================================

/**
 * 将所有 Agent 的 findings 按 category 分组
 * @param {Array<{source: string, findings: Object[]}>} agentFindings - 各 Agent 的 findings
 * @returns {Object<string, Array<{source: string, finding: Object}>>} - 按 category 分组的列表
 */
function groupByCategory(agentFindings) {
  const groups = {};

  for (const { source, findings } of agentFindings) {
    if (!Array.isArray(findings)) continue;
    for (const finding of findings) {
      if (!finding || !finding.category) continue;
      const cat = finding.category;
      if (!groups[cat]) groups[cat] = [];
      groups[cat].push({ source, finding });
    }
  }

  return groups;
}

/**
 * 对单个 category 分组执行仲裁，返回合并后的 finding
 *
 * 仲裁规则（按 distinct Agent 计数）：
 *   - 任意 Agent 提出 blocking → severity=blocking（一票否决）
 *   - ≥2 个 Agent 提出 advisory（且无 blocking）→ severity=advisory（多数票）
 *   - ≥3 个 Agent 提出 info（且无 blocking、advisory 不达标）→ severity=info（多数票）
 *   - 以上都不满足 → 取当前最高 severity，标记"少数意见"
 *
 * @param {string} category - 问题类别
 * @param {Array<{source: string, finding: Object}>} group - 该类别下所有 findings
 * @returns {Object} - 合并后的 finding（含 arbitration 元数据）
 */
function arbitrateCategory(category, group) {
  // 统计每个 severity 级别涉及的 distinct Agent
  const agentsBySeverity = { blocking: new Set(), advisory: new Set(), info: new Set() };
  for (const { source, finding } of group) {
    const sev = finding.severity;
    if (agentsBySeverity[sev]) {
      agentsBySeverity[sev].add(source);
    }
  }

  const blockingAgents = agentsBySeverity.blocking;
  const advisoryAgents = agentsBySeverity.advisory;
  const infoAgents = agentsBySeverity.info;

  // 所有参与该类别的 Agent
  const allAgents = new Set([
    ...blockingAgents,
    ...advisoryAgents,
    ...infoAgents,
  ]);

  let finalSeverity;
  let rule;
  let isMinority = false;

  if (blockingAgents.size >= 1) {
    // 一票否决
    finalSeverity = 'blocking';
    rule = '一票否决（任意 Agent 提出 blocking）';
  } else if (advisoryAgents.size >= 2) {
    // 多数票：≥2 Agent 提出 advisory
    finalSeverity = 'advisory';
    rule = `多数票（${advisoryAgents.size} 个 Agent 提出 advisory）`;
  } else if (infoAgents.size >= 3) {
    // 多数票：≥3 Agent 提出 info
    finalSeverity = 'info';
    rule = `多数票（${infoAgents.size} 个 Agent 提出 info）`;
  } else {
    // 未达多数票阈值，取最高 severity，标记少数意见
    const presentSevs = [];
    if (advisoryAgents.size > 0) presentSevs.push('advisory');
    if (infoAgents.size > 0) presentSevs.push('info');
    finalSeverity = presentSevs.length > 0
      ? presentSevs.sort((a, b) => SEVERITY_RANK[b] - SEVERITY_RANK[a])[0]
      : 'info';
    rule = '少数意见（未达多数票阈值）';
    isMinority = true;
  }

  // 合并所有 findings 的详细信息
  const issues = group.map(({ source, finding }) => ({
    source,
    severity: finding.severity,
    issue: finding.issue || '',
    location: finding.location || '',
    evidence: finding.evidence || '',
    fix: finding.fix || '',
    gate: finding.gate || '',
  }));

  // 合并 source 字段（按 schema 约定用 '+' 连接，按权重顺序排列）
  const sourceList = VALID_SOURCES.filter(s => allAgents.has(s));
  const mergedSource = sourceList.join('+');

  // 合并 location / evidence / fix / gate
  const locations = unique(group.map(g => g.finding.location).filter(v => v));
  const evidences = unique(group.map(g => g.finding.evidence).filter(v => v));
  const fixes = unique(group.map(g => g.finding.fix).filter(v => v));
  const gates = unique(group.map(g => g.finding.gate).filter(v => v));

  // 构建合并后的 issue 文本
  const issueParts = group.map(({ source, finding }) => {
    const label = SOURCE_LABELS[source] || source;
    return `  [${label}/${finding.severity}] ${finding.issue || ''}`;
  });
  const minorityTag = isMinority ? ' [少数意见]' : '';
  const mergedIssue = `[仲裁:${rule}]${minorityTag} 共 ${group.length} 条问题（来自 ${allAgents.size} 个 Agent）:\n${issueParts.join('\n')}`;

  return {
    severity: finalSeverity,
    priority: finalSeverity === 'blocking' ? 1 : (finalSeverity === 'advisory' ? 2 : 3),
    category,
    location: locations.join('; '),
    evidence: evidences.join(' | '),
    issue: mergedIssue,
    fix: fixes.join(' | '),
    gate: gates.join('+'),
    source: mergedSource,
    // arbitration 元数据（人类可读输出用，--json 模式不输出这些字段以保持 schema 兼容）
    arbitration: {
      rule,
      is_minority: isMinority,
      agents: sourceList,
      severity_counts: {
        blocking: blockingAgents.size,
        advisory: advisoryAgents.size,
        info: infoAgents.size,
      },
      finding_count: group.length,
      issues,
    },
  };
}

/**
 * 合并所有 Agent 的 findings，按 category 分组仲裁
 * @param {Array<{source: string, findings: Object[]}>} agentFindings
 * @returns {Object[]} - 合并后的 findings 列表（按 severity 降序排列）
 */
function mergeAllFindings(agentFindings) {
  const groups = groupByCategory(agentFindings);
  const merged = [];

  for (const category of Object.keys(groups)) {
    const group = groups[category];
    if (group.length === 0) continue;
    const mergedFinding = arbitrateCategory(category, group);
    merged.push(mergedFinding);
  }

  // 按 severity 降序排列（blocking > advisory > info），同级按 category 字母序
  merged.sort((a, b) => {
    const rankDiff = SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity];
    if (rankDiff !== 0) return rankDiff;
    return a.category.localeCompare(b.category);
  });

  return merged;
}

// ============================================================
//  综合评分计算
// ============================================================

/**
 * 计算综合评分（加权平均）
 * 若部分 Agent 缺失，按可用 Agent 的权重重新归一化
 * @param {Array<{source: string, score: number}>} agentScores - 各 Agent 的评分
 * @returns {{composite: number, agentScores: Object, missing: string[], normalized: boolean}}
 */
function computeCompositeScore(agentScores) {
  const present = agentScores.filter(a => a.score !== null && a.score !== undefined);
  const presentSources = new Set(present.map(a => a.source));
  const missing = VALID_SOURCES.filter(s => !presentSources.has(s));

  if (present.length === 0) {
    return { composite: 0, agentScores: {}, missing: VALID_SOURCES.slice(), normalized: false };
  }

  // 计算可用权重总和（用于缺失时归一化）
  const availableWeight = present.reduce((sum, a) => sum + (WEIGHTS[a.source] || 0), 0);
  const normalized = missing.length > 0;

  let weightedSum = 0;
  const scoreMap = {};
  for (const a of present) {
    const weight = WEIGHTS[a.source] || 0;
    const effectiveWeight = normalized && availableWeight > 0 ? weight / availableWeight : weight;
    weightedSum += a.score * effectiveWeight;
    scoreMap[a.source] = { score: a.score, weight, effective_weight: Math.round(effectiveWeight * 100) / 100 };
  }

  const composite = Math.round(weightedSum * 10) / 10;
  return { composite, agentScores: scoreMap, missing, normalized };
}

/**
 * 根据综合评分确定流程推荐
 * @param {number} score - 综合评分（0-100）
 * @returns {string} - fast | full | rewrite
 */
function determineFlowRecommendation(score) {
  if (score >= SCORE_THRESHOLDS.fast) return 'fast';
  if (score >= SCORE_THRESHOLDS.full) return 'full';
  return 'rewrite';
}

/**
 * 构建 schema 兼容的 score 对象
 * 合并各 Agent 的 objective_details（如果有），否则用零值占位
 * @param {Array<{source: string, details: Object|null}>} agentDetails
 * @param {number} composite - 综合评分
 * @returns {Object} - 符合 findings.schema.json 的 score 对象
 */
function buildScoreObject(agentDetails, composite) {
  // 合并 objective_details（按维度平均）
  const objectiveDetails = {};
  let objectiveTotal = 0;
  let objectiveMaxTotal = 0;

  for (const dim of Object.keys(DIMENSION_MAX)) {
    const maxVal = DIMENSION_MAX[dim];
    const scores = [];
    const reasons = [];
    const details = [];

    for (const ad of agentDetails) {
      if (ad.details && ad.details[dim]) {
        const d = ad.details[dim];
        if (typeof d.score === 'number') scores.push(d.score);
        if (typeof d.max === 'number' && d.max === maxVal) {
          // max 一致才纳入
        }
        if (Array.isArray(d.reasons)) reasons.push(...d.reasons);
        if (Array.isArray(d.details)) details.push(...d.details);
      }
    }

    const avgScore = scores.length > 0
      ? Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 10) / 10
      : 0;

    objectiveDetails[dim] = {
      score: avgScore,
      max: maxVal,
      reasons: unique(reasons),
      details: unique(details),
    };
    objectiveTotal += avgScore;
    objectiveMaxTotal += maxVal;
  }

  const objectiveScore = Math.min(60, Math.round(objectiveTotal));
  const llmSubjective = Math.max(0, Math.round(composite - objectiveScore));
  const llmSubjectiveCapped = Math.min(40, llmSubjective);

  return {
    objective_score: objectiveScore,
    objective_details: objectiveDetails,
    llm_subjective_score: llmSubjectiveCapped,
    total_score: composite,
    llm_max_score: 40,
    total_max: 100,
    threshold: { fast: 80, full: 60, rewrite: 60 },
    flow_recommendation: determineFlowRecommendation(composite),
  };
}

// ============================================================
//  输出格式化
// ============================================================

/**
 * 格式化人类可读输出
 * @param {Object} result - 合并结果
 * @returns {string} - 人类可读报告
 */
function formatHumanReadable(result) {
  const lines = [];
  const { chapter_no, merged_findings, composite_score, agent_scores, missing_agents, sources_found, errors } = result;

  lines.push('=== 多 Agent Findings 仲裁合并报告 ===');
  lines.push(`审阅章节: Ch.${chapter_no || '?'}`);
  lines.push(`参与 Agent: ${sources_found.length > 0 ? sources_found.map(s => `${SOURCE_LABELS[s] || s}(${s})`).join(', ') : '无'}`);
  if (missing_agents.length > 0) {
    lines.push(`缺失 Agent: ${missing_agents.map(s => `${SOURCE_LABELS[s] || s}(${s})`).join(', ')}`);
  }
  lines.push('');

  // 分项评分
  lines.push('【分项评分】');
  for (const src of VALID_SOURCES) {
    const info = agent_scores[src];
    if (info) {
      const weightPct = Math.round(info.effective_weight * 100);
      lines.push(`  ${SOURCE_LABELS[src] || src}: ${info.score}/100 (权重 ${weightPct}%)`);
    } else {
      lines.push(`  ${SOURCE_LABELS[src] || src}: 缺失`);
    }
  }
  lines.push('');
  lines.push(`【综合得分】: ${composite_score}/100  →  流程推荐: ${determineFlowRecommendation(composite_score)}`);
  lines.push('');

  // 仲裁结果摘要
  const blocking = merged_findings.filter(f => f.severity === 'blocking');
  const advisory = merged_findings.filter(f => f.severity === 'advisory');
  const info = merged_findings.filter(f => f.severity === 'info');
  lines.push('【仲裁摘要】');
  lines.push(`  blocking (需修改): ${blocking.length} 条`);
  lines.push(`  advisory (建议修改): ${advisory.length} 条`);
  lines.push(`  info (关注): ${info.length} 条`);
  lines.push(`  合计: ${merged_findings.length} 条合并 findings`);
  lines.push('');

  // 详细 findings
  if (merged_findings.length > 0) {
    lines.push('【合并后 Findings 明细】');
    lines.push('');
    merged_findings.forEach((f, i) => {
      const arb = f.arbitration;
      lines.push(`--- ${i + 1}. [${f.severity.toUpperCase()}] ${f.category} ---`);
      lines.push(`  仲裁规则: ${arb.rule}`);
      lines.push(`  少数意见: ${arb.is_minority ? '是' : '否'}`);
      lines.push(`  来源 Agent: ${arb.agents.map(s => SOURCE_LABELS[s] || s).join(', ')}`);
      lines.push(`  severity 计数 (Agent数): blocking=${arb.severity_counts.blocking}, advisory=${arb.severity_counts.advisory}, info=${arb.severity_counts.info}`);
      lines.push(`  finding 总数: ${arb.finding_count}`);
      if (f.location) lines.push(`  位置: ${f.location}`);
      if (f.gate) lines.push(`  Gate: ${f.gate}`);
      lines.push(`  合并 source: ${f.source}`);
      lines.push('');
      // 各 Agent 的原始问题
      lines.push('  各 Agent 原始问题:');
      arb.issues.forEach((iss, j) => {
        const label = SOURCE_LABELS[iss.source] || iss.source;
        lines.push(`    ${j + 1}) [${label}/${iss.severity}] ${iss.issue}`);
        if (iss.location) lines.push(`       位置: ${iss.location}`);
        if (iss.evidence) lines.push(`       原文: ${iss.evidence}`);
        if (iss.fix) lines.push(`       建议: ${iss.fix}`);
        if (iss.gate) lines.push(`       Gate: ${iss.gate}`);
      });
      // 合并后的修复建议
      if (f.fix) {
        lines.push('');
        lines.push(`  合并修复建议: ${f.fix}`);
      }
      lines.push('');
    });
  } else {
    lines.push('【合并后 Findings 明细】');
    lines.push('  无 findings — 所有 Agent 均未发现问题。');
    lines.push('');
  }

  // 错误/警告
  if (errors.length > 0) {
    lines.push('【警告】');
    errors.forEach((e, i) => lines.push(`  ${i + 1}. ${e}`));
    lines.push('');
  }

  // 结论
  if (blocking.length > 0) {
    lines.push('【结论】存在 blocking 级问题，需修改后方可放行。');
  } else if (advisory.length > 0) {
    lines.push('【结论】无 blocking 级问题，存在 advisory 级建议可酌情修改。');
  } else {
    lines.push('【结论】无 blocking/advisory 级问题，可放行。');
  }

  return lines.join('\n');
}

/**
 * 格式化 JSON 输出（符合 findings.schema.json 格式）
 * 注意：findings items 不包含 arbitration 元数据字段，以保持 schema 兼容
 * （arbitration 信息已嵌入 issue 文本和 source 字段）
 * @param {Object} result - 合并结果
 * @returns {Object} - findings.schema.json 兼容的 JSON 对象
 */
function formatJson(result) {
  const { chapter_no, merged_findings, composite_score, agent_details } = result;

  // 构建 schema 兼容的 findings items（移除 arbitration 元数据）
  const schemaFindings = merged_findings.map(f => {
    const item = {
      severity: f.severity,
      category: f.category,
      issue: f.issue,
    };
    if (f.priority !== undefined) item.priority = f.priority;
    if (f.location) item.location = f.location;
    if (f.evidence) item.evidence = f.evidence;
    if (f.fix) item.fix = f.fix;
    if (f.gate) item.gate = f.gate;
    if (f.source) item.source = f.source;
    return item;
  });

  const score = buildScoreObject(agent_details, composite_score);

  return {
    chapter_no: chapter_no || 1,
    step: '09',
    findings: schemaFindings,
    score,
    timestamp: new Date().toISOString(),
  };
}

// ============================================================
//  辅助函数
// ============================================================

/**
 * 数组去重（保留顺序）
 * @param {Array} arr
 * @returns {Array}
 */
function unique(arr) {
  const seen = new Set();
  const result = [];
  for (const item of arr) {
    const key = typeof item === 'object' ? JSON.stringify(item) : String(item);
    if (!seen.has(key)) {
      seen.add(key);
      result.push(item);
    }
  }
  return result;
}

/**
 * 解析输入文件列表
 * @param {{dir: string|null, files: string[]|null}} opts
 * @returns {string[]} - 文件绝对路径列表
 */
function resolveInputFiles(opts) {
  if (opts.files) {
    return opts.files.map(f => path.resolve(f));
  }

  // --dir 模式：读取目录下所有 *.json 文件
  const dir = path.resolve(opts.dir);
  if (!fs.existsSync(dir)) {
    console.error(`Error: 目录不存在: ${dir}`);
    process.exit(2);
  }
  const stat = fs.statSync(dir);
  if (!stat.isDirectory()) {
    console.error(`Error: 路径不是目录: ${dir}`);
    process.exit(2);
  }

  const files = fs.readdirSync(dir)
    .filter(f => f.toLowerCase().endsWith('.json'))
    .sort()
    .map(f => path.join(dir, f));

  if (files.length === 0) {
    console.error(`Error: 目录下无 *.json 文件: ${dir}`);
    process.exit(2);
  }

  return files;
}

// ============================================================
//  主函数
// ============================================================

function main() {
  const opts = parseArgs(process.argv);

  // 1. 解析输入文件
  const files = resolveInputFiles(opts);
  const errors = [];
  const warnings = [];

  // 2. 加载并校验每个文件
  const agentData = []; // {source, data, filePath, score, details}
  const chapterNos = new Set();

  for (const filePath of files) {
    const label = path.basename(filePath);
    const { ok, data, error } = loadJSON(filePath, label);
    if (!ok) {
      errors.push(error);
      continue;
    }

    // 结构校验
    const structErrors = validateFindingsStructure(data, filePath);
    if (structErrors.length > 0) {
      errors.push(...structErrors);
      continue;
    }

    // 识别 Agent 来源
    const source = identifySource(filePath, data);
    if (!source) {
      warnings.push(`无法识别 Agent 来源: ${label}（findings.source 字段无效且文件名无法匹配）`);
    }

    // 提取评分
    const scoreValue = extractScoreValue(data.score);
    if (scoreValue === null) {
      warnings.push(`无法提取评分: ${label}（source=${source || '未知'}）`);
    }

    // 提取 objective_details
    const details = extractObjectiveDetails(data.score);

    chapterNos.add(data.chapter_no);
    agentData.push({
      source: source || 'unknown',
      data,
      filePath,
      score: scoreValue,
      details,
    });
  }

  // 3. 章节号一致性检查
  if (chapterNos.size > 1) {
    warnings.push(`章节号不一致: ${Array.from(chapterNos).join(', ')}（将使用第一个）`);
  }
  const chapterNo = chapterNos.size > 0 ? Array.from(chapterNos)[0] : null;

  // 4. Agent 来源去重检查
  const sourcesFound = [];
  const seenSources = new Set();
  for (const ad of agentData) {
    if (ad.source !== 'unknown' && !seenSources.has(ad.source)) {
      seenSources.add(ad.source);
      sourcesFound.push(ad.source);
    } else if (ad.source !== 'unknown' && seenSources.has(ad.source)) {
      warnings.push(`重复的 Agent 来源: ${ad.source}（${path.basename(ad.filePath)}）`);
    }
  }

  const missingAgents = VALID_SOURCES.filter(s => !seenSources.has(s));

  // 5. 合并 findings（仲裁）
  const agentFindings = agentData
    .filter(ad => ad.source !== 'unknown')
    .map(ad => ({ source: ad.source, findings: ad.data.findings || [] }));

  // unknown 来源的 findings 也纳入合并（标记为 script 来源）
  for (const ad of agentData) {
    if (ad.source === 'unknown' && Array.isArray(ad.data.findings) && ad.data.findings.length > 0) {
      agentFindings.push({ source: 'script', findings: ad.data.findings });
    }
  }

  const mergedFindings = mergeAllFindings(agentFindings);

  // 6. 计算综合评分
  const agentScores = agentData
    .filter(ad => ad.source !== 'unknown' && ad.score !== null)
    .map(ad => ({ source: ad.source, score: ad.score }));

  const scoreResult = computeCompositeScore(agentScores);
  const composite = scoreResult.composite;
  if (scoreResult.missing.length > 0) {
    warnings.push(`缺失 ${scoreResult.missing.length} 个 Agent 评分（${scoreResult.missing.join(', ')}），权重已归一化`);
  }

  // agent_details（用于构建 score 对象）
  const agentDetails = agentData
    .filter(ad => ad.source !== 'unknown')
    .map(ad => ({ source: ad.source, details: ad.details }));

  // 7. 构建结果
  const result = {
    chapter_no: chapterNo,
    sources_found: sourcesFound,
    missing_agents: missingAgents,
    agent_scores: scoreResult.agentScores,
    composite_score: composite,
    merged_findings: mergedFindings,
    agent_details: agentDetails,
    errors: [...errors, ...warnings],
  };

  // 8. 输出
  if (opts.json) {
    const jsonOutput = formatJson(result);
    process.stdout.write(JSON.stringify(jsonOutput, null, 2) + '\n');
  } else {
    process.stdout.write(formatHumanReadable(result) + '\n');
  }

  // 9. 退出码
  if (errors.length > 0 && agentData.length === 0) {
    // 全部文件加载失败 → 运行错误
    process.exit(2);
  }

  const hasBlocking = mergedFindings.some(f => f.severity === 'blocking');
  if (hasBlocking) {
    process.exit(1);
  }

  process.exit(0);
}

main();

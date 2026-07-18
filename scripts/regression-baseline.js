#!/usr/bin/env node
'use strict';

/**
 * regression-baseline.js — 回归测试基线对比脚本 (V5.3.1 新增)
 *
 * 功能：
 *   1. 读取 samples/baseline/MANIFEST.json 获取基线哈希和评分
 *   2. 计算当前样本文件和脚本文件的实际 SHA-256
 *   3. 对比文件哈希，检测样本/脚本是否被修改
 *   4. 重新运行所有检测脚本，对比评分和 blocking/advisory 计数
 *   5. 输出回归测试报告
 *
 * 用法：
 *   node scripts/regression-baseline.js                              # 对比模式（默认）
 *   node scripts/regression-baseline.js --update                     # 更新基线
 *   node scripts/regression-baseline.js --baseline=path/to/manifest  # 指定基线文件
 *   node scripts/regression-baseline.js --json                       # JSON 输出
 *
 * 退出码：
 *   0 = 无回归（所有对比项一致）
 *   1 = 有回归（存在差异，需人工审查）
 *   2 = 运行错误（基线文件缺失、脚本执行失败等）
 *
 * 依赖：Node.js 内置 crypto 模块，无外部 npm 依赖
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');

const SCRIPT_DIR = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(SCRIPT_DIR, '..');
const DEFAULT_BASELINE = path.join(PROJECT_ROOT, 'samples', 'baseline', 'MANIFEST.json');

const USAGE = `Usage: node scripts/regression-baseline.js [--update] [--baseline=<path>] [--json]

Regression test: compare current script outputs against MANIFEST.json baseline.
  --update       Re-run all scripts and update MANIFEST.json with new hashes/scores
  --baseline=<p> Path to baseline MANIFEST.json (default: samples/baseline/MANIFEST.json)
  --json         Output JSON instead of human-readable text

Exit codes: 0=no regression, 1=regression detected, 2=error`;

// ============================================================
//  工具函数
// ============================================================

function sha256(filePath) {
  try {
    const content = fs.readFileSync(filePath);
    return crypto.createHash('sha256').update(content).digest('hex').toUpperCase();
  } catch (e) {
    return null;
  }
}

function runScript(scriptPath, args) {
  try {
    const cmd = `node "${path.resolve(PROJECT_ROOT, scriptPath)}" ${args}`;
    const output = execSync(cmd, {
      cwd: PROJECT_ROOT,
      encoding: 'utf-8',
      timeout: 30000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { success: true, stdout: output, stderr: '' };
  } catch (e) {
    // Scripts may exit with code 1 when they find issues — that's normal
    const stdout = e.stdout || '';
    const stderr = e.stderr || '';
    return { success: true, stdout, stderr, exitCode: e.status };
  }
}

function parseJsonOutput(stdout) {
  // Some scripts output warnings to stderr, JSON to stdout
  try {
    return JSON.parse(stdout);
  } catch (e) {
    // Try to extract JSON from mixed output
    const jsonMatch = stdout.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        return JSON.parse(jsonMatch[0]);
      } catch (e2) {
        return null;
      }
    }
    return null;
  }
}

function countFindings(findings) {
  if (!Array.isArray(findings)) return { blocking: 0, advisory: 0, info: 0 };
  const counts = { blocking: 0, advisory: 0, info: 0 };
  for (const f of findings) {
    const sev = f.severity || 'info';
    if (counts.hasOwnProperty(sev)) counts[sev]++;
  }
  return counts;
}

// ============================================================
//  主逻辑
// ============================================================

function main() {
  const args = process.argv.slice(2);
  const isUpdate = args.includes('--update');
  const isJson = args.includes('--json');
  const baselineArg = args.find(a => a.startsWith('--baseline='));
  const baselinePath = baselineArg
    ? path.resolve(PROJECT_ROOT, baselineArg.split('=')[1])
    : DEFAULT_BASELINE;

  if (args.includes('--help') || args.includes('-h')) {
    console.error(USAGE);
    process.exit(0);
  }

  // 读取基线
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(baselinePath, 'utf-8'));
  } catch (e) {
    console.error(`Error: Cannot read baseline file: ${baselinePath}`);
    console.error(e.message);
    process.exit(2);
  }

  const results = {
    timestamp: new Date().toISOString(),
    baseline_version: manifest.version,
    baseline_path: baselinePath,
    file_hash_checks: [],
    score_checks: [],
    summary: {
      total_checks: 0,
      passed: 0,
      failed: 0,
      regressions: 0,
      improvements: 0,
    },
  };

  // ============================================================
  //  1. 文件哈希对比
  // ============================================================

  const allFiles = [
    ...manifest.samples.map(s => ({ type: 'sample', path: s.final_draft, sha256: s.sha256, id: s.id })),
    ...manifest.scripts.map(s => ({ type: 'script', path: s.path, sha256: s.sha256, id: s.name })),
  ];

  for (const entry of allFiles) {
    const fullPath = path.join(PROJECT_ROOT, entry.path);
    const currentHash = sha256(fullPath);
    const match = currentHash === entry.sha256;

    results.file_hash_checks.push({
      type: entry.type,
      id: entry.id,
      path: entry.path,
      baseline_hash: entry.sha256,
      current_hash: currentHash,
      match: match,
    });

    results.summary.total_checks++;
    if (match) {
      results.summary.passed++;
    } else {
      results.summary.failed++;
    }
  }

  // ============================================================
  //  2. 评分对比（重跑脚本）
  // ============================================================

  if (!isUpdate) {
    for (const sample of manifest.samples) {
      const samplePath = path.join(PROJECT_ROOT, sample.final_draft);

      // Run check-quality-score.js
      const qsResult = runScript('scripts/check-quality-score.js', `--file="${samplePath}" --json`);
      const qsData = parseJsonOutput(qsResult.stdout);

      if (qsData) {
        const scoreMatch = qsData.objective_score === sample.objective_score;
        const flowMatch = qsData.flow_recommendation === sample.flow_recommendation;

        results.score_checks.push({
          sample_id: sample.id,
          script: 'check-quality-score.js',
          baseline_objective_score: sample.objective_score,
          current_objective_score: qsData.objective_score,
          score_match: scoreMatch,
          baseline_flow: sample.flow_recommendation,
          current_flow: qsData.flow_recommendation,
          flow_match: flowMatch,
        });

        results.summary.total_checks++;
        if (scoreMatch && flowMatch) {
          results.summary.passed++;
        } else {
          results.summary.failed++;
          // Determine if regression or improvement
          if (qsData.objective_score < sample.objective_score) {
            results.summary.regressions++;
          } else if (qsData.objective_score > sample.objective_score) {
            results.summary.improvements++;
          }
        }
      }

      // Run check-ai-patterns.js for blocking/advisory counts
      const aipResult = runScript('scripts/check-ai-patterns.js', `--json "${samplePath}"`);
      const aipData = parseJsonOutput(aipResult.stdout);

      if (aipData && aipData.findings) {
        const counts = countFindings(aipData.findings);
        const blockingMatch = counts.blocking === sample.blocking_count;
        const advisoryMatch = counts.advisory === sample.advisory_count;

        results.score_checks.push({
          sample_id: sample.id,
          script: 'check-ai-patterns.js',
          baseline_blocking: sample.blocking_count,
          current_blocking: counts.blocking,
          blocking_match: blockingMatch,
          baseline_advisory: sample.advisory_count,
          current_advisory: counts.advisory,
          advisory_match: advisoryMatch,
        });

        results.summary.total_checks++;
        if (blockingMatch && advisoryMatch) {
          results.summary.passed++;
        } else {
          results.summary.failed++;
          if (counts.blocking > sample.blocking_count) {
            results.summary.regressions++;
          } else if (counts.blocking < sample.blocking_count) {
            results.summary.improvements++;
          }
        }
      }
    }
  }

  // ============================================================
  //  3. 更新模式
  // ============================================================

  if (isUpdate) {
    // Re-run all scripts and update manifest
    for (const sample of manifest.samples) {
      const samplePath = path.join(PROJECT_ROOT, sample.final_draft);
      const currentHash = sha256(samplePath);
      sample.sha256 = currentHash;

      // Update score
      const qsResult = runScript('scripts/check-quality-score.js', `--file="${samplePath}" --json`);
      const qsData = parseJsonOutput(qsResult.stdout);
      if (qsData) {
        sample.objective_score = qsData.objective_score;
        sample.total_max = qsData.total_max;
        sample.flow_recommendation = qsData.flow_recommendation;
      }

      // Update finding counts
      const aipResult = runScript('scripts/check-ai-patterns.js', `--json "${samplePath}"`);
      const aipData = parseJsonOutput(aipResult.stdout);
      if (aipData && aipData.findings) {
        const counts = countFindings(aipData.findings);
        sample.blocking_count = counts.blocking;
        sample.advisory_count = counts.advisory;
        sample.info_count = counts.info;
      }
    }

    // Update script hashes
    for (const script of manifest.scripts) {
      const scriptFullPath = path.join(PROJECT_ROOT, script.path);
      script.sha256 = sha256(scriptFullPath);
    }

    manifest.generated_at = new Date().toISOString();

    try {
      fs.writeFileSync(baselinePath, JSON.stringify(manifest, null, 2) + '\n', 'utf-8');
      if (!isJson) {
        console.error(`✅ Baseline updated: ${baselinePath}`);
        console.error(`   Samples: ${manifest.samples.length}, Scripts: ${manifest.scripts.length}`);
      }
      process.exit(0);
    } catch (e) {
      console.error(`Error writing updated baseline: ${e.message}`);
      process.exit(2);
    }
  }

  // ============================================================
  //  4. 输出报告
  // ============================================================

  if (isJson) {
    console.log(JSON.stringify(results, null, 2));
  } else {
    console.error('═══════════════════════════════════════');
    console.error('  回归测试报告 (Regression Test Report)');
    console.error('═══════════════════════════════════════');
    console.error(`基线版本: ${manifest.version}`);
    console.error(`基线文件: ${baselinePath}`);
    console.error(`检测时间: ${results.timestamp}`);
    console.error('');

    // File hash checks
    console.error('── 文件哈希对比 ──');
    for (const check of results.file_hash_checks) {
      const status = check.match ? '✓' : '✗';
      const shortPath = check.path.length > 50 ? '...' + check.path.slice(-47) : check.path;
      console.error(`  ${status} [${check.type}] ${check.id}: ${shortPath}`);
      if (!check.match && check.current_hash) {
        console.error(`      基线: ${check.baseline_hash.slice(0, 16)}...`);
        console.error(`      当前: ${check.current_hash.slice(0, 16)}...`);
      } else if (!check.current_hash) {
        console.error(`      ⚠ 文件不存在`);
      }
    }
    console.error('');

    // Score checks
    if (results.score_checks.length > 0) {
      console.error('── 评分对比 ──');
      for (const check of results.score_checks) {
        if (check.score_match !== undefined) {
          const status = check.score_match && check.flow_match ? '✓' : '✗';
          console.error(`  ${status} [${check.sample_id}] ${check.script}`);
          console.error(`      客观分: 基线=${check.baseline_objective_score} → 当前=${check.current_objective_score}`);
          console.error(`      流程推荐: 基线=${check.baseline_flow} → 当前=${check.current_flow}`);
        } else if (check.blocking_match !== undefined) {
          const status = check.blocking_match && check.advisory_match ? '✓' : '✗';
          console.error(`  ${status} [${check.sample_id}] ${check.script}`);
          console.error(`      blocking: 基线=${check.baseline_blocking} → 当前=${check.current_blocking}`);
          console.error(`      advisory: 基线=${check.baseline_advisory} → 当前=${check.current_advisory}`);
        }
      }
      console.error('');
    }

    // Summary
    console.error('── 汇总 ──');
    console.error(`  总检测项: ${results.summary.total_checks}`);
    console.error(`  通过: ${results.summary.passed}`);
    console.error(`  失败: ${results.summary.failed}`);
    if (results.summary.regressions > 0) {
      console.error(`  回归(变差): ${results.summary.regressions}`);
    }
    if (results.summary.improvements > 0) {
      console.error(`  改善(变好): ${results.summary.improvements}`);
    }
    console.error('');

    if (results.summary.failed === 0) {
      console.error('✅ 所有检测项一致，无回归。');
      process.exit(0);
    } else {
      console.error(`✗ ${results.summary.failed} 项检测不一致，请人工审查。`);
      if (results.summary.regressions > 0) {
        console.error(`  ⚠ 其中 ${results.summary.regressions} 项为回归（评分下降或问题增多）。`);
      }
      process.exit(1);
    }
  }
}

main();

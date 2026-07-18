#!/usr/bin/env node
'use strict';

/**
 * sync-versions.js — 版本同步检查与自动更新
 *
 * V4.0 新增脚本（问题10解决方案）：
 *   扫描所有 skill 文件的版本号，与 README.md 中的版本表对比，
 *   输出不一致项。可选自动更新 README.md 版本表。
 *
 * 用法：
 *   node sync-versions.js              — 检查并报告不一致
 *   node sync-versions.js --write      — 自动更新 README.md
 *   node sync-versions.js --json       — JSON 输出
 */

const fs = require('fs');
const path = require('path');

const USAGE = `Usage: node sync-versions.js [--write] [--json]

Scan all skill files for version numbers, compare with README.md version table.
  --write    automatically update README.md version table
  --json     output JSON instead of human-readable report

Report-only by default.`;

// ════════════════════════════════════════════════════════════
//  配置
// ════════════════════════════════════════════════════════════

const SKILL_DIR = path.resolve(__dirname, '..');

// skill 文件列表（按步骤编号排序）
const SKILL_FILES = [
  '00.5_项目初始化.md',
  '00_小说设定架构师.md',
  '01_小说大纲构建师.md',
  '02a_细纲生成.md',
  '02b_细纲质检.md',
  '02_细纲编写技能.md',
  '03a_扩写执行.md',
  '03b_质量自检.md',
  '04_小说正文精修师.md',
  '04b_深度打磨.md',
  '05_去AI味精修师.md',
  '06_小说拆文师.md',
  '07_小说导入师.md',
  '08_短篇写作技能.md',
  '09_多视角审稿师.md',
  '10_读者反馈注入师.md',
];

// 版本号提取正则（匹配 V2.1 / v3.0 / Version: V4.0 等格式）
const VERSION_PATTERNS = [
  /Version:\s*(V[\d.]+)/i,
  /版本[：:]\s*(V[\d.]+)/i,
  /#\s*S.*?V([\d.]+)/i,
  /\bV(\d+\.\d+(?:\.\d+)?)\b/,
];

// 日期提取正则
const DATE_PATTERN = /(\d{4}-\d{2}-\d{2})/;

// ════════════════════════════════════════════════════════════
//  核心函数
// ════════════════════════════════════════════════════════════

/**
 * 从文件内容中提取版本号
 */
function extractVersion(text) {
  // 只扫描前30行（版本号通常在文件头）
  const header = text.split('\n').slice(0, 30).join('\n');

  for (const pattern of VERSION_PATTERNS) {
    const match = header.match(pattern);
    if (match) {
      // 统一格式为 V.x.x
      let ver = match[1];
      if (!ver.startsWith('V') && !ver.startsWith('v')) {
        ver = 'V' + ver;
      }
      return ver.toUpperCase();
    }
  }
  return null;
}

/**
 * 从文件内容中提取日期
 */
function extractDate(text) {
  const header = text.split('\n').slice(0, 30).join('\n');
  const match = header.match(DATE_PATTERN);
  return match ? match[1] : null;
}

/**
 * 扫描所有 skill 文件
 */
function scanAllSkills() {
  const results = [];
  for (const filename of SKILL_FILES) {
    const filepath = path.join(SKILL_DIR, filename);
    if (!fs.existsSync(filepath)) {
      results.push({ file: filename, version: null, date: null, status: 'missing' });
      continue;
    }
    const text = fs.readFileSync(filepath, 'utf-8');
    const version = extractVersion(text);
    const date = extractDate(text);
    results.push({
      file: filename,
      version: version,
      date: date,
      status: version ? 'ok' : 'no_version_found',
    });
  }
  return results;
}

/**
 * 从 README.md 中提取版本表
 */
function extractReadmeVersions() {
  const readmePath = path.join(SKILL_DIR, 'README.md');
  if (!fs.existsSync(readmePath)) {
    return { found: false, table: '', versions: {} };
  }

  const text = fs.readFileSync(readmePath, 'utf-8');
  const versions = {};

  // 匹配 | 文件名 | Vx.x | 格式的表格行
  const lines = text.split('\n');
  for (const line of lines) {
    if (line.includes('|') && line.match(/V\d+\.\d+/i)) {
      // 提取文件名和版本号
      const cells = line.split('|').map(c => c.trim()).filter(c => c);
      for (let i = 0; i < cells.length - 1; i++) {
        const verMatch = cells[i + 1].match(/V(\d+\.\d+(?:\.\d+)?)/i);
        if (verMatch && cells[i].includes('.md')) {
          versions[cells[i]] = 'V' + verMatch[1];
        }
      }
    }
  }

  return { found: true, table: text, versions: versions };
}

/**
 * 检查不一致
 */
function checkInconsistencies(skillVersions, readmeVersions) {
  const issues = [];

  for (const skill of skillVersions) {
    if (skill.status === 'missing' || !skill.version) continue;

    const readmeVer = readmeVersions[skill.file];
    if (!readmeVer) {
      issues.push({
        type: 'missing_in_readme',
        file: skill.file,
        actual_version: skill.version,
        readme_version: null,
        severity: 'advisory',
      });
    } else if (readmeVer !== skill.version) {
      issues.push({
        type: 'version_mismatch',
        file: skill.file,
        actual_version: skill.version,
        readme_version: readmeVer,
        severity: 'blocking',
        date: skill.date,
      });
    }
  }

  return issues;
}

/**
 * 生成更新的 README 版本表
 */
function generateReadmeTable(skillVersions) {
  let table = '| 文件 | 版本 | 日期 |\n';
  table += '|------|------|------|\n';

  for (const skill of skillVersions) {
    if (skill.status === 'missing') continue;
    const ver = skill.version || '未标注';
    const date = skill.date || '—';
    table += `| ${skill.file} | ${ver} | ${date} |\n`;
  }

  return table;
}

// ════════════════════════════════════════════════════════════
//  主流程
// ════════════════════════════════════════════════════════════

function main() {
  const args = process.argv.slice(2);
  let writeMode = false;
  let jsonMode = false;

  for (const arg of args) {
    if (arg === '--write') writeMode = true;
    else if (arg === '--json') jsonMode = true;
    else if (arg === '--help' || arg === '-h') {
      console.log(USAGE);
      process.exit(0);
    }
  }

  // 扫描所有 skill 文件
  const skillVersions = scanAllSkills();

  // 扫描 README 版本表
  const readmeData = extractReadmeVersions();

  // 检查不一致
  const issues = checkInconsistencies(skillVersions, readmeData.versions);

  // 输出
  if (jsonMode) {
    const output = {
      scan_date: new Date().toISOString().split('T')[0],
      total_skills: skillVersions.length,
      skills_with_version: skillVersions.filter(s => s.version).length,
      skills_missing: skillVersions.filter(s => s.status === 'missing').length,
      issues: issues,
      skill_versions: skillVersions,
      readme_found: readmeData.found,
    };
    console.log(JSON.stringify(output, null, 2));
    return;
  }

  console.log('═══════════════════════════════════════════════════════');
  console.log('  版本同步检查报告');
  console.log('═══════════════════════════════════════════════════════');
  console.log(`扫描日期: ${new Date().toISOString().split('T')[0]}`);
  console.log(`Skill 文件总数: ${skillVersions.length}`);
  console.log(`已标注版本: ${skillVersions.filter(s => s.version).length}`);
  console.log(`README 找到: ${readmeData.found ? '是' : '否'}`);
  console.log('');

  // 逐文件版本
  console.log('── Skill 文件版本 ──');
  for (const skill of skillVersions) {
    let status = '';
    if (skill.status === 'missing') status = '❌ 文件缺失';
    else if (skill.status === 'no_version_found') status = '⚠️ 未标注版本';
    else status = '✓';

    const ver = skill.version || '—';
    const date = skill.date || '—';
    console.log(`  ${skill.file}: ${ver} (${date}) ${status}`);
  }
  console.log('');

  // 不一致项
  if (issues.length === 0) {
    console.log('✅ 所有版本一致，无问题。');
  } else {
    console.log(`── ⚠️ 发现 ${issues.length} 个不一致 ──`);
    for (const issue of issues) {
      if (issue.type === 'version_mismatch') {
        console.log(`  🔴 ${issue.file}: 实际=${issue.actual_version} vs README=${issue.readme_version} [${issue.severity}]`);
      } else if (issue.type === 'missing_in_readme') {
        console.log(`  🟡 ${issue.file}: 实际=${issue.actual_version} 但 README 中未列出 [${issue.severity}]`);
      }
    }
    console.log('');

    if (writeMode && readmeData.found) {
      // 自动更新 README 版本表
      const newTable = generateReadmeTable(skillVersions);
      let readmeText = readmeData.table;

      // 替换 README 中的版本表
      // 找到版本表的位置（以 | 文件 | 开头的行）
      const tableStart = readmeText.indexOf('| 文件');
      if (tableStart !== -1) {
        // 找到表格结束位置（下一个空行或非表格行）
        let tableEnd = tableStart;
        const lines = readmeText.substring(tableStart).split('\n');
        let lineIdx = 0;
        for (lineIdx = 0; lineIdx < lines.length; lineIdx++) {
          if (lines[lineIdx].trim() && !lines[lineIdx].includes('|')) {
            break;
          }
          if (!lines[lineIdx].trim() && lineIdx > 2) {
            break;
          }
        }
        tableEnd = tableStart + lines.slice(0, lineIdx).join('\n').length;

        readmeText = readmeText.substring(0, tableStart) + newTable.trim() + readmeText.substring(tableEnd);

        const readmePath = path.join(SKILL_DIR, 'README.md');
        fs.writeFileSync(readmePath, readmeText, 'utf-8');
        console.log('✅ README.md 版本表已自动更新。');
      } else {
        console.log('⚠️ README.md 中未找到版本表位置，无法自动更新。');
      }
    } else if (!writeMode) {
      console.log('⚠️ 当前为检查模式。使用 --write 自动更新 README.md。');
    }
  }
}

main();

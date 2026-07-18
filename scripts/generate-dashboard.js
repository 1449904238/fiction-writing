#!/usr/bin/env node
'use strict';

/**
 * generate-dashboard.js — HTML 进度面板生成器
 *
 * 读取项目状态文件，生成自包含 HTML 进度面板。
 * 数据源：novel_meta.json / 上下文管理模板.md / 伏笔追踪表.md / 状态快照库.md /
 *        正文/终稿/ 目录 / 追踪/rule-execution-telemetry.json
 *
 * 面板包含：
 *   - 总进度条（已完成/总章数）
 *   - 质量评分趋势（近10章评分折线图，内联SVG）
 *   - 伏笔状态统计（🟢🟡🔴⚫ 计数）
 *   - 角色状态表
 *   - 规则执行率柱状图（近10章，内联SVG）
 *   - 衔接包健康度（synced/degraded 分布）
 *
 * HTML 使用内联 CSS+JS，无外部依赖。
 * 找不到的文件在面板对应位置显示"数据不可用"。
 *
 * 用法：node generate-dashboard.js [--project=<path>] [--output=<path>]
 * Exit codes: 0=成功, 2=错误
 */

const fs = require('fs');
const path = require('path');

const USAGE = `Usage: node generate-dashboard.js [--project=<path>] [--output=<path>]

Generate a self-contained HTML progress dashboard from project state files.
  --project=<path>  project root (default: cwd)
  --output=<path>   output HTML path (default: <project>/dashboard.html)

Report-only (generates HTML file).`;

// ════════════════════════════════════════════════════════════
//  参数解析
// ════════════════════════════════════════════════════════════

const options = {
  project: process.cwd(),
  output: null,
};

for (let i = 2; i < process.argv.length; i += 1) {
  const arg = process.argv[i];
  if (arg.startsWith('--project=')) {
    options.project = path.resolve(arg.slice('--project='.length));
  } else if (arg.startsWith('--output=')) {
    options.output = path.resolve(arg.slice('--output='.length));
  } else if (arg === '-h' || arg === '--help') {
    process.stdout.write(`${USAGE}\n`);
    process.exit(0);
  } else {
    console.error(`Unknown option: ${arg}`);
    console.error(USAGE.trimEnd());
    process.exit(2);
  }
}

if (!options.output) {
  options.output = path.join(options.project, 'dashboard.html');
}

// ════════════════════════════════════════════════════════════
//  数据采集函数
// ════════════════════════════════════════════════════════════

/**
 * 安全读取文件，不存在返回 null
 */
function safeReadFile(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch (_e) {
    return null;
  }
}

/**
 * 安全读取 JSON，不存在或解析失败返回 null
 */
function safeReadJSON(filePath) {
  const text = safeReadFile(filePath);
  if (!text) return null;
  try {
    // 剥离 UTF-8 BOM
    const clean = text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text;
    return JSON.parse(clean);
  } catch (_e) {
    return null;
  }
}

/**
 * 从 novel_meta.json 提取书籍元数据
 */
function loadNovelMeta(projectRoot) {
  const meta = safeReadJSON(path.join(projectRoot, 'novel_meta.json'));
  if (!meta) return { available: false };

  return {
    available: true,
    title: meta.title || meta.book_title || meta.name || '未命名作品',
    genre: meta.genre || meta.type || '未指定',
    total_chapters: meta.total_chapters || meta.planned_chapters || 0,
    author: meta.author || '',
    summary: meta.summary || meta.synopsis || '',
    characters: meta.characters || [],
  };
}

/**
 * 从 上下文管理模板.md 提取当前进度信息
 */
function loadContextTemplate(projectRoot) {
  const text = safeReadFile(path.join(projectRoot, '上下文管理模板.md'));
  if (!text) return { available: false };

  const result = {
    available: true,
    current_chapter: null,
    next_task: '',
    character_states: [],
    active_foreshadowing: [],
    handoff_health: { synced: 0, degraded: 0, unknown: 0 },
  };

  // 提取当前章节进度
  const chapterMatch = text.match(/(?:当前章节|进度|章节进度)[：:]\s*第?(\d+)章?/);
  if (chapterMatch) {
    result.current_chapter = parseInt(chapterMatch[1], 10);
  }

  // 提取下一任务
  const taskMatch = text.match(/(?:下一步|下一任务|next)[：:]\s*(.+)/);
  if (taskMatch) {
    result.next_task = taskMatch[1].trim();
  }

  // 提取衔接包健康度
  const handoffLines = text.match(/衔接包[^\n]*(?:synced|degraded)/gi) || [];
  for (const line of handoffLines) {
    if (/synced/i.test(line)) result.handoff_health.synced += 1;
    else if (/degraded/i.test(line)) result.handoff_health.degraded += 1;
    else result.handoff_health.unknown += 1;
  }

  // 提取角色状态（尝试解析表格）
  const charSection = text.match(/角色状态[\s\S]*?(?=\n#{1,3}\s|\n---|\[.*?\]|$)/i);
  if (charSection) {
    const tableLines = charSection[0].split('\n').filter(l => l.includes('|') && !l.includes('---'));
    for (const line of tableLines) {
      const parts = line.split('|').map(p => p.trim()).filter(p => p && !p.match(/^(角色|名称|姓名)$/));
      if (parts.length >= 2) {
        result.character_states.push({
          name: parts[0],
          state: parts.slice(1).join(' | '),
        });
      }
    }
  }

  return result;
}

/**
 * 从 伏笔追踪表.md 提取伏笔状态统计
 */
function loadForeshadowTracking(projectRoot) {
  const text = safeReadFile(path.join(projectRoot, '伏笔追踪表.md'));
  if (!text) return { available: false, stats: { green: 0, yellow: 0, red: 0, black: 0 }, entries: [] };

  const result = {
    available: true,
    stats: { green: 0, yellow: 0, red: 0, black: 0 },
    entries: [],
  };

  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('|') && trimmed.includes('---')) continue;

    let status = null;
    if (trimmed.includes('🟢')) { status = 'green'; result.stats.green += 1; }
    else if (trimmed.includes('🟡')) { status = 'yellow'; result.stats.yellow += 1; }
    else if (trimmed.includes('🔴')) { status = 'red'; result.stats.red += 1; }
    else if (trimmed.includes('⚫') || trimmed.includes('⚫️')) { status = 'black'; result.stats.black += 1; }

    // 也匹配文字状态
    if (!status) {
      if (/已回收|已解决|已揭晓|resolved/i.test(trimmed)) { status = 'black'; result.stats.black += 1; }
      else if (/活跃|未回收|待回收|active/i.test(trimmed)) { status = 'green'; result.stats.green += 1; }
      else if (/风险|警告|warning/i.test(trimmed)) { status = 'yellow'; result.stats.yellow += 1; }
      else if (/过期|失效|critical/i.test(trimmed)) { status = 'red'; result.stats.red += 1; }
    }

    if (status) {
      // 清理行内容用于显示
      const display = trimmed.replace(/[🟢🟡🔴⚫⚫️]/g, '').replace(/^\s*[├└│\-•*]+\s*/, '').trim();
      if (display.length > 0) {
        result.entries.push({ status, text: display.slice(0, 80) });
      }
    }
  }

  return result;
}

/**
 * 从 状态快照库.md 提取角色状态表
 */
function loadStateSnapshots(projectRoot) {
  const text = safeReadFile(path.join(projectRoot, '状态快照库.md'));
  if (!text) return { available: false, characters: [] };

  const result = {
    available: true,
    characters: [],
  };

  // 尝试解析角色状态表格
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('|') || trimmed.includes('---')) continue;
    const parts = trimmed.split('|').map(p => p.trim()).filter(p => p);
    // 跳过表头
    if (parts[0] && (parts[0] === '角色' || parts[0] === '姓名' || parts[0] === '名称')) continue;
    if (parts.length >= 2) {
      result.characters.push({
        name: parts[0],
        location: parts[1] || '—',
        body: parts[2] || '—',
        mind: parts[3] || '—',
        items: parts[4] || '—',
      });
    }
  }

  return result;
}

/**
 * 扫描 正文/终稿/ 目录获取已完成章节数
 */
function scanCompletedChapters(projectRoot) {
  const finalDir = path.join(projectRoot, '正文', '终稿');
  const chapters = [];

  try {
    const entries = fs.readdirSync(finalDir);
    for (const entry of entries) {
      if (entry.endsWith('.md') || entry.endsWith('.txt')) {
        // 尝试从文件名提取章节号
        const numMatch = entry.match(/(\d+)/);
        const chapterNum = numMatch ? parseInt(numMatch[1], 10) : null;
        chapters.push({
          filename: entry,
          chapter_num: chapterNum,
          path: path.join(finalDir, entry),
        });
      }
    }
  } catch (_e) {
    // 目录不存在
  }

  chapters.sort((a, b) => {
    if (a.chapter_num !== null && b.chapter_num !== null) return a.chapter_num - b.chapter_num;
    return a.filename.localeCompare(b.filename);
  });

  return chapters;
}

/**
 * 读取 rule-execution-telemetry.json 获取规则执行率
 */
function loadRuleTelemetry(projectRoot) {
  const telemetry = safeReadJSON(path.join(projectRoot, '追踪', 'rule-execution-telemetry.json'));
  if (!telemetry) return { available: false, records: [] };

  const records = Array.isArray(telemetry) ? telemetry : [telemetry];
  return {
    available: true,
    records: records.map(r => ({
      timestamp: r.timestamp || '',
      chapter: r.chapter,
      execution_rate: r.summary ? r.summary.execution_rate : 0,
      rules_passed: r.summary ? r.summary.rules_passed : 0,
      rules_failed: r.summary ? r.summary.rules_failed : 0,
      rules_skipped: r.summary ? r.summary.rules_skipped : 0,
      has_blocking: r.summary ? r.summary.has_blocking : false,
    })),
  };
}

/**
 * 查找并读取章节评分 JSON 文件
 */
function loadChapterScores(projectRoot, chapters) {
  const scores = [];
  const searchDirs = [
    path.join(projectRoot, '追踪'),
    path.join(projectRoot, '正文', '终稿'),
  ];

  for (const chapter of chapters) {
    let scoreData = null;
    const baseName = chapter.filename.replace(/\.(md|txt)$/, '');

    for (const dir of searchDirs) {
      const scorePath = path.join(dir, `${baseName}_评分.json`);
      scoreData = safeReadJSON(scorePath);
      if (scoreData) break;

      // 也尝试 score.json
      const scorePath2 = path.join(dir, `${baseName}_score.json`);
      scoreData = safeReadJSON(scorePath2);
      if (scoreData) break;
    }

    if (scoreData) {
      scores.push({
        chapter: chapter.chapter_num,
        objective_score: scoreData.objective_score || 0,
        total_score: scoreData.total_score || scoreData.objective_score || 0,
        objective_max: scoreData.objective_max || 60,
      });
    }
  }

  return scores;
}

// ════════════════════════════════════════════════════════════
//  SVG 图表生成
// ════════════════════════════════════════════════════════════

/**
 * 生成质量评分趋势折线图（内联SVG）
 */
function generateScoreChartSVG(scores) {
  if (!scores || scores.length === 0) {
    return '<div class="no-data">数据不可用</div>';
  }

  const recent = scores.slice(-10);
  const width = 500;
  const height = 200;
  const padding = { top: 20, right: 20, bottom: 40, left: 40 };
  const chartWidth = width - padding.left - padding.right;
  const chartHeight = height - padding.top - padding.bottom;

  const maxScore = 100;
  const points = recent.map((s, i) => {
    const x = padding.left + (recent.length === 1 ? chartWidth / 2 : (i / (recent.length - 1)) * chartWidth);
    const y = padding.top + chartHeight - (Math.min(s.total_score, maxScore) / maxScore) * chartHeight;
    return { x, y, score: s.total_score, chapter: s.chapter };
  });

  const polyline = points.map(p => `${p.x},${p.y}`).join(' ');

  let svg = `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg" style="font-family: monospace;">`;
  // 坐标轴
  svg += `<line x1="${padding.left}" y1="${padding.top}" x2="${padding.left}" y2="${padding.top + chartHeight}" stroke="#ccc" stroke-width="1"/>`;
  svg += `<line x1="${padding.left}" y1="${padding.top + chartHeight}" x2="${padding.left + chartWidth}" y2="${padding.top + chartHeight}" stroke="#ccc" stroke-width="1"/>`;
  // Y轴刻度
  for (let v = 0; v <= 100; v += 25) {
    const y = padding.top + chartHeight - (v / maxScore) * chartHeight;
    svg += `<line x1="${padding.left - 5}" y1="${y}" x2="${padding.left}" y2="${y}" stroke="#ccc" stroke-width="1"/>`;
    svg += `<text x="${padding.left - 8}" y="${y + 4}" text-anchor="end" font-size="10" fill="#888">${v}</text>`;
  }
  // 80分线（快速通道阈值）
  const y80 = padding.top + chartHeight - (80 / maxScore) * chartHeight;
  svg += `<line x1="${padding.left}" y1="${y80}" x2="${padding.left + chartWidth}" y2="${y80}" stroke="#4CAF50" stroke-width="1" stroke-dasharray="4,2" opacity="0.5"/>`;
  // 60分线（及格线）
  const y60 = padding.top + chartHeight - (60 / maxScore) * chartHeight;
  svg += `<line x1="${padding.left}" y1="${y60}" x2="${padding.left + chartWidth}" y2="${y60}" stroke="#FF9800" stroke-width="1" stroke-dasharray="4,2" opacity="0.5"/>`;
  // 折线
  svg += `<polyline points="${polyline}" fill="none" stroke="#2196F3" stroke-width="2"/>`;
  // 数据点
  for (const p of points) {
    const color = p.score >= 80 ? '#4CAF50' : (p.score >= 60 ? '#FF9800' : '#F44336');
    svg += `<circle cx="${p.x}" cy="${p.y}" r="4" fill="${color}"/>`;
    svg += `<text x="${p.x}" y="${padding.top + chartHeight + 15}" text-anchor="middle" font-size="10" fill="#888">第${p.chapter || '?'}章</text>`;
    svg += `<text x="${p.x}" y="${p.y - 8}" text-anchor="middle" font-size="10" fill="#666">${p.score}</text>`;
  }
  svg += `</svg>`;
  return svg;
}

/**
 * 生成规则执行率柱状图（内联SVG）
 */
function generateExecutionRateChartSVG(telemetryData) {
  if (!telemetryData.available || telemetryData.records.length === 0) {
    return '<div class="no-data">数据不可用</div>';
  }

  const recent = telemetryData.records.slice(-10);
  const width = 500;
  const height = 200;
  const padding = { top: 20, right: 20, bottom: 40, left: 40 };
  const chartWidth = width - padding.left - padding.right;
  const chartHeight = height - padding.top - padding.bottom;
  const barWidth = recent.length > 0 ? Math.min(40, chartWidth / recent.length - 5) : 0;

  let svg = `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg" style="font-family: monospace;">`;
  // 坐标轴
  svg += `<line x1="${padding.left}" y1="${padding.top}" x2="${padding.left}" y2="${padding.top + chartHeight}" stroke="#ccc" stroke-width="1"/>`;
  svg += `<line x1="${padding.left}" y1="${padding.top + chartHeight}" x2="${padding.left + chartWidth}" y2="${padding.top + chartHeight}" stroke="#ccc" stroke-width="1"/>`;
  // Y轴刻度
  for (let v = 0; v <= 100; v += 25) {
    const y = padding.top + chartHeight - (v / 100) * chartHeight;
    svg += `<line x1="${padding.left - 5}" y1="${y}" x2="${padding.left}" y2="${y}" stroke="#ccc" stroke-width="1"/>`;
    svg += `<text x="${padding.left - 8}" y="${y + 4}" text-anchor="end" font-size="10" fill="#888">${v}%</text>`;
  }
  // 80%参考线
  const y80 = padding.top + chartHeight - 0.8 * chartHeight;
  svg += `<line x1="${padding.left}" y1="${y80}" x2="${padding.left + chartWidth}" y2="${y80}" stroke="#4CAF50" stroke-width="1" stroke-dasharray="4,2" opacity="0.5"/>`;

  // 柱状图
  recent.forEach((record, i) => {
    const barHeight = (record.execution_rate / 100) * chartHeight;
    const x = padding.left + i * (barWidth + 5) + 5;
    const y = padding.top + chartHeight - barHeight;
    const color = record.has_blocking ? '#F44336' : (record.execution_rate >= 80 ? '#4CAF50' : '#FF9800');
    svg += `<rect x="${x}" y="${y}" width="${barWidth}" height="${barHeight}" fill="${color}" opacity="0.8"/>`;
    svg += `<text x="${x + barWidth / 2}" y="${padding.top + chartHeight + 15}" text-anchor="middle" font-size="9" fill="#888">${record.chapter || '?'}</text>`;
    svg += `<text x="${x + barWidth / 2}" y="${y - 5}" text-anchor="middle" font-size="9" fill="#666">${record.execution_rate}%</text>`;
  });

  svg += `</svg>`;
  return svg;
}

// ════════════════════════════════════════════════════════════
//  HTML 生成
// ════════════════════════════════════════════════════════════

function escapeHTML(text) {
  if (text === null || text === undefined) return '';
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function generateHTML(data) {
  const { meta, context, foreshadow, snapshots, chapters, telemetry, scores } = data;

  const totalChapters = meta.available ? meta.total_chapters : 0;
  const completedCount = chapters.length;
  const progressPercent = totalChapters > 0 ? Math.min(100, Math.round((completedCount / totalChapters) * 100)) : 0;

  // 角色状态表数据
  let characterRows = '';
  const charSource = snapshots.available && snapshots.characters.length > 0
    ? snapshots.characters
    : (context.available ? context.character_states : []);
  if (charSource.length > 0) {
    for (const char of charSource) {
      characterRows += `<tr>
        <td>${escapeHTML(char.name)}</td>
        <td>${escapeHTML(char.location || char.state || '—')}</td>
        <td>${escapeHTML(char.body || '—')}</td>
        <td>${escapeHTML(char.mind || '—')}</td>
        <td>${escapeHTML(char.items || '—')}</td>
      </tr>`;
    }
  } else {
    characterRows = '<tr><td colspan="5" class="no-data">数据不可用</td></tr>';
  }

  // 伏笔统计
  const fsStats = foreshadow.available ? foreshadow.stats : { green: 0, yellow: 0, red: 0, black: 0 };
  const fsTotal = fsStats.green + fsStats.yellow + fsStats.red + fsStats.black;

  // 伏笔列表
  let foreshadowList = '';
  if (foreshadow.available && foreshadow.entries.length > 0) {
    const recent = foreshadow.entries.slice(-15);
    for (const entry of recent) {
      const emoji = entry.status === 'green' ? '🟢' : (entry.status === 'yellow' ? '🟡' : (entry.status === 'red' ? '🔴' : '⚫'));
      foreshadowList += `<li>${emoji} ${escapeHTML(entry.text)}</li>`;
    }
  } else {
    foreshadowList = '<li class="no-data">数据不可用</li>';
  }

  // 衔接包健康度
  const handoffHealth = context.available ? context.handoff_health : { synced: 0, degraded: 0, unknown: 0 };
  const handoffTotal = handoffHealth.synced + handoffHealth.degraded + handoffHealth.unknown;

  // 已完成章节列表
  let chapterList = '';
  if (completedCount > 0) {
    const recent = chapters.slice(-10);
    for (const ch of recent) {
      chapterList += `<li>第${ch.chapter_num || '?'}章 — ${escapeHTML(ch.filename)}</li>`;
    }
    if (completedCount > 10) {
      chapterList += `<li class="muted">...共 ${completedCount} 章</li>`;
    }
  } else {
    chapterList = '<li class="no-data">数据不可用（正文/终稿/ 目录为空或不存在）</li>';
  }

  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>小说进度面板 — ${escapeHTML(meta.available ? meta.title : '未知作品')}</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
    background: #f5f5f5; color: #333; line-height: 1.6; padding: 20px;
  }
  .container { max-width: 1000px; margin: 0 auto; }
  header {
    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
    color: white; padding: 24px 30px; border-radius: 12px 12px 0 0;
  }
  header h1 { font-size: 24px; margin-bottom: 8px; }
  header .meta { font-size: 14px; opacity: 0.9; }
  header .meta span { margin-right: 16px; }
  .panel {
    background: white; padding: 24px; margin-bottom: 16px;
    border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,0.08);
  }
  .panel:last-child { border-radius: 0 0 12px 12px; }
  .panel h2 {
    font-size: 16px; color: #555; margin-bottom: 16px;
    border-bottom: 2px solid #eee; padding-bottom: 8px;
  }
  .progress-bar-container {
    background: #e0e0e0; border-radius: 20px; height: 30px;
    overflow: hidden; margin: 12px 0;
  }
  .progress-bar {
    background: linear-gradient(90deg, #4CAF50, #81C784); height: 100%;
    border-radius: 20px; transition: width 0.5s ease;
    display: flex; align-items: center; justify-content: center;
    color: white; font-weight: bold; font-size: 14px;
  }
  .progress-info { display: flex; justify-content: space-between; font-size: 14px; color: #666; }
  .grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
  .stat-cards { display: flex; gap: 12px; flex-wrap: wrap; }
  .stat-card {
    background: #f9f9f9; border-radius: 8px; padding: 16px 20px;
    text-align: center; min-width: 100px; flex: 1;
  }
  .stat-card .num { font-size: 28px; font-weight: bold; }
  .stat-card .label { font-size: 12px; color: #888; margin-top: 4px; }
  .stat-card.green .num { color: #4CAF50; }
  .stat-card.yellow .num { color: #FF9800; }
  .stat-card.red .num { color: #F44336; }
  .stat-card.black .num { color: #9E9E9E; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { padding: 8px 12px; text-align: left; border-bottom: 1px solid #eee; }
  th { background: #f5f5f5; font-weight: 600; color: #555; }
  tr:hover { background: #fafafa; }
  .chart-container { text-align: center; padding: 10px 0; }
  .no-data { color: #bbb; font-style: italic; text-align: center; padding: 20px; }
  .muted { color: #999; }
  ul { list-style: none; padding: 0; }
  ul li { padding: 4px 0; font-size: 13px; }
  .handoff-bar { display: flex; height: 24px; border-radius: 4px; overflow: hidden; margin: 8px 0; }
  .handoff-segment { display: flex; align-items: center; justify-content: center; font-size: 11px; color: white; }
  .handoff-synced { background: #4CAF50; }
  .handoff-degraded { background: #FF9800; }
  .handoff-unknown { background: #ccc; }
  footer { text-align: center; padding: 16px; color: #999; font-size: 12px; }
</style>
</head>
<body>
<div class="container">
  <header>
    <h1>${escapeHTML(meta.available ? meta.title : '未知作品')}</h1>
    <div class="meta">
      <span>题材: ${escapeHTML(meta.available ? meta.genre : '—')}</span>
      <span>作者: ${escapeHTML(meta.available ? meta.author : '—')}</span>
      <span>生成时间: ${new Date().toLocaleString('zh-CN')}</span>
    </div>
  </header>

  <div class="panel">
    <h2>总进度</h2>
    <div class="progress-info">
      <span>已完成: ${completedCount} 章</span>
      <span>总计: ${totalChapters > 0 ? totalChapters + ' 章' : '未设定'}</span>
    </div>
    <div class="progress-bar-container">
      <div class="progress-bar" style="width: ${progressPercent}%;">${progressPercent}%</div>
    </div>
    <div class="progress-info">
      <span>当前章节: ${context.available && context.current_chapter ? '第' + context.current_chapter + '章' : '—'}</span>
      <span>下一步: ${context.available ? escapeHTML(context.next_task || '—') : '数据不可用'}</span>
    </div>
  </div>

  <div class="panel">
    <h2>质量评分趋势（近10章）</h2>
    <div class="chart-container">
      ${generateScoreChartSVG(scores)}
    </div>
  </div>

  <div class="panel">
    <h2>规则执行率（近10章）</h2>
    <div class="chart-container">
      ${generateExecutionRateChartSVG(telemetry)}
    </div>
  </div>

  <div class="panel">
    <h2>伏笔状态统计</h2>
    <div class="stat-cards">
      <div class="stat-card green">
        <div class="num">${fsStats.green}</div>
        <div class="label">🟢 活跃</div>
      </div>
      <div class="stat-card yellow">
        <div class="num">${fsStats.yellow}</div>
        <div class="label">🟡 风险</div>
      </div>
      <div class="stat-card red">
        <div class="num">${fsStats.red}</div>
        <div class="label">🔴 过期</div>
      </div>
      <div class="stat-card black">
        <div class="num">${fsStats.black}</div>
        <div class="label">⚫ 已回收</div>
      </div>
    </div>
    ${fsTotal > 0 ? `<ul style="margin-top:12px;">${foreshadowList}</ul>` : ''}
  </div>

  <div class="panel">
    <h2>角色状态</h2>
    <table>
      <thead>
        <tr><th>角色</th><th>位置</th><th>身体状态</th><th>心理状态</th><th>持有物</th></tr>
      </thead>
      <tbody>
        ${characterRows}
      </tbody>
    </table>
  </div>

  <div class="grid-2">
    <div class="panel">
      <h2>衔接包健康度</h2>
      ${handoffTotal > 0 ? `
        <div class="handoff-bar">
          ${handoffHealth.synced > 0 ? `<div class="handoff-segment handoff-synced" style="width: ${(handoffHealth.synced / handoffTotal) * 100}%;">${handoffHealth.synced}</div>` : ''}
          ${handoffHealth.degraded > 0 ? `<div class="handoff-segment handoff-degraded" style="width: ${(handoffHealth.degraded / handoffTotal) * 100}%;">${handoffHealth.degraded}</div>` : ''}
          ${handoffHealth.unknown > 0 ? `<div class="handoff-segment handoff-unknown" style="width: ${(handoffHealth.unknown / handoffTotal) * 100}%;">${handoffHealth.unknown}</div>` : ''}
        </div>
        <div style="font-size: 13px; color: #666; margin-top: 8px;">
          <span style="color:#4CAF50;">■</span> synced: ${handoffHealth.synced} &nbsp;
          <span style="color:#FF9800;">■</span> degraded: ${handoffHealth.degraded} &nbsp;
          <span style="color:#ccc;">■</span> unknown: ${handoffHealth.unknown}
        </div>
      ` : '<div class="no-data">数据不可用</div>'}
    </div>

    <div class="panel">
      <h2>已完成章节（最近10章）</h2>
      <ul>${chapterList}</ul>
    </div>
  </div>

  <footer>
    由 generate-dashboard.js 自动生成 | 数据来源: novel_meta.json, 上下文管理模板.md, 伏笔追踪表.md, 状态快照库.md, rule-execution-telemetry.json
  </footer>
</div>
</body>
</html>`;

  return html;
}

// ════════════════════════════════════════════════════════════
//  主流程
// ════════════════════════════════════════════════════════════

function main() {
  const projectRoot = options.project;

  // 采集所有数据源
  const data = {
    meta: loadNovelMeta(projectRoot),
    context: loadContextTemplate(projectRoot),
    foreshadow: loadForeshadowTracking(projectRoot),
    snapshots: loadStateSnapshots(projectRoot),
    chapters: scanCompletedChapters(projectRoot),
    telemetry: loadRuleTelemetry(projectRoot),
    scores: [],
  };

  // 加载章节评分
  data.scores = loadChapterScores(projectRoot, data.chapters);

  // 生成 HTML
  const html = generateHTML(data);

  // 写入文件
  try {
    const outputDir = path.dirname(options.output);
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }
    fs.writeFileSync(options.output, html, 'utf8');
    console.log(`✅ 进度面板已生成: ${options.output}`);
    console.log(`   数据源状态:`);
    console.log(`   - novel_meta.json:        ${data.meta.available ? '✓' : '✗ 未找到'}`);
    console.log(`   - 上下文管理模板.md:      ${data.context.available ? '✓' : '✗ 未找到'}`);
    console.log(`   - 伏笔追踪表.md:          ${data.foreshadow.available ? '✓' : '✗ 未找到'}`);
    console.log(`   - 状态快照库.md:          ${data.snapshots.available ? '✓' : '✗ 未找到'}`);
    console.log(`   - 正文/终稿/:             ${data.chapters.length > 0 ? `✓ ${data.chapters.length} 章` : '✗ 未找到'}`);
    console.log(`   - rule-execution-telemetry: ${data.telemetry.available ? `✓ ${data.telemetry.records.length} 条记录` : '✗ 未找到'}`);
    console.log(`   - 章节评分:               ${data.scores.length > 0 ? `✓ ${data.scores.length} 个` : '✗ 未找到'}`);
    process.exit(0);
  } catch (error) {
    console.error(`错误: 无法写入 ${options.output}: ${error.message}`);
    process.exit(2);
  }
}

main();

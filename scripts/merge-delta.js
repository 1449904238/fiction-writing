#!/usr/bin/env node
'use strict';

/**
 * merge-delta.js — 衔接包Delta状态校验与合并（V5.4新增）
 *
 * 借鉴 InkOS Delta 状态更新模式：LLM 只输出本章变化（Delta），
 * 本脚本负责校验 Delta 并合并到持久化状态文件。
 *
 * 校验项：
 *   - 格式校验: JSON Schema 合法性
 *   - 章节编号: 必须连续，不可跳章
 *   - 角色ID: 必须存在于 00 设定 JSON 的 character_matrix 中
 *   - 伏笔ID: 必须存在于伏笔追踪表中（新增伏笔除外）
 *   - 数值合法性: 战力等级不可超过 power_system 上限，数值不可倒退
 *   - 生死状态: 已死亡角色不可"复活"（闪回标注除外）
 *
 * 用法：node merge-delta.js --chapter=X --delta=<delta.json> --state=<state.json> [--meta=<metadata.json>] [--foreshadowing=<fs_track.json>]
 *   --chapter=N      当前章节编号
 *   --delta=FILE     chapter_delta JSON 文件路径
 *   --state=FILE     持久化状态文件路径（state/state.json）
 *   --meta=FILE      00设定JSON路径（可选，用于角色ID和战力上限校验）
 *   --foreshadowing=FILE  伏笔追踪表路径（可选，用于伏笔ID校验）
 *   --dry-run        只报告不写入
 *   --json           输出JSON格式结果
 *
 * 校验通过 → 合并到 state.json，输出 sync_status=synced
 * 校验失败 → 不合并，输出 sync_status=degraded + errors列表
 */

const fs = require('fs');
const path = require('path');

const USAGE = `Usage: node merge-delta.js --chapter=N --delta=<file> --state=<file> [--meta=<file>] [--foreshadowing=<file>] [--dry-run] [--json]

Validate and merge chapter delta into persistent state.
  --chapter=N             Current chapter number (required)
  --delta=FILE            chapter_delta JSON file path (required)
  --state=FILE            Persistent state file path (required)
  --meta=FILE             00 metadata JSON path (optional, for character/power validation)
  --foreshadowing=FILE    Foreshadowing tracker file path (optional)
  --dry-run               Report only, don't write merged state
  --json                  Output JSON format result

Report-only by default (dry-run). Add explicit flag to write.`;

// ════════════════════════════════════════════════════════════
//  参数解析
// ════════════════════════════════════════════════════════════

function parseArgs(argv) {
  const args = { dryRun: true, json: false, chapter: null, delta: null, state: null, meta: null, foreshadowing: null };
  for (const arg of argv.slice(2)) {
    if (arg === '--dry-run') { args.dryRun = true; }
    else if (arg === '--write') { args.dryRun = false; }
    else if (arg === '--json') { args.json = true; }
    else if (arg.startsWith('--chapter=')) { args.chapter = parseInt(arg.split('=')[1], 10); }
    else if (arg.startsWith('--delta=')) { args.delta = arg.split('=')[1]; }
    else if (arg.startsWith('--state=')) { args.state = arg.split('=')[1]; }
    else if (arg.startsWith('--meta=')) { args.meta = arg.split('=')[1]; }
    else if (arg.startsWith('--foreshadowing=')) { args.foreshadowing = arg.split('=')[1]; }
    else if (arg === '--help' || arg === '-h') { console.log(USAGE); process.exit(0); }
  }
  if (args.chapter === null || !args.delta || !args.state) {
    console.error(USAGE);
    process.exit(1);
  }
  return args;
}

// ════════════════════════════════════════════════════════════
//  JSON 安全加载
// ════════════════════════════════════════════════════════════

function loadJSON(filePath, label) {
  if (!filePath || !fs.existsSync(filePath)) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch (e) {
    console.error(`[merge-delta] Warning: Failed to parse ${label} file ${filePath}: ${e.message}`);
    return null;
  }
}

// ════════════════════════════════════════════════════════════
//  校验器
// ════════════════════════════════════════════════════════════

/**
 * 校验 Delta JSON 格式合法性
 */
function validateFormat(delta) {
  const errors = [];
  if (!delta || typeof delta !== 'object') {
    errors.push('Delta root is not an object');
    return errors;
  }
  if (typeof delta.chapter !== 'number' || delta.chapter < 1) {
    errors.push(`Invalid chapter number: ${delta.chapter}`);
  }
  if (!delta.delta || typeof delta.delta !== 'object') {
    errors.push('Missing or invalid "delta" sub-object');
    return errors;
  }
  const d = delta.delta;
  // character_states 格式校验
  if (d.character_states && Array.isArray(d.character_states)) {
    d.character_states.forEach((cs, i) => {
      if (!cs.id || typeof cs.id !== 'string') {
        errors.push(`character_states[${i}]: missing or invalid "id"`);
      }
      if (cs.alive !== undefined && typeof cs.alive !== 'boolean') {
        errors.push(`character_states[${i}].alive: must be boolean`);
      }
    });
  }
  // foreshadowing_ops 格式校验
  if (d.foreshadowing_ops && Array.isArray(d.foreshadowing_ops)) {
    d.foreshadowing_ops.forEach((fo, i) => {
      if (!fo.id || typeof fo.id !== 'string') {
        errors.push(`foreshadowing_ops[${i}]: missing or invalid "id"`);
      }
      if (!['plant', 'advance', 'reap', 'hint'].includes(fo.action)) {
        errors.push(`foreshadowing_ops[${i}].action: must be plant|advance|reap|hint, got "${fo.action}"`);
      }
    });
  }
  return errors;
}

/**
 * 校验角色ID是否存在于设定中
 */
function validateCharacterIds(delta, meta) {
  const errors = [];
  if (!meta) return errors; // 无设定文件则跳过
  const knownChars = new Set();
  // 从 character_matrix 提取角色ID
  if (meta.character_matrix) {
    if (Array.isArray(meta.character_matrix)) {
      meta.character_matrix.forEach(c => { if (c.id) knownChars.add(c.id); if (c.name) knownChars.add(c.name); });
    } else if (typeof meta.character_matrix === 'object') {
      Object.keys(meta.character_matrix).forEach(k => knownChars.add(k));
    }
  }
  if (meta.characters && Array.isArray(meta.characters)) {
    meta.characters.forEach(c => { if (c.id) knownChars.add(c.id); if (c.name) knownChars.add(c.name); });
  }
  const d = delta.delta;
  if (d.character_states && Array.isArray(d.character_states)) {
    d.character_states.forEach((cs) => {
      if (cs.id && knownChars.size > 0 && !knownChars.has(cs.id)) {
        errors.push(`Character ID "${cs.id}" not found in metadata character_matrix`);
      }
    });
  }
  return errors;
}

/**
 * 校验伏笔ID是否存在于追踪表中（新增plant除外）
 */
function validateForeshadowingIds(delta, fsTrack) {
  const errors = [];
  if (!fsTrack) return errors;
  const knownFs = new Set();
  if (Array.isArray(fsTrack)) {
    fsTrack.forEach(f => { if (f.id) knownFs.add(f.id); });
  } else if (fsTrack && typeof fsTrack === 'object') {
    if (fsTrack.foreshadowing && Array.isArray(fsTrack.foreshadowing)) {
      fsTrack.foreshadowing.forEach(f => { if (f.id) knownFs.add(f.id); });
    }
  }
  const d = delta.delta;
  if (d.foreshadowing_ops && Array.isArray(d.foreshadowing_ops)) {
    d.foreshadowing_ops.forEach((fo) => {
      if (fo.action !== 'plant' && knownFs.size > 0 && !knownFs.has(fo.id)) {
        errors.push(`Foreshadowing ID "${fo.id}" (action=${fo.action}) not found in tracker (only "plant" allows new IDs)`);
      }
    });
  }
  return errors;
}

/**
 * 校验战力等级不超上限 + 已死亡角色不可复活
 */
function validateStateConsistency(delta, state, meta) {
  const errors = [];
  if (!state) return errors;

  // 获取已死亡角色列表
  const deadChars = new Set();
  if (state.character_states) {
    state.character_states.forEach(cs => {
      if (cs.alive === false) deadChars.add(cs.id);
    });
  }

  // 获取战力上限
  let maxTier = null;
  let tierNames = [];
  if (meta && meta.power_system) {
    if (meta.power_system.max_tier) maxTier = meta.power_system.max_tier;
    if (meta.power_system.tiers && Array.isArray(meta.power_system.tiers)) {
      tierNames = meta.power_system.tiers.map(t => typeof t === 'string' ? t : (t.name || t.id || ''));
    }
  }

  const d = delta.delta;
  if (d.character_states && Array.isArray(d.character_states)) {
    d.character_states.forEach((cs) => {
      // 已死亡角色不可复活
      if (deadChars.has(cs.id) && cs.alive === true) {
        errors.push(`Character "${cs.id}" is already dead but delta sets alive=true (flashback must be marked separately)`);
      }
      // 战力等级校验
      if (cs.combat_level && tierNames.length > 0) {
        const tierIdx = tierNames.indexOf(cs.combat_level);
        if (maxTier && tierIdx > tierNames.indexOf(maxTier)) {
          errors.push(`Character "${cs.id}" combat_level "${cs.combat_level}" exceeds power_system max_tier "${maxTier}"`);
        }
      }
    });
  }

  // 数值不可倒退（年龄变小等）
  if (d.number_anchors_updated && state.number_anchors) {
    const stateNa = state.number_anchors || {};
    const deltaNa = d.number_anchors_updated;
    // 年龄只能增大
    if (deltaNa.character_age && stateNa.character_age) {
      for (const [charId, newAge] of Object.entries(deltaNa.character_age)) {
        const oldAge = stateNa.character_age[charId];
        if (oldAge !== undefined && typeof newAge === 'number' && newAge < oldAge) {
          errors.push(`Character "${charId}" age went backwards: ${oldAge} → ${newAge}`);
        }
      }
    }
  }

  return errors;
}

/**
 * 校验章节编号连续性
 */
function validateChapterContinuity(delta, state) {
  const errors = [];
  if (!state) return errors;
  const expectedChapter = (state.last_merged_chapter || 0) + 1;
  if (delta.chapter !== expectedChapter) {
    errors.push(`Chapter number discontinuity: expected ${expectedChapter} (last_merged=${state.last_merged_chapter}), got ${delta.chapter}`);
  }
  return errors;
}

// ════════════════════════════════════════════════════════════
//  合并器
// ════════════════════════════════════════════════════════════

/**
 * 将 Delta 合并到持久化状态
 */
function mergeDelta(delta, state) {
  const newState = JSON.parse(JSON.stringify(state || { last_merged_chapter: 0, character_states: [], number_anchors: {}, foreshadowing: [], knowledge_boundary: [], timeline: {} }));
  const d = delta.delta;

  // 合并角色状态
  if (d.character_states && Array.isArray(d.character_states)) {
    if (!newState.character_states) newState.character_states = [];
    d.character_states.forEach((cs) => {
      const idx = newState.character_states.findIndex(s => s.id === cs.id);
      if (idx >= 0) {
        // 合并：只更新Delta中出现的字段
        const existing = newState.character_states[idx];
        newState.character_states[idx] = {
          ...existing,
          ...Object.fromEntries(Object.entries(cs).filter(([k, v]) => v !== undefined)),
        };
      } else {
        newState.character_states.push({ ...cs });
      }
    });
  }

  // 合并数值锚点
  if (d.number_anchors_updated) {
    if (!newState.number_anchors) newState.number_anchors = {};
    newState.number_anchors = { ...newState.number_anchors, ...d.number_anchors_updated };
  }

  // 合并伏笔操作
  if (d.foreshadowing_ops && Array.isArray(d.foreshadowing_ops)) {
    if (!newState.foreshadowing) newState.foreshadowing = [];
    d.foreshadowing_ops.forEach((fo) => {
      const idx = newState.foreshadowing.findIndex(f => f.id === fo.id);
      if (idx >= 0) {
        newState.foreshadowing[idx].status = fo.action;
        newState.foreshadowing[idx].last_updated_chapter = delta.chapter;
        if (fo.summary) newState.foreshadowing[idx].last_summary = fo.summary;
      } else if (fo.action === 'plant') {
        newState.foreshadowing.push({
          id: fo.id,
          status: 'plant',
          planted_chapter: delta.chapter,
          last_updated_chapter: delta.chapter,
          last_summary: fo.summary || '',
        });
      }
    });
  }

  // 合并知识边界
  if (d.knowledge_boundary_updates && Array.isArray(d.knowledge_boundary_updates)) {
    if (!newState.knowledge_boundary) newState.knowledge_boundary = [];
    d.knowledge_boundary_updates.forEach((kb) => {
      const idx = newState.knowledge_boundary.findIndex(k => k.character_id === kb.character_id);
      if (idx >= 0) {
        const existing = newState.knowledge_boundary[idx];
        if (kb.newly_known) {
          existing.known = [...new Set([...(existing.known || []), ...kb.newly_known])];
        }
        if (kb.still_unknown) {
          existing.unknown = kb.still_unknown;
        }
      } else {
        newState.knowledge_boundary.push({
          character_id: kb.character_id,
          known: kb.newly_known || [],
          unknown: kb.still_unknown || [],
        });
      }
    });
  }

  // 合并时间线
  if (d.timeline) {
    newState.timeline = { ...newState.timeline, ...d.timeline };
  }

  // 更新最后合并章节
  newState.last_merged_chapter = delta.chapter;
  newState.last_updated = new Date().toISOString();

  return newState;
}

/**
 * 生成Markdown投影（人可读）
 */
function generateMarkdownProjection(state) {
  let md = '# State Projection (auto-generated)\n\n';
  md += `> Last merged chapter: ${state.last_merged_chapter || 0} | Updated: ${state.last_updated || 'N/A'}\n\n`;

  if (state.character_states && state.character_states.length > 0) {
    md += '## Character States\n\n';
    md += '| ID | Location | Physical | Mental | Combat Level | Alive |\n';
    md += '|----|----------|----------|--------|-------------|-------|\n';
    state.character_states.forEach(cs => {
      md += `| ${cs.id || ''} | ${cs.location || ''} | ${cs.physical || ''} | ${cs.mental || ''} | ${cs.combat_level || ''} | ${cs.alive === false ? '❌ Dead' : '✅ Alive'} |\n`;
    });
    md += '\n';
  }

  if (state.foreshadowing && state.foreshadowing.length > 0) {
    md += '## Foreshadowing\n\n';
    md += '| ID | Status | Planted Ch | Last Updated | Summary |\n';
    md += '|----|--------|-----------|-------------|---------|\n';
    state.foreshadowing.forEach(f => {
      md += `| ${f.id} | ${f.status} | ${f.planted_chapter || '-'} | ${f.last_updated_chapter || '-'} | ${f.last_summary || ''} |\n`;
    });
    md += '\n';
  }

  if (state.number_anchors && Object.keys(state.number_anchors).length > 0) {
    md += '## Number Anchors\n\n';
    md += '| Key | Value |\n|-----|-------|\n';
    Object.entries(state.number_anchors).forEach(([k, v]) => {
      md += `| ${k} | ${JSON.stringify(v)} |\n`;
    });
  }

  return md;
}

// ════════════════════════════════════════════════════════════
//  主流程
// ════════════════════════════════════════════════════════════

function main() {
  const args = parseArgs(process.argv);

  // 加载Delta
  const delta = loadJSON(args.delta, 'delta');
  if (!delta) {
    const result = { sync_status: 'degraded', errors: ['Failed to load or parse delta file'], chapter: args.chapter };
    console.log(args.json ? JSON.stringify(result, null, 2) : `[merge-delta] FAILED: ${result.errors[0]}`);
    process.exit(1);
  }

  // 覆盖章节号（命令行参数优先）
  if (args.chapter) delta.chapter = args.chapter;

  // 加载持久化状态
  let state = loadJSON(args.state, 'state');
  if (!state) {
    state = { last_merged_chapter: 0, character_states: [], number_anchors: {}, foreshadowing: [], knowledge_boundary: [], timeline: {} };
  }

  // 加载设定文件（可选）
  const meta = loadJSON(args.meta, 'metadata');

  // 加载伏笔追踪表（可选）
  const fsTrack = loadJSON(args.foreshadowing, 'foreshadowing');

  // 执行校验
  let allErrors = [];
  allErrors = allErrors.concat(validateFormat(delta));
  allErrors = allErrors.concat(validateChapterContinuity(delta, state));
  allErrors = allErrors.concat(validateCharacterIds(delta, meta));
  allErrors = allErrors.concat(validateForeshadowingIds(delta, fsTrack));
  allErrors = allErrors.concat(validateStateConsistency(delta, state, meta));

  const syncStatus = allErrors.length === 0 ? 'synced' : 'degraded';

  // 输出结果
  if (syncStatus === 'synced') {
    const newState = mergeDelta(delta, state);
    const mdProjection = generateMarkdownProjection(newState);

    if (!args.dryRun) {
      // 写入合并后的状态
      const stateDir = path.dirname(args.state);
      if (!fs.existsSync(stateDir)) {
        fs.mkdirSync(stateDir, { recursive: true });
      }
      fs.writeFileSync(args.state, JSON.stringify(newState, null, 2), 'utf-8');
      // 写入Markdown投影
      const mdPath = args.state.replace(/\.json$/, '.md');
      fs.writeFileSync(mdPath, mdProjection, 'utf-8');
    }

    const result = {
      sync_status: 'synced',
      chapter: delta.chapter,
      merged_fields: {
        character_states: (delta.delta.character_states || []).length,
        number_anchors_updated: delta.delta.number_anchors_updated ? Object.keys(delta.delta.number_anchors_updated).length : 0,
        foreshadowing_ops: (delta.delta.foreshadowing_ops || []).length,
        knowledge_boundary_updates: (delta.delta.knowledge_boundary_updates || []).length,
      },
      total_state: {
        characters: newState.character_states.length,
        foreshadowing: newState.foreshadowing.length,
        last_merged_chapter: newState.last_merged_chapter,
      },
      dry_run: args.dryRun,
    };

    if (args.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`[merge-delta] ✅ SYNCED — Chapter ${delta.chapter} merged successfully`);
      console.log(`  Characters tracked: ${newState.character_states.length}`);
      console.log(`  Foreshadowing tracked: ${newState.foreshadowing.length}`);
      console.log(`  Last merged chapter: ${newState.last_merged_chapter}`);
      if (args.dryRun) console.log(`  (dry-run mode — state not written)`);
    }
  } else {
    const result = {
      sync_status: 'degraded',
      chapter: delta.chapter,
      errors: allErrors,
      error_count: allErrors.length,
      dry_run: args.dryRun,
    };

    if (args.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`[merge-delta] ⚠️ DEGRADED — Chapter ${delta.chapter} validation failed (${allErrors.length} errors):`);
      allErrors.forEach((e, i) => console.log(`  ${i + 1}. ${e}`));
      console.log(`\n  State NOT merged. 衔接包 sync_status=degraded.`);
      console.log(`  02b will flag this in quality check. 03a will use degraded mode.`);
    }
  }
}

main();

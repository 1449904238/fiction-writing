#!/usr/bin/env node
'use strict';

/**
 * merge-delta.js — 衔接包 Delta 状态校验与合并（V6.1重写）
 *
 * 修复 P0 问题：
 * - 严格校验：字段类型错误不再静默通过
 * - 未知战力等级视为错误（而非跳过）
 * - 损坏的 state 文件不再被覆盖为全新空状态
 * - 库存使用 inventory 语义（inventory_add/remove -> inventory）
 * - 章节号不一致视为错误（CLI --chapter 与 delta.chapter 必须一致）
 * - 无 meta/foreshadowing 时标记为 partially_verified 而非 synced
 * - 原子写入 + 备份
 *
 * 用法：
 *   node merge-delta.js --chapter=N --delta=<file> --state=<file> [--meta=<file>] [--foreshadowing=<file>] [--write] [--json] [--dry-run]
 *   默认 dry-run（只报告不写入）。加 --write 才会写入。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const USAGE = `Usage: node merge-delta.js --chapter=N --delta=<file> --state=<file> [--meta=<file>] [--foreshadowing=<file>] [--write] [--dry-run] [--json]

Validate and merge chapter delta into persistent state.
  --chapter=N             Current chapter number (required)
  --delta=FILE            chapter_delta JSON file path (required)
  --state=FILE            Persistent state file path (required)
  --meta=FILE             00 metadata JSON path (optional, for character/power validation)
  --foreshadowing=FILE    Foreshadowing tracker file path (optional)
  --write                 Actually write merged state (default is dry-run)
  --dry-run               Report only, don't write (default)
  --json                  Output JSON format result
`;

function parseArgs(argv) {
  const args = { dryRun: true, json: false, chapter: null, delta: null, state: null, meta: null, foreshadowing: null };
  for (const arg of argv.slice(2)) {
    if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--write') args.dryRun = false;
    else if (arg === '--json') args.json = true;
    else if (arg.startsWith('--chapter=')) args.chapter = parseInt(arg.split('=')[1], 10);
    else if (arg.startsWith('--delta=')) args.delta = arg.split('=')[1];
    else if (arg.startsWith('--state=')) args.state = arg.split('=')[1];
    else if (arg.startsWith('--meta=')) args.meta = arg.split('=')[1];
    else if (arg.startsWith('--foreshadowing=')) args.foreshadowing = arg.split('=')[1];
    else if (arg === '--help' || arg === '-h') { console.log(USAGE); process.exit(0); }
  }
  if (args.chapter === null || !args.delta || !args.state) {
    console.error(USAGE);
    process.exit(1);
  }
  if (!Number.isInteger(args.chapter) || args.chapter < 1) {
    console.error('[merge-delta] --chapter must be a positive integer');
    process.exit(1);
  }
  return args;
}

function loadJSONStrict(filePath, label) {
  if (!filePath) return { data: null, error: null, exists: false };
  if (!fs.existsSync(filePath)) return { data: null, error: null, exists: false };
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    if (!raw.trim()) return { data: null, error: label + ' file is empty: ' + filePath, exists: true };
    return { data: JSON.parse(raw), error: null, exists: true };
  } catch (e) {
    return { data: null, error: 'Failed to parse ' + label + ' file ' + filePath + ': ' + e.message, exists: true };
  }
}

function validateFormat(delta) {
  const errors = [];
  if (!delta || typeof delta !== 'object' || Array.isArray(delta)) {
    errors.push('Delta root is not an object');
    return errors;
  }
  if (typeof delta.chapter !== 'number' || !Number.isInteger(delta.chapter) || delta.chapter < 1) {
    errors.push('Invalid chapter number: ' + delta.chapter);
  }
  if (!delta.delta || typeof delta.delta !== 'object' || Array.isArray(delta.delta)) {
    errors.push('Missing or invalid "delta" sub-object');
    return errors;
  }
  const d = delta.delta;
  const allowedKeys = new Set(['character_states','number_anchors_updated','foreshadowing_ops','knowledge_boundary_updates','timeline']);
  for (const k of Object.keys(d)) {
    if (!allowedKeys.has(k)) errors.push('Unknown delta field: "' + k + '" (allowed: ' + Array.from(allowedKeys).join(', ') + ')');
  }
  // character_states strict
  if (d.character_states !== undefined) {
    if (!Array.isArray(d.character_states)) {
      errors.push('character_states must be an array');
    } else {
      d.character_states.forEach((cs, i) => {
        if (!cs || typeof cs !== 'object' || Array.isArray(cs)) {
          errors.push('character_states[' + i + '] must be an object');
          return;
        }
        if (!cs.id || typeof cs.id !== 'string' || !cs.id.trim()) {
          errors.push('character_states[' + i + ']: missing or invalid "id"');
        }
        if (cs.alive !== undefined && typeof cs.alive !== 'boolean') {
          errors.push('character_states[' + i + '].alive: must be boolean');
        }
        if (cs.location !== undefined && typeof cs.location !== 'string') errors.push('character_states[' + i + '].location: must be string');
        if (cs.physical !== undefined && typeof cs.physical !== 'string') errors.push('character_states[' + i + '].physical: must be string');
        if (cs.mental !== undefined && typeof cs.mental !== 'string') errors.push('character_states[' + i + '].mental: must be string');
        if (cs.combat_level !== undefined && typeof cs.combat_level !== 'string') errors.push('character_states[' + i + '].combat_level: must be string');
        if (cs.inventory_add !== undefined && !Array.isArray(cs.inventory_add)) errors.push('character_states[' + i + '].inventory_add: must be array');
        if (cs.inventory_remove !== undefined && !Array.isArray(cs.inventory_remove)) errors.push('character_states[' + i + '].inventory_remove: must be array');
        if (cs.inventory !== undefined) errors.push('character_states[' + i + '].inventory: use inventory_add/inventory_remove, not inventory');
      });
    }
  }
  if (d.number_anchors_updated !== undefined) {
    if (typeof d.number_anchors_updated !== 'object' || Array.isArray(d.number_anchors_updated) || d.number_anchors_updated === null) {
      errors.push('number_anchors_updated must be an object');
    }
  }
  if (d.foreshadowing_ops !== undefined) {
    if (!Array.isArray(d.foreshadowing_ops)) {
      errors.push('foreshadowing_ops must be an array');
    } else {
      d.foreshadowing_ops.forEach((fo, i) => {
        if (!fo || typeof fo !== 'object' || Array.isArray(fo)) {
          errors.push('foreshadowing_ops[' + i + '] must be an object');
          return;
        }
        if (!fo.id || typeof fo.id !== 'string' || !fo.id.trim()) {
          errors.push('foreshadowing_ops[' + i + ']: missing or invalid "id"');
        }
        if (!fo.action || typeof fo.action !== 'string') {
          errors.push('foreshadowing_ops[' + i + '].action: missing');
        } else if (!['plant','advance','hint','reap','archive'].includes(fo.action)) {
          errors.push('foreshadowing_ops[' + i + '].action: must be plant|advance|hint|reap|archive, got "' + fo.action + '"');
        }
        if (fo.summary !== undefined && typeof fo.summary !== 'string') errors.push('foreshadowing_ops[' + i + '].summary: must be string');
      });
    }
  }
  if (d.knowledge_boundary_updates !== undefined) {
    if (!Array.isArray(d.knowledge_boundary_updates)) {
      errors.push('knowledge_boundary_updates must be an array');
    } else {
      d.knowledge_boundary_updates.forEach((kb, i) => {
        if (!kb || typeof kb !== 'object' || Array.isArray(kb)) {
          errors.push('knowledge_boundary_updates[' + i + '] must be an object');
          return;
        }
        if (!kb.character_id || typeof kb.character_id !== 'string' || !kb.character_id.trim()) {
          errors.push('knowledge_boundary_updates[' + i + ']: missing or invalid "character_id"');
        }
        if (kb.newly_known !== undefined && !Array.isArray(kb.newly_known)) errors.push('knowledge_boundary_updates[' + i + '].newly_known: must be array');
        if (kb.still_unknown !== undefined && !Array.isArray(kb.still_unknown)) errors.push('knowledge_boundary_updates[' + i + '].still_unknown: must be array');
      });
    }
  }
  if (d.timeline !== undefined) {
    if (typeof d.timeline !== 'object' || Array.isArray(d.timeline) || d.timeline === null) {
      errors.push('timeline must be an object');
    } else {
      if (d.timeline.current_day !== undefined && typeof d.timeline.current_day !== 'number') errors.push('timeline.current_day: must be number');
    }
  }
  return errors;
}

function validateChapterArg(delta, cliChapter) {
  const errors = [];
  if (delta.chapter !== cliChapter) {
    errors.push('Chapter mismatch: CLI --chapter=' + cliChapter + ' but delta.chapter=' + delta.chapter);
  }
  return errors;
}

function validateCharacterIds(delta, meta) {
  const errors = [];
  if (!meta || !meta.data) return errors;
  const m = meta.data;
  const knownChars = new Set();
  if (m.character_matrix) {
    if (Array.isArray(m.character_matrix)) {
      m.character_matrix.forEach(c => { if (c && c.id) knownChars.add(c.id); if (c && c.name) knownChars.add(c.name); });
    } else if (typeof m.character_matrix === 'object') {
      Object.keys(m.character_matrix).forEach(k => knownChars.add(k));
    }
  }
  if (m.characters && Array.isArray(m.characters)) {
    m.characters.forEach(c => { if (c && c.id) knownChars.add(c.id); if (c && c.name) knownChars.add(c.name); });
  }
  const d = delta.delta;
  if (!d) return errors;
  if (d.character_states && Array.isArray(d.character_states)) {
    d.character_states.forEach(cs => {
      if (cs.id && knownChars.size > 0 && !knownChars.has(cs.id)) {
        errors.push('Character ID "' + cs.id + '" not found in metadata character_matrix');
      }
    });
  }
  return errors;
}

function validateForeshadowingIds(delta, fsTrack) {
  const errors = [];
  if (!fsTrack || !fsTrack.data) return errors;
  const knownFs = new Set();
  const t = fsTrack.data;
  if (Array.isArray(t)) {
    t.forEach(f => { if (f && f.id) knownFs.add(f.id); });
  } else if (t && typeof t === 'object') {
    if (t.foreshadowing && Array.isArray(t.foreshadowing)) {
      t.foreshadowing.forEach(f => { if (f && f.id) knownFs.add(f.id); });
    }
    if (t.foreshadowing_tracker && Array.isArray(t.foreshadowing_tracker)) {
      t.foreshadowing_tracker.forEach(f => { if (f && f.id) knownFs.add(f.id); });
    }
  }
  const d = delta.delta;
  if (!d) return errors;
  if (d.foreshadowing_ops && Array.isArray(d.foreshadowing_ops)) {
    d.foreshadowing_ops.forEach(fo => {
      if (fo.action !== 'plant' && knownFs.size > 0 && !knownFs.has(fo.id)) {
        errors.push('Foreshadowing ID "' + fo.id + '" (action=' + fo.action + ') not found in tracker (only "plant" allows new IDs)');
      }
    });
  }
  return errors;
}

function validateStateConsistency(delta, state, meta) {
  const errors = [];
  if (!state || !state.data) return errors;
  const st = state.data;
  const deadChars = new Set();
  const stateById = new Map();
  if (st.character_states !== undefined) {
    if (Array.isArray(st.character_states)) {
      st.character_states.forEach(cs => { if (cs && cs.id) { stateById.set(cs.id, cs); if (cs.alive === false) deadChars.add(cs.id); } });
    } else {
      errors.push('state.character_states must be an array');
    }
  }
  let maxTier = null;
  let tierNames = [];
  const m = meta && meta.data ? meta.data : null;
  if (m && m.power_system) {
    if (m.power_system.max_tier) maxTier = m.power_system.max_tier;
    if (m.power_system.tiers && Array.isArray(m.power_system.tiers)) {
      tierNames = m.power_system.tiers.map(t => typeof t === 'string' ? t : (t.name || t.id || ''));
    }
  }
  const d = delta.delta;
  if (!d) return errors;
  if (d.character_states && Array.isArray(d.character_states)) {
    d.character_states.forEach(cs => {
      if (deadChars.has(cs.id) && cs.alive === true) {
        errors.push('Character "' + cs.id + '" is already dead but delta sets alive=true (flashback must be marked separately)');
      }
      if (cs.combat_level && tierNames.length > 0) {
        const tierIdx = tierNames.indexOf(cs.combat_level);
        if (tierIdx === -1) {
          errors.push('Character "' + cs.id + '" combat_level "' + cs.combat_level + '" is not in power_system tiers [' + tierNames.join(', ') + ']');
        } else if (maxTier && tierNames.indexOf(maxTier) !== -1 && tierIdx > tierNames.indexOf(maxTier)) {
          errors.push('Character "' + cs.id + '" combat_level "' + cs.combat_level + '" exceeds power_system max_tier "' + maxTier + '"');
        } else {
          const existing = stateById.get(cs.id);
          // 战力只进不退（对齐“数值不可倒退”原则）
          if (existing && existing.combat_level) {
            const oldIdx = tierNames.indexOf(existing.combat_level);
            if (oldIdx !== -1 && tierIdx < oldIdx) {
              errors.push('Character "' + cs.id + '" combat_level went backwards: ' + existing.combat_level + ' -> ' + cs.combat_level);
            }
          }
        }
      }
    });
  }
  if (d.number_anchors_updated && st.number_anchors) {
    const stateNa = st.number_anchors || {};
    const deltaNa = d.number_anchors_updated;
    if (deltaNa.character_age && stateNa.character_age) {
      for (const [charId, newAge] of Object.entries(deltaNa.character_age)) {
        const oldAge = stateNa.character_age[charId];
        if (oldAge !== undefined && typeof newAge === 'number' && newAge < oldAge) {
          errors.push('Character "' + charId + '" age went backwards: ' + oldAge + ' -> ' + newAge);
        }
      }
    }
    // 扁平关键值年龄倒退（如 "主角年龄"）：覆盖嵌套之外的 key
    for (const [k, newVal] of Object.entries(deltaNa)) {
      if (!/年龄|age/i.test(k)) continue;
      const oldVal = stateNa[k];
      if (oldVal !== undefined && typeof newVal === 'number' && typeof oldVal === 'number' && newVal < oldVal) {
        errors.push('Number anchor "' + k + '" went backwards: ' + oldVal + ' -> ' + newVal);
      }
    }
  }
  return errors;
}

function validateChapterContinuity(delta, state) {
  const errors = [];
  if (!state || !state.data) return errors;
  const expectedChapter = (state.data.last_merged_chapter || 0) + 1;
  if (delta.chapter !== expectedChapter) {
    errors.push('Chapter number discontinuity: expected ' + expectedChapter + ' (last_merged=' + state.data.last_merged_chapter + '), got ' + delta.chapter);
  }
  return errors;
}

function mergeDelta(delta, stateData) {
  const newState = JSON.parse(JSON.stringify(stateData || { last_merged_chapter: 0, character_states: [], number_anchors: {}, foreshadowing: [], knowledge_boundary: [], timeline: {} }));
  // 残缺 state 补齐默认结构，避免后续对 undefined.length 崩溃
  if (!Array.isArray(newState.character_states)) newState.character_states = [];
  if (!Array.isArray(newState.foreshadowing)) newState.foreshadowing = [];
  if (!Array.isArray(newState.knowledge_boundary)) newState.knowledge_boundary = [];
  if (!newState.number_anchors || typeof newState.number_anchors !== 'object' || Array.isArray(newState.number_anchors)) newState.number_anchors = {};
  if (!newState.timeline || typeof newState.timeline !== 'object' || Array.isArray(newState.timeline)) newState.timeline = {};
  const d = delta.delta;
  if (d.character_states && Array.isArray(d.character_states)) {
    if (!newState.character_states) newState.character_states = [];
    d.character_states.forEach(cs => {
      const idx = newState.character_states.findIndex(s => s.id === cs.id);
      if (idx >= 0) {
        const existing = newState.character_states[idx];
        // handle inventory semantics
        let newInventory = Array.isArray(existing.inventory) ? [...existing.inventory] : [];
        // migrate legacy inventory_add/remove if present in existing
        if (existing.inventory_add || existing.inventory_remove) {
          // legacy shouldn't happen after fix, but handle migration
          if (existing.inventory_add) newInventory = [...new Set([...newInventory, ...existing.inventory_add])];
          if (existing.inventory_remove) newInventory = newInventory.filter(x => !existing.inventory_remove.includes(x));
          delete existing.inventory_add;
          delete existing.inventory_remove;
        }
        if (cs.inventory_add) {
          for (const it of cs.inventory_add) if (!newInventory.includes(it)) newInventory.push(it);
        }
        if (cs.inventory_remove) {
          newInventory = newInventory.filter(x => !cs.inventory_remove.includes(x));
        }
        const merged = { ...existing };
        for (const [k,v] of Object.entries(cs)) {
          if (v !== undefined && k !== 'inventory_add' && k !== 'inventory_remove') merged[k] = v;
        }
        merged.inventory = newInventory;
        // clean legacy keys if any
        delete merged.inventory_add;
        delete merged.inventory_remove;
        newState.character_states[idx] = merged;
      } else {
        const entry = { ...cs };
        const inv = [];
        if (entry.inventory_add) { for (const it of entry.inventory_add) if (!inv.includes(it)) inv.push(it); delete entry.inventory_add; }
        if (entry.inventory_remove) delete entry.inventory_remove;
        entry.inventory = inv;
        newState.character_states.push(entry);
      }
    });
  }
  if (d.number_anchors_updated) {
    if (!newState.number_anchors) newState.number_anchors = {};
    // shallow merge top-level keys, deep merge for nested objects like character_age
    for (const [k,v] of Object.entries(d.number_anchors_updated)) {
      if (v && typeof v === 'object' && !Array.isArray(v) && newState.number_anchors[k] && typeof newState.number_anchors[k] === 'object') {
        newState.number_anchors[k] = { ...newState.number_anchors[k], ...v };
      } else {
        newState.number_anchors[k] = v;
      }
    }
  }
  if (d.foreshadowing_ops && Array.isArray(d.foreshadowing_ops)) {
    if (!newState.foreshadowing) newState.foreshadowing = [];
    d.foreshadowing_ops.forEach(fo => {
      const idx = newState.foreshadowing.findIndex(f => f.id === fo.id);
      if (idx >= 0) {
        newState.foreshadowing[idx].status = fo.action;
        newState.foreshadowing[idx].last_updated_chapter = delta.chapter;
        if (fo.summary) newState.foreshadowing[idx].last_summary = fo.summary;
      } else if (fo.action === 'plant') {
        newState.foreshadowing.push({ id: fo.id, status: 'plant', planted_chapter: delta.chapter, last_updated_chapter: delta.chapter, last_summary: fo.summary || '' });
      }
    });
  }
  if (d.knowledge_boundary_updates && Array.isArray(d.knowledge_boundary_updates)) {
    if (!newState.knowledge_boundary) newState.knowledge_boundary = [];
    d.knowledge_boundary_updates.forEach(kb => {
      const idx = newState.knowledge_boundary.findIndex(k => k.character_id === kb.character_id);
      if (idx >= 0) {
        const existing = newState.knowledge_boundary[idx];
        if (kb.newly_known) existing.known = [...new Set([...(existing.known || []), ...kb.newly_known])];
        if (kb.still_unknown) existing.unknown = kb.still_unknown;
      } else {
        newState.knowledge_boundary.push({ character_id: kb.character_id, known: kb.newly_known || [], unknown: kb.still_unknown || [] });
      }
    });
  }
  if (d.timeline) {
    newState.timeline = { ...newState.timeline, ...d.timeline };
  }
  newState.last_merged_chapter = delta.chapter;
  newState.last_updated = new Date().toISOString();
  return newState;
}

function generateMarkdownProjection(state) {
  let md = '# State Projection (auto-generated)\n\n';
  md += '> Last merged chapter: ' + (state.last_merged_chapter || 0) + ' | Updated: ' + (state.last_updated || 'N/A') + '\n\n';
  if (state.character_states && state.character_states.length > 0) {
    md += '## Character States\n\n';
    md += '| ID | Location | Physical | Mental | Inventory | Combat Level | Alive |\n';
    md += '|----|----------|----------|--------|-----------|-------------|-------|\n';
    state.character_states.forEach(cs => {
      const inv = Array.isArray(cs.inventory) ? cs.inventory.join(', ') : '';
      md += '| ' + (cs.id || '') + ' | ' + (cs.location || '') + ' | ' + (cs.physical || '') + ' | ' + (cs.mental || '') + ' | ' + inv + ' | ' + (cs.combat_level || '') + ' | ' + (cs.alive === false ? '❌ Dead' : '✅ Alive') + ' |\n';
    });
    md += '\n';
  }
  if (state.foreshadowing && state.foreshadowing.length > 0) {
    md += '## Foreshadowing\n\n';
    md += '| ID | Status | Planted Ch | Last Updated | Summary |\n';
    md += '|----|--------|-----------|-------------|---------|\n';
    state.foreshadowing.forEach(f => {
      md += '| ' + f.id + ' | ' + f.status + ' | ' + (f.planted_chapter || '-') + ' | ' + (f.last_updated_chapter || '-') + ' | ' + (f.last_summary || '') + ' |\n';
    });
    md += '\n';
  }
  if (state.number_anchors && Object.keys(state.number_anchors).length > 0) {
    md += '## Number Anchors\n\n';
    md += '| Key | Value |\n|-----|-------|\n';
    Object.entries(state.number_anchors).forEach(([k,v]) => { md += '| ' + k + ' | ' + JSON.stringify(v) + ' |\n'; });
  }
  return md;
}

function atomicWriteJson(filePath, data) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmp = filePath + '.tmp.' + crypto.randomBytes(4).toString('hex');
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
  // verify tmp is valid JSON
  JSON.parse(fs.readFileSync(tmp, 'utf-8'));
  // backup existing
  if (fs.existsSync(filePath)) {
    const backup = filePath + '.bak.' + Date.now();
    try { fs.copyFileSync(filePath, backup); } catch(e) {}
  }
  fs.renameSync(tmp, filePath);
}

function atomicWriteText(filePath, text) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmp = filePath + '.tmp.' + crypto.randomBytes(4).toString('hex');
  fs.writeFileSync(tmp, text, 'utf-8');
  fs.renameSync(tmp, filePath);
}

function main() {
  const args = parseArgs(process.argv);
  const deltaLoad = loadJSONStrict(args.delta, 'delta');
  if (deltaLoad.error) {
    const result = { sync_status: 'degraded', errors: [deltaLoad.error], chapter: args.chapter };
    console.log(args.json ? JSON.stringify(result, null, 2) : '[merge-delta] FAILED: ' + deltaLoad.error);
    process.exit(1);
  }
  const delta = deltaLoad.data;
  if (!delta) {
    const result = { sync_status: 'degraded', errors: ['Failed to load or parse delta file'], chapter: args.chapter };
    console.log(args.json ? JSON.stringify(result, null, 2) : '[merge-delta] FAILED: ' + result.errors[0]);
    process.exit(1);
  }
  const stateLoad = loadJSONStrict(args.state, 'state');
  if (stateLoad.error) {
    const result = { sync_status: 'degraded', errors: [stateLoad.error, 'State file corrupted — refusing to overwrite. Fix the file or restore from backup.'], chapter: args.chapter };
    console.log(args.json ? JSON.stringify(result, null, 2) : '[merge-delta] ⚠️ DEGRADED — State file corrupted: ' + stateLoad.error + '\n  Refusing to overwrite. Restore state/state.json from backup or fix JSON.');
    process.exit(1);
  }
  let stateData = stateLoad.data;
  if (!stateData) {
    stateData = { last_merged_chapter: 0, character_states: [], number_anchors: {}, foreshadowing: [], knowledge_boundary: [], timeline: {} };
  }
  const metaLoad = loadJSONStrict(args.meta, 'metadata');
  const fsLoad = loadJSONStrict(args.foreshadowing, 'foreshadowing');
  // meta/foreshadowing parse errors are warnings, not blocking, but affect sync_status
  const metaParseError = metaLoad.error;
  const fsParseError = fsLoad.error;

  let allErrors = [];
  allErrors = allErrors.concat(validateFormat(delta));
  allErrors = allErrors.concat(validateChapterArg(delta, args.chapter));
  allErrors = allErrors.concat(validateChapterContinuity(delta, { data: stateData }));
  allErrors = allErrors.concat(validateCharacterIds(delta, metaLoad.exists ? metaLoad : null));
  allErrors = allErrors.concat(validateForeshadowingIds(delta, fsLoad.exists ? fsLoad : null));
  allErrors = allErrors.concat(validateStateConsistency(delta, { data: stateData }, metaLoad.exists ? metaLoad : null));
  if (metaParseError) allErrors.push('Metadata parse warning treated as degraded: ' + metaParseError);
  if (fsParseError) allErrors.push('Foreshadowing tracker parse warning: ' + fsParseError);

  const hasValidationErrors = allErrors.length > 0;
  const missingOptionalData = (!metaLoad.exists || !fsLoad.exists);
  let syncStatus;
  if (hasValidationErrors) syncStatus = 'degraded';
  else if (missingOptionalData) syncStatus = 'partially_verified';
  else syncStatus = 'synced';

  if (syncStatus === 'degraded') {
    const result = { sync_status: 'degraded', chapter: delta.chapter, errors: allErrors, error_count: allErrors.length, dry_run: args.dryRun };
    if (args.json) console.log(JSON.stringify(result, null, 2));
    else {
      console.log('[merge-delta] \u26a0\uFE0F DEGRADED — Chapter ' + delta.chapter + ' validation failed (' + allErrors.length + ' errors):');
      allErrors.forEach((e,i) => console.log('  ' + (i+1) + '. ' + e));
      console.log('\n  State NOT merged. sync_status=degraded.');
    }
    process.exit(1);
  }

  const newState = mergeDelta(delta, stateData);
  const mdProjection = generateMarkdownProjection(newState);

  if (!args.dryRun) {
    atomicWriteJson(args.state, newState);
    const mdPath = args.state.replace(/\.json$/, '.md');
    atomicWriteText(mdPath, mdProjection);
  }

  const result = {
    sync_status: syncStatus,
    chapter: delta.chapter,
    merged_fields: {
      character_states: (delta.delta.character_states || []).length,
      number_anchors_updated: delta.delta.number_anchors_updated ? Object.keys(delta.delta.number_anchors_updated).length : 0,
      foreshadowing_ops: (delta.delta.foreshadowing_ops || []).length,
      knowledge_boundary_updates: (delta.delta.knowledge_boundary_updates || []).length,
    },
    total_state: { characters: (newState.character_states || []).length, foreshadowing: (newState.foreshadowing || []).length, last_merged_chapter: newState.last_merged_chapter },
    dry_run: args.dryRun,
    warnings: missingOptionalData ? ['Missing --meta or --foreshadowing: full validation not possible, marked as partially_verified'] : []
  };
  if (args.json) console.log(JSON.stringify(result, null, 2));
  else {
    const label = syncStatus === 'synced' ? '✅ SYNCED' : '⚠️ PARTIALLY_VERIFIED';
    console.log('[merge-delta] ' + label + ' — Chapter ' + delta.chapter + ' merged successfully');
    console.log('  Characters tracked: ' + newState.character_states.length);
    console.log('  Foreshadowing tracked: ' + newState.foreshadowing.length);
    console.log('  Last merged chapter: ' + newState.last_merged_chapter);
    if (missingOptionalData) console.log('  Note: missing --meta/--foreshadowing, full validation skipped');
    if (args.dryRun) console.log('  (dry-run mode — state not written)');
  }
}

main();

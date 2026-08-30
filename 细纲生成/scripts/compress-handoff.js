#!/usr/bin/env node
'use strict';

/**
 * compress-handoff.js — 衔接包自动压缩（V6.1重写）
 *
 * 修复 P0 问题：
 * - 支持当前模板标题格式：【衔接包 — 第X章】/【衔接包】/ [衔接包]
 * - 支持带 P0/P1 后缀的字段标题：[角色当前状态表] 【P0】等
 * - 统一 CLI：--threshold/--keep/--write/--dry-run/--json/--output
 * - --write 时写入输出文件并可选 --archive 归档原文件
 * - 修复压缩比与统计
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const USAGE = `Usage: node compress-handoff.js [--threshold=10] [--keep=3] [--write] [--dry-run] [--json] [--output=FILE] [--archive=DIR] <files...>

Compress old handoff packages when chain exceeds threshold.
  --threshold=N   trigger compression when chain > N (default: 10)
  --keep=N        keep recent N chapters uncompressed (default: 3)
  --write         actually write compressed summary (default is dry-run)
  --dry-run       report only, don't write (default)
  --json          output JSON summary
  --output=FILE   output file path (default: compressed_handoff_summary.txt next to first input)
  --archive=DIR   if set with --write, move compressed source files to this directory
`;

function extractHandoff(text) {
  // 优先匹配当前模板：【衔接包 — 第X章】或【衔接包】
  const patterns = [
    /【衔接包[^】]*】[\s\S]*?(?=\n#{1,3}\s|\n【衔接包|\n\[衔接包|\n\[章节|\n# Ch\.|\n## Ch\.|$)/,
    /\[衔接包[^\]]*\][\s\S]*?(?=\n#{1,3}\s|\n【衔接包|\n\[衔接包|\n\[章节|\n# Ch\.|$)/,
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (m) return m[0];
  }
  return text;
}

function extractSection(text, title, strict) {
  // 支持：[标题] 【P0】 / 【标题】/ ## 标题 / [标题] 等后缀
  const escaped = title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const patterns = [
    new RegExp('\\[' + escaped + '[^\\]]*\\][^\\n]*\\n[\\s\\S]*?(?=\\n\\[[^\\]]+\\]|\\n【[^】]+】|\\n#{1,3}\\s|$)', 'i'),
    new RegExp('【' + escaped + '[^】]*】[^\\n]*\\n[\\s\\S]*?(?=\\n\\[|\\n【|\\n#{1,3}\\s|$)', 'i'),
    new RegExp('(?:^|\\n)#{1,3}\\s*' + escaped + '[^\\n]*\\n[\\s\\S]*?(?=\\n#{1,3}\\s|$)', 'i'),
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (m) return m[0].trim();
  }
  // fallback: simple contains
  if (!strict && text.includes(title)) {
    const idx = text.indexOf(title);
    return text.slice(idx, Math.min(text.length, idx + 2000)).trim();
  }
  return null;
}

function parseHandoff(text) {
  const handoff = extractHandoff(text);
  const result = {
    raw_length: handoff.length,
    prev_recap: extractSection(handoff, '前章回顾'),
    character_states: extractSection(handoff, '角色当前状态'),
    must_continue: extractSection(handoff, '必须延续的细节'),
    forbidden: extractSection(handoff, '禁止矛盾'),
    state_lock: extractSection(handoff, '状态锁定'),
    value_lock: extractSection(handoff, '数值锁定'),
    knowledge_boundary: extractSection(handoff, '角色知识边界'),
    flashback: extractSection(handoff, '闪回标注'),
    new_state: extractSection(handoff, '本章新增状态'),
    foreshadow: extractSection(handoff, '伏笔', true),
    quality_budget: extractSection(handoff, '质感预算'),
    dedup_list: extractSection(handoff, '跨章去重'),
  };
  for (const [key, val] of Object.entries(result)) {
    if (key === 'raw_length') continue;
    if (!val || val.trim().length === 0) result[key] = null;
  }
  return result;
}

function extractFinalCharacterStates(states) {
  if (!states) return [];
  // 兼容多种表头：角色/角色当前状态 等
  const lines = states.split('\n').filter(l => l.includes('|') && !l.includes('---') && !l.match(/\|\s*角色\s*\|/));
  // fallback if header filter removed all
  const candidateLines = lines.length ? lines : states.split('\n').filter(l => l.includes('|') && !l.includes('---'));
  const characters = [];
  for (const line of candidateLines) {
    const parts = line.split('|').map(p => p.trim()).filter(p => p);
    if (parts.length >= 2) {
      // skip header row containing "位置" etc if it slipped through
      if (parts[0] === '角色' || parts[1] === '位置') continue;
      // also skip markdown separator remnants
      if (parts.every(p => /^[-:]+$/.test(p))) continue;
      characters.push({
        name: parts[0],
        location: parts[1] || '',
        body: parts[2] || '',
        mind: parts[3] || '',
        items: parts[4] || '',
        power: parts[5] || '',
        alive: parts[6] || '',
      });
    }
  }
  return characters;
}

function extractForeshadowing(foreshadowSection, newStates) {
  const foreshadows = [];
  const src = [foreshadowSection, newStates].filter(Boolean).join('\n');
  if (!src) return foreshadows;
  // 伏笔候选行必须命中伏笔关键词，防止“本章新增状态”的普通列表行（状态/数值变更）混入
  const FS_KEYWORD = /FS[-_ ]?\d|伏笔|伏线|回收|揭晓|揭底|REAP|埋设|待解/;
  const lines = src.split('\n').filter(l => FS_KEYWORD.test(l));
  for (const line of lines) {
    const cleaned = line.replace(/[├└│]/g, '').trim().replace(/^[-•]\s*/, '');
    if (!cleaned) continue;
    // skip table lines
    if (cleaned.includes('|')) continue;
    const isResolved = cleaned.includes('已回收') || cleaned.includes('已揭晓') || cleaned.includes('已解决') || cleaned.includes('REAP');
    const isActive = !isResolved && (cleaned.includes('未回收') || cleaned.includes('待回收') || cleaned.includes('活跃') || cleaned.includes('埋设') || cleaned.includes('推进') || /伏笔|伏线|FS[-_ ]?\d/.test(cleaned));
    foreshadows.push({ content: cleaned, status: isResolved ? 'resolved' : (isActive ? 'active' : 'unknown') });
  }
  return foreshadows;
}

function compressHandoffs(parsedHandoffs, startIndex, endIndex) {
  const toCompress = parsedHandoffs.slice(startIndex, endIndex);
  const characterTrajectory = {};
  for (const handoff of toCompress) {
    if (handoff.character_states) {
      const chars = extractFinalCharacterStates(handoff.character_states);
      for (const char of chars) {
        characterTrajectory[char.name] = char;
      }
    }
  }
  const activeForeshadows = [];
  const resolvedForeshadows = [];
  for (const handoff of toCompress) {
    const foreshadows = extractForeshadowing(handoff.foreshadow, handoff.new_state);
    for (const f of foreshadows) {
      if (f.status === 'active') {
        if (!activeForeshadows.some(a => a.content === f.content)) activeForeshadows.push(f);
      } else if (f.status === 'resolved') {
        if (!resolvedForeshadows.some(r => r.content === f.content)) resolvedForeshadows.push(f);
      }
    }
  }
  const activeConstraints = [];
  for (const handoff of toCompress) {
    if (handoff.forbidden) {
      const lines = handoff.forbidden.split('\n').filter(l => {
        const t = l.trim();
        if (!t || t.startsWith('[') || t.startsWith('#')) return false;
        return t.includes('❌') || t.includes('不能') || t.includes('禁止');
      });
      for (const line of lines) {
        const cleaned = line.replace(/[├└│❌]/g, '').trim().replace(/^[─\-—•]\s*/, '');
        if (cleaned && !activeConstraints.includes(cleaned) && cleaned.length < 500) activeConstraints.push(cleaned);
      }
    }
  }
  const activeLocks = [];
  for (const handoff of toCompress) {
    if (handoff.state_lock) {
      const lines = handoff.state_lock.split('\n').filter(l => l.includes('→') || l.includes('不能') || l.includes('锁定'));
      for (const line of lines) {
        const cleaned = line.replace(/[├└│]/g, '').trim();
        if (cleaned && !activeLocks.includes(cleaned) && cleaned.length < 500) activeLocks.push(cleaned);
      }
    }
  }
  const valueLocks = [];
  for (const handoff of toCompress) {
    if (handoff.value_lock) {
      const lines = handoff.value_lock.split('\n').filter(l => l.includes('=') || l.includes('：') || l.includes(':'));
      for (const line of lines) {
        const cleaned = line.replace(/[├└│]/g, '').trim();
        if (cleaned && !valueLocks.some(v => v === cleaned) && cleaned.length < 500) valueLocks.push(cleaned);
      }
    }
  }
  let summary = '═══════════════════════════════════════\n';
  summary += '【压缩衔接包摘要】\n';
  const firstNo = parsedHandoffs[startIndex] && parsedHandoffs[startIndex].chapterNo != null ? parsedHandoffs[startIndex].chapterNo : startIndex + 1;
  const lastEl = parsedHandoffs[endIndex - 1];
  const lastNo = lastEl && lastEl.chapterNo != null ? lastEl.chapterNo : endIndex;
  summary += '压缩范围: 第' + firstNo + '章 ~ 第' + lastNo + '章\n';
  summary += '压缩时间: ' + new Date().toISOString().split('T')[0] + '\n';
  const originalTotal = toCompress.reduce((sum, h) => sum + h.raw_length, 0);
  summary += '原始总字数: ' + originalTotal + ' → 压缩后约 0 字\n';
  summary += '═══════════════════════════════════════\n\n';
  summary += '[角色最终状态]\n';
  if (Object.keys(characterTrajectory).length > 0) {
    summary += '| 角色 | 位置 | 身体状态 | 心理状态 | 关键持有物 | 战力等级 | 生死状态 |\n';
    for (const [name, char] of Object.entries(characterTrajectory)) {
      summary += '| ' + name + ' | ' + char.location + ' | ' + char.body + ' | ' + char.mind + ' | ' + char.items + ' | ' + char.power + ' | ' + char.alive + ' |\n';
    }
  } else {
    summary += '（无角色状态数据）\n';
  }
  summary += '\n';
  summary += '[活跃伏笔（未回收）]\n';
  if (activeForeshadows.length > 0) {
    for (const f of activeForeshadows) summary += '├─ ' + f.content + '\n';
  } else summary += '（无活跃伏笔）\n';
  summary += '\n';
  if (resolvedForeshadows.length > 0) {
    summary += '[已回收伏笔（仅记录，不再展开）]\n';
    for (const f of resolvedForeshadows) summary += '├─ ' + f.content + '\n';
    summary += '\n';
  }
  summary += '[仍有效的禁止矛盾]\n';
  if (activeConstraints.length > 0) {
    for (const c of activeConstraints) summary += '├─ ❌ ' + c + '\n';
  } else summary += '（无）\n';
  summary += '\n';
  if (activeLocks.length > 0) {
    summary += '[状态锁定（仍有效）]\n';
    for (const l of activeLocks) summary += '├─ ' + l + '\n';
    summary += '\n';
  }
  if (valueLocks.length > 0) {
    summary += '[数值锁定（当前值）]\n';
    for (const v of valueLocks) summary += '├─ ' + v + '\n';
    summary += '\n';
  }
  summary += '═══════════════════════════════════════\n';
  summary += '⚠️ 此为自动压缩摘要，如需详细历史请查看 archive/ 目录\n';
  summary += '═══════════════════════════════════════\n';
  const statPlaceholder = '压缩后约 0 字';
  // 先去掉占位数字，再按“最终长度”自洽回填，避免把占位符自身计入压缩字数
  const bodyLen = summary.replace(statPlaceholder, '').length;
  let finalLen = bodyLen + 7;
  for (let k = 0; k < 5; k += 1) finalLen = bodyLen + '压缩后约 '.length + String(finalLen).length + ' 字'.length;
  const compressedLength = finalLen;
  summary = summary.replace(statPlaceholder, '压缩后约 ' + compressedLength + ' 字');
  return {
    summary,
    stats: {
      original_total: originalTotal,
      compressed: compressedLength,
      compression_ratio: parseFloat((compressedLength / Math.max(1, originalTotal)).toFixed(2)),
      chapters_compressed: toCompress.length,
      active_foreshadows: activeForeshadows.length,
      resolved_foreshadows: resolvedForeshadows.length,
      active_constraints: activeConstraints.length,
      characters_tracked: Object.keys(characterTrajectory).length,
    }
  };
}

function chapterNumberFromName(name) {
  const m = /(?:[Cc]h|第)(\d+)/.exec(name);
  return m ? parseInt(m[1], 10) : null;
}

function readTextFile(file) {
  try {
    return fs.readFileSync(file, 'utf-8');
  } catch (e) {
    console.error('无法读取文件 ' + file + ': ' + e.message);
    process.exit(2);
  }
}

/** 把被压缩的源文件移动到归档目录（copy 成功后才删除源文件）。 */
function archiveSources(srcFiles, archiveDir) {
  if (!archiveDir) return 0;
  if (!fs.existsSync(archiveDir)) fs.mkdirSync(archiveDir, { recursive: true });
  let moved = 0;
  for (const src of srcFiles) {
    const dest = path.join(archiveDir, path.basename(src));
    try {
      fs.copyFileSync(src, dest);
      fs.unlinkSync(src);
      moved += 1;
    } catch (e) {
      console.error('⚠️ 归档失败 ' + src + ': ' + e.message);
    }
  }
  return moved;
}

function main() {
  const args = process.argv.slice(2);
  const files = [];
  let threshold = 10;
  let keep = 3;
  let dryRun = true;
  let jsonMode = false;
  let outputFile = null;
  let archiveDir = null;
  for (const arg of args) {
    if (arg.startsWith('--threshold=')) threshold = parseInt(arg.substring(12), 10) || 10;
    else if (arg.startsWith('--keep=')) keep = parseInt(arg.substring(7), 10) || 3;
    else if (arg === '--dry-run') dryRun = true;
    else if (arg === '--write') dryRun = false;
    else if (arg === '--json') jsonMode = true;
    else if (arg.startsWith('--output=')) outputFile = arg.substring(9);
    else if (arg.startsWith('--archive=')) archiveDir = arg.substring(10);
    else if (arg === '--help' || arg === '-h') { console.log(USAGE); process.exit(0); }
    else files.push(arg);
  }
  if (files.length === 0) { console.error(USAGE); process.exit(1); }
  let parsedHandoffs = [];
  for (const file of files) {
    const text = readTextFile(file);
    const parsed = parseHandoff(text);
    parsed.file = path.basename(file);
    parsed.chapterNo = chapterNumberFromName(path.basename(file));
    parsedHandoffs.push(parsed);
  }
  // 按文件名中的章节号排序（无章节号的文件保持传入顺序，排在有号文件之后），
  // 避免 glob（Ch1, Ch10, Ch11, Ch2...）字典序导致压错章节。
  const indexed = parsedHandoffs.map((p, i) => ({ p, i }));
  indexed.sort((a, b) => {
    const na = a.p.chapterNo == null ? Number.MAX_SAFE_INTEGER : a.p.chapterNo;
    const nb = b.p.chapterNo == null ? Number.MAX_SAFE_INTEGER : b.p.chapterNo;
    return (na - nb) || (a.i - b.i);
  });
  parsedHandoffs = indexed.map((x) => x.p);
  const orderedFiles = indexed.map((x) => files[x.i]);
  const totalChapters = parsedHandoffs.length;
  if (totalChapters <= threshold) {
    const msg = '衔接包链长度: ' + totalChapters + ' (阈值: ' + threshold + ') — 无需压缩';
    if (jsonMode) console.log(JSON.stringify({ status: 'no_compression_needed', message: msg, chain_length: totalChapters, threshold }));
    else console.log(msg);
    return;
  }
  const compressStartIndex = 0;
  const compressEndIndex = totalChapters - keep;
  const result = compressHandoffs(parsedHandoffs, compressStartIndex, compressEndIndex);
  const compressedFiles = orderedFiles.slice(compressStartIndex, compressEndIndex);
  const archivedCount = (!dryRun && archiveDir) ? archiveSources(compressedFiles, archiveDir) : 0;
  if (jsonMode) {
    const output = {
      status: 'compressed',
      chain_length: totalChapters,
      threshold,
      keep_recent: keep,
      compressed_range: '第' + (parsedHandoffs[compressStartIndex].chapterNo || (compressStartIndex + 1)) + '章 ~ 第' + (parsedHandoffs[compressEndIndex - 1].chapterNo || compressEndIndex) + '章',
      stats: result.stats,
      summary: result.summary,
      output_file: outputFile || path.join(path.dirname(orderedFiles[0]), 'compressed_handoff_summary.txt'),
      archived: archivedCount,
      archive_dir: archiveDir || null,
      dry_run: dryRun,
    };
    console.log(JSON.stringify(output, null, 2));
  } else {
    console.log('═══════════════════════════════════════════════════════');
    console.log('  衔接包自动压缩报告');
    console.log('═══════════════════════════════════════════════════════');
    console.log('衔接包链长度: ' + totalChapters + '  阈值: ' + threshold);
    console.log('保留最近: ' + keep + ' 章完整');
    console.log('压缩范围: 第' + (parsedHandoffs[compressStartIndex].chapterNo || (compressStartIndex + 1)) + '章 ~ 第' + (parsedHandoffs[compressEndIndex - 1].chapterNo || compressEndIndex) + '章 (' + result.stats.chapters_compressed + '章)');
    console.log('');
    console.log('── 压缩统计 ──');
    console.log('  原始总字数: ' + result.stats.original_total);
    console.log('  压缩后字数: ' + result.stats.compressed);
    console.log('  压缩比: ' + result.stats.compression_ratio + ' (越低越好)');
    console.log('  活跃伏笔: ' + result.stats.active_foreshadows);
    console.log('  已回收伏笔: ' + result.stats.resolved_foreshadows);
    console.log('  仍有效禁止矛盾: ' + result.stats.active_constraints);
    console.log('  追踪角色数: ' + result.stats.characters_tracked);
    console.log('');
    console.log('── 压缩摘要预览 ──');
    console.log(result.summary.substring(0, 500) + '...');
    if (dryRun) console.log('\n⚠️ 当前为 dry-run 模式，未写入文件。使用 --write 执行实际压缩。');
    else {
      const out = outputFile || path.join(path.dirname(orderedFiles[0]), 'compressed_handoff_summary.txt');
      const dir = path.dirname(out);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const tmp = out + '.tmp.' + crypto.randomBytes(4).toString('hex');
      fs.writeFileSync(tmp, result.summary, 'utf-8');
      fs.renameSync(tmp, out);
      console.log('\n✅ 压缩摘要已写入: ' + out);
      if (archiveDir) console.log('📦 已移动 ' + archivedCount + ' 个源文件到: ' + archiveDir);
      else {
        console.log('⚠️ 请将原始旧衔接包移动到 archive/ 目录（或使用 --archive=DIR 自动归档）。');
      }
    }
  }
  if (dryRun) return;
  if (jsonMode && !outputFile) {
    // also write file in json+write mode for convenience
    const out = path.join(path.dirname(orderedFiles[0]), 'compressed_handoff_summary.txt');
    const tmp = out + '.tmp.' + crypto.randomBytes(4).toString('hex');
    const dir = path.dirname(out);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(tmp, result.summary, 'utf-8');
    fs.renameSync(tmp, out);
  }
  if (jsonMode && outputFile) {
    const tmp = outputFile + '.tmp.' + crypto.randomBytes(4).toString('hex');
    const dir = path.dirname(outputFile);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(tmp, result.summary, 'utf-8');
    fs.renameSync(tmp, outputFile);
  }
}

main();

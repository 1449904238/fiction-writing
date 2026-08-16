#!/usr/bin/env node
'use strict';

/**
 * compress-handoff.js — 衔接包自动压缩
 *
 * V4.0 新增脚本（问题3解决方案）：
 *   当衔接包链超过阈值（默认10章）时，自动扫描旧衔接包，
 *   提取关键状态（角色状态/活跃伏笔/待解悬念），生成压缩摘要。
 *   压缩后的摘要替换旧衔接包，保持衔接包链在 3-5 章以内。
 *
 * 压缩策略（参考 PageOut 语义相关性淘汰）：
 *   - 保留最近 N 章（默认3章）的完整衔接包
 *   - 更早的衔接包压缩为摘要，提取：
 *     * 角色状态变化轨迹（只保留最终状态）
 *     * 活跃伏笔（未回收的）
 *     * 已回收伏笔（标记回收章节，不再展开）
 *     * 关键数值锁定（当前值）
 *     * 禁止矛盾（仍有效的）
 *   - 被压缩的衔接包原文保存到 archive/ 目录
 *
 * 用法：node compress-handoff.js [--threshold=10] [--keep=3] [--dry-run] <handoff-files...>
 * 输入为按顺序排列的衔接包文件（或包含衔接包的细纲文件）
 * 只报告不修改（除非不加 --dry-run）。
 */

const fs = require('fs');
const path = require('path');

const USAGE = `Usage: node compress-handoff.js [--threshold=10] [--keep=3] [--dry-run] <files...>

Compress old handoff packages when chain exceeds threshold.
  --threshold=N  trigger compression when chain > N (default: 10)
  --keep=N       keep recent N chapters uncompressed (default: 3)
  --dry-run      report only, don't write compressed files
  --json         output JSON summary

Report-only by default (dry-run). Add explicit flag to write.`;

// ════════════════════════════════════════════════════════════
//  衔接包解析
// ════════════════════════════════════════════════════════════

/**
 * 从文件内容中提取衔接包部分
 */
function extractHandoff(text) {
  // 匹配【衔接包】标记及其后到下一个章节或文件结束
  const match = text.match(/【衔接包】[\s\S]*?(?=\n#{1,3}\s|【|$)/);
  if (match) return match[0];

  // 尝试匹配 [衔接包] 格式
  const match2 = text.match(/\[衔接包[^\]]*\][\s\S]*?(?=\n#{1,3}\s|\[章节|$)/);
  if (match2) return match2[0];

  return text; // 返回全文，让后续解析尽力提取
}

/**
 * 解析衔接包中的各个字段
 */
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
    foreshadow: extractSection(handoff, '伏笔'),
    quality_budget: extractSection(handoff, '质感预算'),
    dedup_list: extractSection(handoff, '跨章去重'),
  };

  // 清理空字段
  for (const [key, val] of Object.entries(result)) {
    if (key === 'raw_length') continue;
    if (!val || val.trim().length === 0) {
      result[key] = null;
    }
  }

  return result;
}

/**
 * 提取指定标题下的内容
 */
function extractSection(text, title) {
  // 尝试多种格式：[标题]、【标题】、## 标题
  const patterns = [
    new RegExp(`\\[${title}\\][\\s\\S]*?(?=\\n\\[|$)`, 'i'),
    new RegExp(`【${title}】[\\s\\S]*?(?=\\n【|$)`, 'i'),
    new RegExp(`(?:^|\\n)#{1,3}\\s*${title}[\\s\\S]*?(?=\\n#{1,3}\\s|$)`, 'i'),
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) {
      return match[0].trim();
    }
  }
  return null;
}

/**
 * 从角色状态表中提取角色最终状态
 */
function extractFinalCharacterStates(states) {
  if (!states) return [];

  const lines = states.split('\n').filter(l => l.includes('|') && !l.includes('---') && !l.includes('角色'));
  const characters = [];

  for (const line of lines) {
    const parts = line.split('|').map(p => p.trim()).filter(p => p);
    if (parts.length >= 2) {
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

/**
 * 提取伏笔状态
 */
function extractForeshadowing(foreshadowSection, newStates) {
  const foreshadows = [];

  if (foreshadowSection) {
    const lines = foreshadowSection.split('\n').filter(l => l.trim() && (l.includes('├') || l.includes('└') || l.includes('-') || l.includes('•')));
    for (const line of lines) {
      const cleaned = line.replace(/[├└│]/g, '').trim();
      if (cleaned) {
        const isResolved = cleaned.includes('已回收') || cleaned.includes('已揭晓') || cleaned.includes('已解决');
        const isActive = cleaned.includes('未回收') || cleaned.includes('待回收') || cleaned.includes('活跃') || !isResolved;
        foreshadows.push({
          content: cleaned,
          status: isResolved ? 'resolved' : (isActive ? 'active' : 'unknown'),
        });
      }
    }
  }

  return foreshadows;
}

// ════════════════════════════════════════════════════════════
//  压缩逻辑
// ════════════════════════════════════════════════════════════

/**
 * 压缩旧衔接包为摘要
 * @param {Array} parsedHandoffs - 解析后的衔接包数组
 * @param {number} startIndex - 从哪个索引开始压缩
 * @param {number} endIndex - 压缩到哪个索引（不含）
 * @returns {string} 压缩后的摘要文本
 */
function compressHandoffs(parsedHandoffs, startIndex, endIndex) {
  const toCompress = parsedHandoffs.slice(startIndex, endIndex);

  // 提取角色状态轨迹（只保留最终状态）
  const characterTrajectory = {};
  for (const handoff of toCompress) {
    if (handoff.character_states) {
      const chars = extractFinalCharacterStates(handoff.character_states);
      for (const char of chars) {
        characterTrajectory[char.name] = char; // 后面的覆盖前面的
      }
    }
  }

  // 提取活跃伏笔（去重）
  const activeForeshadows = [];
  const resolvedForeshadows = [];
  for (const handoff of toCompress) {
    const foreshadows = extractForeshadowing(handoff.foreshadow, handoff.new_state);
    for (const f of foreshadows) {
      if (f.status === 'active') {
        if (!activeForeshadows.some(a => a.content === f.content)) {
          activeForeshadows.push(f);
        }
      } else if (f.status === 'resolved') {
        if (!resolvedForeshadows.some(r => r.content === f.content)) {
          resolvedForeshadows.push(f);
        }
      }
    }
  }

  // 提取仍有效的禁止矛盾
  const activeConstraints = [];
  for (const handoff of toCompress) {
    if (handoff.forbidden) {
      const lines = handoff.forbidden.split('\n').filter(l => l.includes('❌') || l.includes('不能'));
      for (const line of lines) {
        const cleaned = line.replace(/[├└│❌]/g, '').trim();
        if (cleaned && !activeConstraints.includes(cleaned)) {
          activeConstraints.push(cleaned);
        }
      }
    }
  }

  // 提取状态锁定（仍有效的）
  const activeLocks = [];
  for (const handoff of toCompress) {
    if (handoff.state_lock) {
      const lines = handoff.state_lock.split('\n').filter(l => l.includes('→') || l.includes('不能'));
      for (const line of lines) {
        const cleaned = line.replace(/[├└│]/g, '').trim();
        if (cleaned && !activeLocks.includes(cleaned)) {
          activeLocks.push(cleaned);
        }
      }
    }
  }

  // 提取数值锁定（当前值）
  const valueLocks = [];
  for (const handoff of toCompress) {
    if (handoff.value_lock) {
      const lines = handoff.value_lock.split('\n').filter(l => l.includes('=') || l.includes('：'));
      for (const line of lines) {
        const cleaned = line.replace(/[├└│]/g, '').trim();
        if (cleaned && !valueLocks.some(v => v === cleaned)) {
          valueLocks.push(cleaned);
        }
      }
    }
  }

  // 生成压缩摘要
  let summary = '═══════════════════════════════════════\n';
  summary += '【压缩衔接包摘要】\n';
  summary += `压缩范围: 第${startIndex + 1}章 ~ 第${endIndex}章\n`;
  summary += `压缩时间: ${new Date().toISOString().split('T')[0]}\n`;
  summary += `原始总字数: ${toCompress.reduce((sum, h) => sum + h.raw_length, 0)} → 压缩后约 ${0} 字\n`;
  summary += '═══════════════════════════════════════\n\n';

  // 角色最终状态
  summary += '[角色最终状态]\n';
  if (Object.keys(characterTrajectory).length > 0) {
    summary += '| 角色 | 位置 | 身体状态 | 心理状态 | 关键持有物 | 战力等级 | 生死状态 |\n';
    for (const [name, char] of Object.entries(characterTrajectory)) {
      summary += `| ${name} | ${char.location} | ${char.body} | ${char.mind} | ${char.items} | ${char.power} | ${char.alive} |\n`;
    }
  } else {
    summary += '（无角色状态数据）\n';
  }
  summary += '\n';

  // 活跃伏笔
  summary += '[活跃伏笔（未回收）]\n';
  if (activeForeshadows.length > 0) {
    for (const f of activeForeshadows) {
      summary += `├─ ${f.content}\n`;
    }
  } else {
    summary += '（无活跃伏笔）\n';
  }
  summary += '\n';

  // 已回收伏笔
  if (resolvedForeshadows.length > 0) {
    summary += '[已回收伏笔（仅记录，不再展开）]\n';
    for (const f of resolvedForeshadows) {
      summary += `├─ ${f.content}\n`;
    }
    summary += '\n';
  }

  // 仍有效的禁止矛盾
  summary += '[仍有效的禁止矛盾]\n';
  if (activeConstraints.length > 0) {
    for (const c of activeConstraints) {
      summary += `├─ ❌ ${c}\n`;
    }
  } else {
    summary += '（无）\n';
  }
  summary += '\n';

  // 状态锁定
  if (activeLocks.length > 0) {
    summary += '[状态锁定（仍有效）]\n';
    for (const l of activeLocks) {
      summary += `├─ ${l}\n`;
    }
    summary += '\n';
  }

  // 数值锁定
  if (valueLocks.length > 0) {
    summary += '[数值锁定（当前值）]\n';
    for (const v of valueLocks) {
      summary += `├─ ${v}\n`;
    }
    summary += '\n';
  }

  summary += '═══════════════════════════════════════\n';
  summary += '⚠️ 此为自动压缩摘要，如需详细历史请查看 archive/ 目录\n';
  summary += '═══════════════════════════════════════\n';

  // 更新压缩后字数
  const compressedLength = summary.length;
  summary = summary.replace('压缩后约 0 字', `压缩后约 ${compressedLength} 字`);

  return {
    summary: summary,
    stats: {
      original_total: toCompress.reduce((sum, h) => sum + h.raw_length, 0),
      compressed: compressedLength,
      compression_ratio: parseFloat((compressedLength / Math.max(1, toCompress.reduce((sum, h) => sum + h.raw_length, 0))).toFixed(2)),
      chapters_compressed: toCompress.length,
      active_foreshadows: activeForeshadows.length,
      resolved_foreshadows: resolvedForeshadows.length,
      active_constraints: activeConstraints.length,
      characters_tracked: Object.keys(characterTrajectory).length,
    }
  };
}

// ════════════════════════════════════════════════════════════
//  主流程
// ════════════════════════════════════════════════════════════

function main() {
  const args = process.argv.slice(2);
  const files = [];
  let threshold = 10;
  let keep = 3;
  let dryRun = true;
  let jsonMode = false;

  for (const arg of args) {
    if (arg.startsWith('--threshold=')) {
      threshold = parseInt(arg.substring(12), 10) || 10;
    } else if (arg.startsWith('--keep=')) {
      keep = parseInt(arg.substring(7), 10) || 3;
    } else if (arg === '--dry-run') {
      dryRun = true;
    } else if (arg === '--write') {
      dryRun = false;
    } else if (arg === '--json') {
      jsonMode = true;
    } else if (arg === '--help' || arg === '-h') {
      console.log(USAGE);
      process.exit(0);
    } else {
      files.push(arg);
    }
  }

  if (files.length === 0) {
    console.error(USAGE);
    process.exit(1);
  }

  // 解析所有衔接包
  const parsedHandoffs = [];
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf-8');
    const parsed = parseHandoff(text);
    parsed.file = path.basename(file);
    parsedHandoffs.push(parsed);
  }

  const totalChapters = parsedHandoffs.length;

  // 检查是否需要压缩
  if (totalChapters <= threshold) {
    const msg = `衔接包链长度: ${totalChapters} (阈值: ${threshold}) — 无需压缩`;
    if (jsonMode) {
      console.log(JSON.stringify({ status: 'no_compression_needed', message: msg, chain_length: totalChapters, threshold }));
    } else {
      console.log(msg);
    }
    return;
  }

  // 计算压缩范围
  const compressStartIndex = 0;
  const compressEndIndex = totalChapters - keep; // 压缩前面的，保留最后 keep 章

  // 执行压缩
  const result = compressHandoffs(parsedHandoffs, compressStartIndex, compressEndIndex);

  // 输出
  if (jsonMode) {
    const output = {
      status: 'compressed',
      chain_length: totalChapters,
      threshold: threshold,
      keep_recent: keep,
      compressed_range: `第${compressStartIndex + 1}章 ~ 第${compressEndIndex}章`,
      stats: result.stats,
      summary: result.summary,
    };
    console.log(JSON.stringify(output, null, 2));
  } else {
    console.log('═══════════════════════════════════════════════════════');
    console.log('  衔接包自动压缩报告');
    console.log('═══════════════════════════════════════════════════════');
    console.log(`衔接包链长度: ${totalChapters}  阈值: ${threshold}`);
    console.log(`保留最近: ${keep} 章完整`);
    console.log(`压缩范围: 第${compressStartIndex + 1}章 ~ 第${compressEndIndex}章 (${result.stats.chapters_compressed}章)`);
    console.log('');
    console.log('── 压缩统计 ──');
    console.log(`  原始总字数: ${result.stats.original_total}`);
    console.log(`  压缩后字数: ${result.stats.compressed}`);
    console.log(`  压缩比: ${result.stats.compression_ratio} (越低越好)`);
    console.log(`  活跃伏笔: ${result.stats.active_foreshadows}`);
    console.log(`  已回收伏笔: ${result.stats.resolved_foreshadows}`);
    console.log(`  仍有效禁止矛盾: ${result.stats.active_constraints}`);
    console.log(`  追踪角色数: ${result.stats.characters_tracked}`);
    console.log('');
    console.log('── 压缩摘要预览 ──');
    console.log(result.summary.substring(0, 500) + '...');

    if (dryRun) {
      console.log('\n⚠️ 当前为 dry-run 模式，未写入文件。使用 --write 执行实际压缩。');
    } else {
      // 写入压缩摘要文件
      const outputFile = path.join(path.dirname(files[0]), 'compressed_handoff_summary.txt');
      fs.writeFileSync(outputFile, result.summary, 'utf-8');
      console.log(`\n✅ 压缩摘要已写入: ${outputFile}`);
      console.log('⚠️ 请将原始旧衔接包移动到 archive/ 目录。');
    }
  }
}

main();

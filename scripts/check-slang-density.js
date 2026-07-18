#!/usr/bin/env node
'use strict';

/**
 * check-slang-density.js — 网络梗密度与时效性检测（V6.0.1新增 — Phase 2）
 *
 * 与 check-ai-patterns.js 互补：
 *   - check-ai-patterns 检测"AI味套路"（应消除）
 *   - 本脚本检测"网络梗密度/堆砌/时效/题材冲突"（应控制）
 *
 * 检测 6 类问题：
 *   - slang-density（密度）：每章网络梗数量，超出阈值=advisory
 *   - slang-clustering（堆砌）：连续2处以上网络梗且语义重复=blocking
 *   - genre-conflict（题材冲突）：悬疑/历史/严肃题材使用网络梗=blocking
 *   - narrator-overreach（叙述者越权）：网络梗出现在叙述者总结层=blocking
 *   - slang-staleness（时效性）：B/C级网络梗在长连载(>50章)中标记=advisory
 *   - voice-mismatch（口吻不匹配）：网络梗与角色声口不符=advisory（需--voices参数）
 *
 * 用法：node check-slang-density.js [--json] [--genre=都市] [--chapter-count=30] [--voices=主角:青少年,配角:市井] <file...>
 * 只报告不修改。
 *
 * 素材库：references/网络梗素材库.md（S/A/B/C时效分级 + 题材路由）
 */

const fs = require('fs');
const path = require('path');

const USAGE = `Usage: node check-slang-density.js [--json] [--genre=都市] [--chapter-count=30] [--voices=主角:青少年,配角:市井] <file...>

Detect internet slang density, clustering, staleness, and genre conflicts:
  - slang-density: slang count per chapter (advisory if exceeds limits)
  - slang-clustering: 2+ consecutive slangs with similar meaning (blocking)
  - genre-conflict: slang in suspense/history/serious-fiction genres (blocking)
  - narrator-overreach: slang in narrator summary layer (blocking)
  - slang-staleness: B/C-grade slang in long serials >50 chapters (advisory)
  - voice-mismatch: slang inconsistent with character voice (advisory, requires --voices)

Report-only. Never rewrites text.`;

// ============================================================
// 网络梗词库（S/A/B/C时效分级 — 与 references/网络梗素材库.md 对齐）
// ============================================================

const SLANG_ENTRIES = {
  // S级：经典化（2年+，可稳定使用）
  'S': [
    '破防', '破防了', '社死', '真香', '打工人', '干饭人', '佛系', 'YYDS', 'yyds',
    '绝绝子', '炸毛', '暴走', '凉凉', '麻了', '笑死', '哭哭', '就这'
  ],
  // A级：阶段流行（6-24月）
  'A': [
    '我裂开', '蚌埠住了', '冲鸭', '比心', '栓Q', '栓Q了', '芭比Q', '摆烂',
    '躺平', '内卷', '卷王', '摸鱼', '划水', '凡尔赛', '赢麻了', '带薪摸鱼'
  ],
  // B级：热点（1-6月）
  'B': [
    'emo', 'emo了', '破大防', '大无语事件', '小丑竟是我自己', '智商税',
    '割韭菜', '画大饼', 'PUA', 'CPU', 'KTV', 'PPT'
  ],
  // C级：即时（1-3月）
  'C': [
    '赛博对账', '敬自己一杯', '泰裤辣', '遥遥领先', '硬控', '绝杀'
  ]
};

// 反向映射：slang -> { grade, category }
const SLANG_LOOKUP = {};
for (const [grade, words] of Object.entries(SLANG_ENTRIES)) {
  for (const word of words) {
    SLANG_LOOKUP[word] = { grade: grade, category: '网络梗' };
  }
}

// 题材路由表（与 网络梗素材库.md 题材路由表对齐）
const GENRE_ROUTING = {
  '都市': { allowed: ['S', 'A', 'B'], strategy: '解锁' },
  '职场': { allowed: ['S', 'A', 'B'], strategy: '解锁' },
  '系统': { allowed: ['S', 'A', 'B'], strategy: '解锁' },
  '轻小说': { allowed: ['S', 'A', 'B', 'C'], strategy: '解锁' },
  '二次元': { allowed: ['S', 'A', 'B', 'C'], strategy: '解锁' },
  '玄幻': { allowed: ['S', 'A'], strategy: '中度' },
  '修仙': { allowed: ['S', 'A'], strategy: '中度' },
  '言情': { allowed: ['S'], strategy: '克制' },
  '悬疑': { allowed: [], strategy: '封锁' },
  '恐怖': { allowed: [], strategy: '封锁' },
  '历史': { allowed: [], strategy: '封锁' },
  '严肃': { allowed: [], strategy: '封锁' },
  '严肃文学': { allowed: [], strategy: '封锁' },
  '武侠': { allowed: ['S'], strategy: '克制' },
  '科幻': { allowed: ['S', 'A'], strategy: '中度' },
  '同人': { allowed: ['S', 'A', 'B'], strategy: '解锁' }
};

// 密度阈值（与 05_core Gate 7 对齐）
const DENSITY_LIMITS = {
  core: 2,        // 核心章 ≤2处
  important: 2,   // 重要章 ≤2处
  transitional: 1, // 过场章 ≤1处
  accent: 1,      // 点缀章 ≤1处
  default: 3      // 日常章 ≤3处
};

// 长连载阈值
const LONG_SERIAL_THRESHOLD = 50;

// ============================================================
// 核心检测逻辑
// ============================================================

function detectSlang(text) {
  const findings = [];
  const slangHits = [];

  // 1. 扫描网络梗出现位置
  for (const [slang, info] of Object.entries(SLANG_LOOKUP)) {
    let idx = 0;
    while ((idx = text.indexOf(slang, idx)) !== -1) {
      // 获取上下文（前后50字）
      const start = Math.max(0, idx - 50);
      const end = Math.min(text.length, idx + slang.length + 50);
      const context = text.substring(start, end);
      const before = text.substring(start, idx);
      const after = text.substring(idx + slang.length, end);

      slangHits.push({
        slang: slang,
        grade: info.grade,
        position: idx,
        context: context,
        before: before,
        after: after
      });
      idx += slang.length;
    }
  }

  // 按位置排序
  slangHits.sort((a, b) => a.position - b.position);

  if (slangHits.length === 0) {
    return findings;
  }

  // 2. 密度检测
  const densityLimit = DENSITY_LIMITS.default;
  if (slangHits.length > densityLimit) {
    findings.push({
      type: 'slang-density',
      severity: 'advisory',
      message: `网络梗密度 ${slangHits.length} 处，超出日常章上限 ${densityLimit} 处`,
      detail: `出现: ${slangHits.map(h => h.slang + '(' + h.grade + ')').join(', ')}`,
      location: slangHits.map(h => `pos:${h.position}`).join('; ')
    });
  }

  // 3. 堆砌检测（连续2处以上，间距<100字）
  for (let i = 0; i < slangHits.length - 1; i++) {
    const curr = slangHits[i];
    const next = slangHits[i + 1];
    if (next.position - curr.position < 100) {
      findings.push({
        type: 'slang-clustering',
        severity: 'blocking',
        message: `网络梗堆砌: "${curr.slang}" 与 "${next.slang}" 间距仅 ${next.position - curr.position} 字`,
        detail: `上下文: ...${curr.context.substring(Math.max(0, curr.context.length - 30))}${next.context.substring(0, 30)}...`,
        location: `pos:${curr.position}-${next.position}`
      });
    }
  }

  // 4. 题材冲突检测
  const genre = globalArgs.genre;
  if (genre && GENRE_ROUTING[genre]) {
    const routing = GENRE_ROUTING[genre];
    if (routing.strategy === '封锁') {
      if (slangHits.length > 0) {
        findings.push({
          type: 'genre-conflict',
          severity: 'blocking',
          message: `题材"${genre}"禁止使用网络梗，但检测到 ${slangHits.length} 处`,
          detail: `网络梗: ${slangHits.map(h => h.slang).join(', ')}`,
          location: slangHits.map(h => `pos:${h.position}`).join('; ')
        });
      }
    } else if (routing.strategy === '克制' || routing.strategy === '中度') {
      const forbidden = slangHits.filter(h => !routing.allowed.includes(h.grade));
      if (forbidden.length > 0) {
        findings.push({
          type: 'genre-conflict',
          severity: 'blocking',
          message: `题材"${genre}"仅允许 ${routing.allowed.join('/')} 级网络梗，检测到越级梗`,
          detail: `越级: ${forbidden.map(h => h.slang + '(' + h.grade + ')').join(', ')}`,
          location: forbidden.map(h => `pos:${h.position}`).join('; ')
        });
      }
    }
  }

  // 5. 叙述者越权检测（启发式：网络梗前后无引号/对话标记）
  for (const hit of slangHits) {
    const hasDialogueMark = /["「『"]/.test(hit.before.substring(hit.before.length - 5)) ||
                           /["」』"]/.test(hit.after.substring(0, 5));
    const hasThoughtMark = /（|\(|心想|内心|暗道/.test(hit.before.substring(hit.before.length - 10));
    if (!hasDialogueMark && !hasThoughtMark) {
      // 进一步检查：是否在叙述段落中（无对话标记）
      const lineStart = hit.context.lastIndexOf('\n');
      const lineEnd = hit.context.indexOf('\n', hit.slang.length);
      const line = hit.context.substring(lineStart + 1, lineEnd > 0 ? lineEnd : hit.context.length);
      // 如果该行无引号且非角色对话
      if (!/["「『」』"]/.test(line) && !/说|道|问|答|喊|叫/.test(hit.before.substring(hit.before.length - 20))) {
        findings.push({
          type: 'narrator-overreach',
          severity: 'blocking',
          message: `网络梗"${hit.slang}"可能出现在叙述者总结层（非角色对话/内心吐槽）`,
          detail: `上下文: ...${line.substring(0, 60)}...`,
          location: `pos:${hit.position}`
        });
      }
    }
  }

  // 6. 时效性检测（B/C级在长连载中标记）
  const chapterCount = globalArgs.chapterCount;
  if (chapterCount && chapterCount > LONG_SERIAL_THRESHOLD) {
    const staleSlangs = slangHits.filter(h => h.grade === 'B' || h.grade === 'C');
    if (staleSlangs.length > 0) {
      findings.push({
        type: 'slang-staleness',
        severity: 'advisory',
        message: `连载已达 ${chapterCount} 章，B/C级网络梗可能已过时`,
        detail: `过时风险: ${staleSlangs.map(h => h.slang + '(' + h.grade + ')').join(', ')}`,
        location: staleSlangs.map(h => `pos:${h.position}`).join('; ')
      });
    }
  }

  // 7. 口吻匹配检测（需--voices参数）
  if (globalArgs.voices && slangHits.length > 0) {
    // 简化版：仅检查严肃角色（如长老/将军/帝王）是否使用网络梗
    const seriousRoles = ['长老', '将军', '帝王', '皇帝', '老师', '教授', '医生', '法师'];
    for (const hit of slangHits) {
      const roleContext = hit.before.substring(hit.before.length - 30);
      for (const role of seriousRoles) {
        if (roleContext.includes(role)) {
          findings.push({
            type: 'voice-mismatch',
            severity: 'advisory',
            message: `网络梗"${hit.slang}"可能与角色"${role}"的严肃口吻不符`,
            detail: `上下文: ...${roleContext}${hit.slang}...`,
            location: `pos:${hit.position}`
          });
          break;
        }
      }
    }
  }

  return findings;
}

// ============================================================
// 主流程
// ============================================================

const args = process.argv.slice(2);
const files = [];
const globalArgs = { json: false, genre: null, chapterCount: null, voices: null };

for (const arg of args) {
  if (arg === '--json') {
    globalArgs.json = true;
  } else if (arg.startsWith('--genre=')) {
    globalArgs.genre = arg.substring(8);
  } else if (arg.startsWith('--chapter-count=')) {
    globalArgs.chapterCount = parseInt(arg.substring(15), 10);
  } else if (arg.startsWith('--voices=')) {
    globalArgs.voices = arg.substring(9);
  } else if (arg === '--help' || arg === '-h') {
    console.log(USAGE);
    process.exit(0);
  } else if (!arg.startsWith('-')) {
    files.push(arg);
  }
}

if (files.length === 0) {
  console.error(USAGE);
  process.exit(1);
}

let allFindings = [];
let totalBlocking = 0;
let totalAdvisory = 0;

for (const file of files) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    console.error(`Error reading ${file}: ${e.message}`);
    continue;
  }

  const findings = detectSlang(text);

  for (const f of findings) {
    f.file = file;
    if (f.severity === 'blocking') totalBlocking++;
    else if (f.severity === 'advisory') totalAdvisory++;
  }

  allFindings = allFindings.concat(findings);
}

// 输出报告
if (globalArgs.json) {
  console.log(JSON.stringify({
    total_findings: allFindings.length,
    blocking: totalBlocking,
    advisory: totalAdvisory,
    findings: allFindings
  }, null, 2));
} else {
  if (allFindings.length === 0) {
    console.log('✓ No internet slang issues detected.');
  } else {
    console.log(`\n=== 网络梗检测报告 ===`);
    console.log(`总发现: ${allFindings.length} (blocking: ${totalBlocking}, advisory: ${totalAdvisory})\n`);

    for (const f of allFindings) {
      const icon = f.severity === 'blocking' ? '✗' : '⚠';
      console.log(`${icon} [${f.severity.toUpperCase()}] ${f.type} — ${f.file}`);
      console.log(`  ${f.message}`);
      if (f.detail) console.log(`  详情: ${f.detail}`);
      if (f.location) console.log(`  位置: ${f.location}`);
      console.log('');
    }
  }
}

// blocking > 0 时 exit 2（与 check-prose-after-write hook 约定一致）
process.exit(totalBlocking > 0 ? 2 : 0);

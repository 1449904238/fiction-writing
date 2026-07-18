#!/usr/bin/env node
/**
 * check-references.js (V5.3.1 新增)
 * 扫描所有 .md 文件中的 references/ 路径引用，比对实际文件是否存在。
 * report-only，不修改任何文件。
 *
 * 用法: node scripts/check-references.js [--root .]
 * 退出码: 0=无死链接, 1=发现死链接
 */
const fs = require('fs');
const path = require('path');

const root = process.argv.includes('--root')
  ? process.argv[process.argv.indexOf('--root') + 1]
  : '.';

const referencesDir = path.join(root, 'references');
const archiveDir = path.join(referencesDir, '_archive');

// 收集 references/ 下所有实际存在的 .md 文件（含 _archive/）
function collectActualFiles(dir, base = '') {
  const files = new Set();
  if (!fs.existsSync(dir)) return files;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = base ? `${base}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      // 递归子目录（如 _archive/）
      const sub = collectActualFiles(path.join(dir, entry.name), rel);
      sub.forEach(f => files.add(f));
    } else if (entry.name.endsWith('.md')) {
      files.add(rel);
    }
  }
  return files;
}

const actualFiles = collectActualFiles(referencesDir);

// 递归收集所有 .md 文件
function collectMarkdownFiles(dir) {
  const results = [];
  if (!fs.existsSync(dir)) return results;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    // 跳过 node_modules, .git 等
    if (['node_modules', '.git', '_archive'].includes(entry.name)) continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectMarkdownFiles(fullPath));
    } else if (entry.name.endsWith('.md')) {
      results.push(fullPath);
    }
  }
  return results;
}

const mdFiles = collectMarkdownFiles(root);

// 正则匹配 references/xxx.md 引用
const refPattern = /references\/[^\s)"'`\]，。、；（）「」『』【】《》=]+\.md/g;

const deadLinks = [];
const archiveLinks = [];
let totalRefs = 0;

for (const filePath of mdFiles) {
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');
  const relPath = path.relative(root, filePath);

  for (let i = 0; i < lines.length; i++) {
    const matches = lines[i].matchAll(refPattern);
    for (const match of matches) {
      const refPath = match[0]; // e.g. "references/00_严谨性校验协议.md"
      const fileName = refPath.replace('references/', '');
      totalRefs++;

      // 检查是否存在于主目录
      const existsInMain = actualFiles.has(fileName);
      // 检查是否存在于 _archive/
      const existsInArchive = fs.existsSync(path.join(archiveDir, fileName));

      if (!existsInMain) {
        if (existsInArchive) {
          archiveLinks.push({
            file: relPath,
            line: i + 1,
            ref: refPath,
            note: `文件已移至 _archive/，需更新引用`
          });
        } else {
          deadLinks.push({
            file: relPath,
            line: i + 1,
            ref: refPath,
            note: `文件不存在`
          });
        }
      }
    }
  }
}

// 输出报告
console.log('═══════════════════════════════════════════════');
console.log('  check-references.js — 引用路径死链接检测报告');
console.log('═══════════════════════════════════════════════');
console.log(`扫描文件: ${mdFiles.length} 个 .md 文件`);
console.log(`引用总数: ${totalRefs} 处 references/ 引用`);
console.log(`实际文件: ${actualFiles.size} 个 (references/ 目录)`);

if (archiveLinks.length > 0) {
  console.log('\n⚠️  引用了 _archive/ 中的文件（需更新为综合文件路径）:');
  for (const link of archiveLinks) {
    console.log(`  ${link.file}:${link.line} → ${link.ref}`);
    console.log(`    ${link.note}`);
  }
}

if (deadLinks.length > 0) {
  console.log('\n❌ 死链接（文件完全不存在）:');
  for (const link of deadLinks) {
    console.log(`  ${link.file}:${link.line} → ${link.ref}`);
    console.log(`    ${link.note}`);
  }
}

const totalIssues = archiveLinks.length + deadLinks.length;
console.log(`\n───────────────────────────────────────────────`);
if (totalIssues === 0) {
  console.log('✅ 所有引用路径均有效，无死链接。');
  process.exit(0);
} else {
  console.log(`❌ 发现 ${totalIssues} 处问题（${archiveLinks.length} 处归档引用 + ${deadLinks.length} 处死链接）`);
  process.exit(1);
}

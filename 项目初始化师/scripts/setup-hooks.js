#!/usr/bin/env node
'use strict';

/**
 * setup-hooks.js — 平台自动检测与 Hook 配置（V5.3新增）
 *
 * 检测当前开发平台（Trae / Claude Code / OpenCode / Codex），
 * 自动复制对应的 hook 文件到平台配置目录。
 *
 * 只使用 Node.js 内置模块（fs/path/os）。
 * 用法：node scripts/setup-hooks.js
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

// ── 路径常量 ──
const SCRIPT_DIR = __dirname;
const HOOKS_SOURCE_DIR = path.resolve(SCRIPT_DIR, '..', 'hooks');
const PROJECT_ROOT = path.resolve(SCRIPT_DIR, '..');

// 需要配置的 hook 文件（不含平台后缀）
const HOOK_FILES = [
  'check-prose-after-write',
  'chapter-counter',
  'session-start',
  'detect-story-gaps',
  'pre-compact',
  'guard-outline-before-prose',
  'post-chapter-update',
  'session-end',
  'check-rhythm-cross-chapter',
];

// 平台配置：检测标志 → hooks 目标目录
const PLATFORM_CONFIGS = [
  {
    name: 'Trae',
    detectDir: '.trae',
    hooksTarget: '.trae/hooks',
  },
  {
    name: 'Claude Code',
    detectDir: '.claude',
    hooksTarget: '.claude/hooks',
  },
  {
    name: 'Codex',
    detectDir: '.codex',
    hooksTarget: '.codex/hooks',
  },
  {
    name: 'OpenCode',
    detectDir: null, // OpenCode 使用用户主目录下的配置
    hooksTarget: path.join(os.homedir(), '.config', 'opencode', 'hooks'),
  },
];

// ── 辅助函数 ──

/**
 * 获取当前操作系统对应的 hook 脚本扩展名
 */
function getHookExtension() {
  return os.platform() === 'win32' ? '.ps1' : '.sh';
}

/**
 * 确保目录存在，递归创建
 */
function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    console.log(`[setup-hooks] 创建目录: ${dir}`);
  }
}

// ── 平台检测 ──

/**
 * 检测当前环境中已安装的开发平台
 * @returns {Array} 检测到的平台配置列表
 */
function detectPlatforms() {
  const detected = [];

  for (const config of PLATFORM_CONFIGS) {
    if (config.name === 'OpenCode') {
      // OpenCode: 检查用户主目录下的 ~/.config/opencode/
      const opencodeDir = path.join(os.homedir(), '.config', 'opencode');
      if (fs.existsSync(opencodeDir)) {
        detected.push(config);
      }
      continue;
    }
    // 其他平台: 检查项目根目录下的标志目录
    const flagDir = path.join(PROJECT_ROOT, config.detectDir);
    if (fs.existsSync(flagDir)) {
      detected.push(config);
    }
  }

  // 如果没有检测到任何平台，根据 OS 推荐默认平台
  if (detected.length === 0) {
    const isWindows = os.platform() === 'win32';
    const defaultPlatform = isWindows
      ? PLATFORM_CONFIGS.find(p => p.name === 'Trae')
      : PLATFORM_CONFIGS.find(p => p.name === 'OpenCode');
    if (defaultPlatform) {
      console.log(`[setup-hooks] 未检测到已知平台目录，默认推荐: ${defaultPlatform.name}`);
      detected.push(defaultPlatform);
    }
  }

  return detected;
}

// ── Hook 复制 ──

/**
 * 将 hook 文件复制到检测到的平台配置目录
 * @param {Array} platforms - 检测到的平台列表
 * @returns {Array} 复制报告
 */
function copyHooks(platforms) {
  const extension = getHookExtension();
  const report = [];

  for (const platform of platforms) {
    // 解析目标目录（处理相对路径和绝对路径）
    const finalTargetDir = path.isAbsolute(platform.hooksTarget)
      ? platform.hooksTarget
      : path.join(PROJECT_ROOT, platform.hooksTarget);

    ensureDir(finalTargetDir);

    let copied = 0;
    let failed = 0;
    const copiedFiles = [];

    for (const hookName of HOOK_FILES) {
      const sourceFile = path.join(HOOKS_SOURCE_DIR, hookName + extension);
      const targetFile = path.join(finalTargetDir, hookName + extension);

      if (!fs.existsSync(sourceFile)) {
        console.warn(`[setup-hooks] 警告: 源文件不存在 ${sourceFile}`);
        failed++;
        continue;
      }

      try {
        fs.copyFileSync(sourceFile, targetFile);
        copied++;
        copiedFiles.push(hookName + extension);
      } catch (err) {
        console.error(`[setup-hooks] 错误: 复制 ${hookName} 失败 - ${err.message}`);
        failed++;
      }
    }

    report.push({
      platform: platform.name,
      targetDir: finalTargetDir,
      copied,
      failed,
      files: copiedFiles,
    });
  }

  return report;
}

// ── 报告输出 ──

/**
 * 打印配置完成报告
 */
function printReport(report) {
  const ext = getHookExtension();
  const osName = os.platform() === 'win32' ? 'Windows' : (os.platform() === 'darwin' ? 'macOS' : 'Linux');

  console.log('');
  console.log('======================================================');
  console.log('  Hook 自动配置报告 (V5.3)');
  console.log('======================================================');
  console.log('');
  console.log(`  操作系统:   ${osName} (${os.platform()})`);
  console.log(`  脚本类型:   ${ext}`);
  console.log('');

  let totalCopied = 0;
  let totalFailed = 0;

  for (const entry of report) {
    console.log(`  [${entry.platform}]`);
    console.log(`    配置目录: ${entry.targetDir}`);
    console.log(`    成功复制: ${entry.copied} 个 hook`);
    if (entry.failed > 0) {
      console.log(`    失败/跳过: ${entry.failed} 个`);
    }
    console.log(`    已配置文件:`);
    for (const f of entry.files) {
      console.log(`      + ${f}`);
    }
    console.log('');
    totalCopied += entry.copied;
    totalFailed += entry.failed;
  }

  console.log('------------------------------------------------------');
  console.log(`  总计: ${totalCopied} 个 hook 已配置, ${totalFailed} 个失败`);
  console.log(`  平台数: ${report.length}`);
  console.log('------------------------------------------------------');
  console.log('');
  console.log('  已启用功能:');
  console.log('    + check-prose-after-write  (写后兜底检测)');
  console.log('    + chapter-counter          (章节计数提醒)');
  console.log('    + session-start            (会话启动检查)');
  console.log('    + guard-outline-before-prose (写前大纲守卫)');
  console.log('    + detect-story-gaps        (故事缺口检测)');
  console.log('    + pre-compact              (压缩前检查)');
  console.log('    + post-chapter-update      (章节后更新)');
  console.log('    + session-end              (会话结束检查)');
  console.log('    + check-rhythm-cross-chapter (跨章节奏检测)');
  console.log('');
  console.log('  配置完成! hooks 将在写作流水线中自动生效。');
  console.log('');
}

// ── 主入口 ──

function main() {
  console.log('[setup-hooks] 开始检测平台...');

  // 验证 hooks 源目录存在
  if (!fs.existsSync(HOOKS_SOURCE_DIR)) {
    console.error(`[setup-hooks] 错误: hooks 源目录不存在: ${HOOKS_SOURCE_DIR}`);
    process.exit(1);
  }

  // 列出可用的 hook 文件
  const ext = getHookExtension();
  const availableHooks = HOOK_FILES
    .filter(name => fs.existsSync(path.join(HOOKS_SOURCE_DIR, name + ext)));

  if (availableHooks.length === 0) {
    console.error(`[setup-hooks] 错误: 在 ${HOOKS_SOURCE_DIR} 中未找到 ${ext} 格式的 hook 文件`);
    process.exit(1);
  }

  console.log(`[setup-hooks] 找到 ${availableHooks.length} 个 hook 文件 (${ext})`);

  // 检测平台
  const platforms = detectPlatforms();

  if (platforms.length === 0) {
    console.error('[setup-hooks] 错误: 未检测到任何支持的平台。');
    console.error('[setup-hooks] 请确保以下目录之一存在: .trae/ / .claude/ / .codex/ / ~/.config/opencode/');
    process.exit(1);
  }

  console.log(`[setup-hooks] 检测到 ${platforms.length} 个平台: ${platforms.map(p => p.name).join(', ')}`);

  // 复制 hooks
  const report = copyHooks(platforms);

  // 输出报告
  printReport(report);
}

main();

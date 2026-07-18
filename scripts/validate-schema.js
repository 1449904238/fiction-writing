#!/usr/bin/env node
'use strict';

/**
 * validate-schema.js — 零依赖 JSON Schema 验证脚本（V5.3 新增）
 *
 * 手动验证 JSON 数据是否符合 findings.schema.json（或其他 Schema）。
 * 不使用 ajv 或任何外部 npm 包，纯手写递归验证逻辑。
 *
 * 支持的 JSON Schema 特性（覆盖 findings.schema.json 所用全部特性）：
 *   - type: 单一类型 或 类型数组（如 ["integer", "null"]）
 *   - required: 必填字段列表
 *   - properties: 属性 Schema 定义（递归验证）
 *   - additionalProperties: false — 禁止未声明的额外属性
 *   - items: 数组元素 Schema（递归验证）
 *   - enum: 枚举值约束
 *   - minimum / maximum: 数值范围约束
 *   - minLength: 字符串最小长度约束
 *   - format: "date-time" — ISO 8601 基本格式检查（宽松）
 *   - $ref: Schema 内部引用（JSON Pointer 语法，如 "#/definitions/person"）
 *   - allOf: 数据必须同时满足所有子 Schema（合并所有错误）
 *   - oneOf: 数据必须恰好满足一个子 Schema（0个或>1个则报错）
 *   - anyOf: 数据必须满足至少一个子 Schema（全不满足则报错）
 *
 * 用法：
 *   node validate-schema.js --data=<json-file> [--schema=<schema-file>] [--subschema=<path>]
 *   node validate-schema.js --prose=<prose-file> [--schema=<schema-file>] [--subschema=<path>]
 *
 *   --data       待验证的 JSON 数据文件路径
 *   --prose      正文文件路径（自动调用 check-quality-score.js --json 生成输出再验证）
 *   --schema     Schema 文件路径（默认: ../schemas/findings.schema.json）
 *   --subschema  验证 Schema 中的子节点（点路径，如 "properties.score"）。
 *                用于验证 check-quality-score.js 输出（仅 score 对象）时设为 "properties.score"
 *
 * 退出码：0=验证通过，1=验证失败（有错误），2=参数/运行时错误
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const USAGE = `Usage: node validate-schema.js --data=<json-file> [--schema=<schema-file>] [--subschema=<path>]
       node validate-schema.js --prose=<prose-file> [--schema=<schema-file>] [--subschema=<path>]

Zero-dependency JSON Schema validator (no ajv).
Validates JSON data against a schema file manually.

Options:
  --data       JSON data file to validate
  --prose      Prose file (auto-runs check-quality-score.js --json, then validates output)
  --schema     Schema file path (default: ../schemas/findings.schema.json)
  --subschema  Dot-path into schema (e.g. "properties.score" to validate score object only)`;

// ============================================================
//  CLI 参数解析
// ============================================================

/**
 * 解析命令行参数
 * @param {string[]} argv - process.argv
 * @returns {{data: string|null, prose: string|null, schema: string, subschema: string|null}}
 */
function parseArgs(argv) {
  const opts = { data: null, prose: null, schema: null, subschema: null };
  const args = argv.slice(2);

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];

    if (arg === '-h' || arg === '--help') {
      process.stdout.write(`${USAGE}\n`);
      process.exit(0);
    }

    if (arg.startsWith('--data=')) {
      opts.data = arg.slice('--data='.length);
    } else if (arg === '--data') {
      opts.data = args[++i] || null;
    } else if (arg.startsWith('--prose=')) {
      opts.prose = arg.slice('--prose='.length);
    } else if (arg === '--prose') {
      opts.prose = args[++i] || null;
    } else if (arg.startsWith('--schema=')) {
      opts.schema = arg.slice('--schema='.length);
    } else if (arg === '--schema') {
      opts.schema = args[++i] || null;
    } else if (arg.startsWith('--subschema=')) {
      opts.subschema = arg.slice('--subschema='.length);
    } else if (arg === '--subschema') {
      opts.subschema = args[++i] || null;
    }
  }

  if (!opts.data && !opts.prose) {
    console.error('Error: --data or --prose is required');
    console.error(USAGE);
    process.exit(2);
  }

  // 默认 Schema 路径：相对于本脚本的 ../schemas/findings.schema.json
  if (!opts.schema) {
    opts.schema = path.resolve(__dirname, '..', 'schemas', 'findings.schema.json');
  }

  return opts;
}

/**
 * 按点路径从 Schema 中提取子节点
 * 如 getSubSchema(schema, "properties.score") 返回 schema.properties.score
 * @param {Object} schema - 完整 Schema
 * @param {string} dotPath - 点分隔路径（如 "properties.score"）
 * @returns {Object|null} - 子 Schema 节点，路径无效返回 null
 */
function getSubSchema(schema, dotPath) {
  if (!dotPath) return schema;
  const parts = dotPath.split('.');
  let current = schema;
  for (const part of parts) {
    if (current == null || typeof current !== 'object') return null;
    current = current[part];
  }
  return current || null;
}

// ============================================================
//  核心：递归验证引擎
// ============================================================

/**
 * 解析 JSON Pointer（如 "#/definitions/person"）从根 Schema 中提取被引用的子 Schema
 * 支持 JSON Pointer 语法（RFC 6901）：#/path/to/definition
 * @param {string} ref - $ref 字符串，如 "#/definitions/person"
 * @param {Object} rootSchema - 根 Schema（用于解析引用）
 * @returns {Object|null} - 被引用的 Schema 节点，解析失败返回 null
 */
function resolveRef(ref, rootSchema) {
  if (typeof ref !== 'string' || !ref.startsWith('#')) {
    return null;
  }
  // 移除开头的 '#'
  const pointer = ref.slice(1);
  if (pointer === '' || pointer === '/') {
    return rootSchema;
  }
  // 移除开头的 '/'，按 '/' 分割路径
  const parts = pointer.split('/').slice(1);
  let current = rootSchema;
  for (const part of parts) {
    if (current == null || typeof current !== 'object') {
      return null;
    }
    // JSON Pointer 转义：~1 -> /，~0 -> ~（RFC 6901 规定）
    const decoded = part.replace(/~1/g, '/').replace(/~0/g, '~');
    if (!(decoded in current)) {
      return null;
    }
    current = current[decoded];
  }
  return current;
}

/**
 * 验证数据是否符合给定 Schema 节点
 * 递归遍历 Schema，收集所有验证错误
 * @param {*} data - 待验证的数据
 * @param {Object} schema - Schema 节点
 * @param {string} path - 当前数据路径（如 "score.objective_score"），用于错误定位
 * @param {Object} [rootSchema] - 根 Schema（用于 $ref 解析），不传时默认为 schema 自身
 * @returns {string[]} - 错误消息数组（空数组表示验证通过）
 */
function validate(data, schema, path, rootSchema) {
  const errors = [];

  if (!schema || typeof schema !== 'object') {
    return errors; // 无 Schema 约束，直接通过
  }

  // rootSchema 默认为 schema 自身（向后兼容：顶层调用可不传）
  const effectiveRoot = rootSchema || schema;

  // ── $ref 解析 ──
  // JSON Schema 规范：$ref 存在时，同节点其他关键字被忽略，直接用引用的 Schema 验证
  if (schema.$ref !== undefined) {
    const refSchema = resolveRef(schema.$ref, effectiveRoot);
    if (!refSchema) {
      errors.push(`${path}: 无法解析 $ref "${schema.$ref}" — 引用路径在根 Schema 中不存在`);
      return errors;
    }
    // 递归验证被引用的 Schema（$ref 指向的 Schema 可能自身也含 $ref）
    return validate(data, refSchema, path, effectiveRoot);
  }

  // ── type 检查 ──
  if (schema.type !== undefined) {
    const typeErrors = checkType(data, schema.type, path);
    if (typeErrors.length > 0) return typeErrors; // 类型不符，无需进一步检查
  }

  // ── allOf 检查：数据必须同时满足所有子 Schema ──
  if (Array.isArray(schema.allOf)) {
    for (let i = 0; i < schema.allOf.length; i += 1) {
      const subErrors = validate(data, schema.allOf[i], path, effectiveRoot);
      if (subErrors.length > 0) {
        errors.push(...subErrors.map(e => `${e} (allOf[${i}])`));
      }
    }
  }

  // ── oneOf 检查：数据必须恰好满足一个子 Schema ──
  if (Array.isArray(schema.oneOf)) {
    let passedCount = 0;
    const allSubErrors = [];
    for (let i = 0; i < schema.oneOf.length; i += 1) {
      const subErrors = validate(data, schema.oneOf[i], path, effectiveRoot);
      if (subErrors.length === 0) {
        passedCount += 1;
      } else {
        allSubErrors.push(`oneOf[${i}]: ${subErrors.join('; ')}`);
      }
    }
    if (passedCount === 0) {
      errors.push(`${path}: oneOf 验证失败 — 不满足任何一个子 Schema（需恰好满足 1 个，实际满足 0 个）`);
      errors.push(...allSubErrors);
    } else if (passedCount > 1) {
      errors.push(`${path}: oneOf 验证失败 — 同时满足 ${passedCount} 个子 Schema（需恰好满足 1 个）`);
    }
  }

  // ── anyOf 检查：数据必须满足至少一个子 Schema ──
  if (Array.isArray(schema.anyOf)) {
    let anyPassed = false;
    const allSubErrors = [];
    for (let i = 0; i < schema.anyOf.length; i += 1) {
      const subErrors = validate(data, schema.anyOf[i], path, effectiveRoot);
      if (subErrors.length === 0) {
        anyPassed = true;
      } else {
        allSubErrors.push(`anyOf[${i}]: ${subErrors.join('; ')}`);
      }
    }
    if (!anyPassed) {
      errors.push(`${path}: anyOf 验证失败 — 不满足任何一个子 Schema`);
      errors.push(...allSubErrors);
    }
  }

  // ── enum 检查 ──
  if (schema.enum !== undefined) {
    if (!schema.enum.includes(data)) {
      errors.push(`${path}: 值 "${JSON.stringify(data)}" 不在枚举 [${schema.enum.map(v => JSON.stringify(v)).join(', ')}] 中`);
    }
  }

  // ── 字符串约束 ──
  if (typeof data === 'string') {
    if (schema.minLength !== undefined && data.length < schema.minLength) {
      errors.push(`${path}: 字符串长度 ${data.length} 小于最小长度 ${schema.minLength}`);
    }
    if (schema.format === 'date-time') {
      // 宽松 ISO 8601 检查：YYYY-MM-DDTHH:MM:SS 或 YYYY-MM-DD
      const isoRe = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})?)?$/;
      if (!isoRe.test(data)) {
        errors.push(`${path}: 值 "${data}" 不符合 date-time 格式（ISO 8601）`);
      }
    }
  }

  // ── 数值约束 ──
  if (typeof data === 'number') {
    if (schema.minimum !== undefined && data < schema.minimum) {
      errors.push(`${path}: 值 ${data} 小于最小值 ${schema.minimum}`);
    }
    if (schema.maximum !== undefined && data > schema.maximum) {
      errors.push(`${path}: 值 ${data} 大于最大值 ${schema.maximum}`);
    }
  }

  // ── 对象约束 ──
  if (typeof data === 'object' && data !== null && !Array.isArray(data)) {
    // required 检查
    if (Array.isArray(schema.required)) {
      for (const field of schema.required) {
        if (!(field in data)) {
          errors.push(`${path}: 缺少必填字段 "${field}"`);
        }
      }
    }

    // properties 递归验证
    if (schema.properties) {
      for (const [key, subSchema] of Object.entries(schema.properties)) {
        if (key in data) {
          const subErrors = validate(data[key], subSchema, `${path}.${key}`, effectiveRoot);
          errors.push(...subErrors);
        }
      }
    }

    // additionalProperties: false — 禁止未声明的额外属性
    if (schema.additionalProperties === false && schema.properties) {
      const allowedKeys = new Set(Object.keys(schema.properties));
      // required 中的字段也隐含在 properties 中，但以防万一也加入
      if (Array.isArray(schema.required)) {
        for (const r of schema.required) allowedKeys.add(r);
      }
      for (const key of Object.keys(data)) {
        if (!allowedKeys.has(key)) {
          errors.push(`${path}: 存在未声明的额外属性 "${key}"（additionalProperties: false）`);
        }
      }
    }
  }

  // ── 数组约束 ──
  if (Array.isArray(data)) {
    if (schema.items) {
      for (let i = 0; i < data.length; i += 1) {
        const subErrors = validate(data[i], schema.items, `${path}[${i}]`, effectiveRoot);
        errors.push(...subErrors);
      }
    }
  }

  return errors;
}

/**
 * 检查数据类型是否符合 Schema 声明
 * 支持单一类型字符串和类型数组（如 ["integer", "null"]）
 * @param {*} data - 待检查的数据
 * @param {string|string[]} expectedType - 期望的类型
 * @param {string} path - 当前路径
 * @returns {string[]} - 错误消息数组
 */
function checkType(data, expectedType, path) {
  const types = Array.isArray(expectedType) ? expectedType : [expectedType];

  for (const t of types) {
    if (matchesType(data, t)) {
      return []; // 匹配任一类型即可
    }
  }

  const actualType = getActualType(data);
  return [`${path}: 类型不匹配 — 期望 [${types.join(' / ')}]，实际 ${actualType}`];
}

/**
 * 判断数据是否匹配指定 JSON Schema 类型
 * @param {*} data - 待检查的数据
 * @param {string} type - JSON Schema 类型字符串
 * @returns {boolean}
 */
function matchesType(data, type) {
  switch (type) {
    case 'object':
      return typeof data === 'object' && data !== null && !Array.isArray(data);
    case 'array':
      return Array.isArray(data);
    case 'string':
      return typeof data === 'string';
    case 'integer':
      return typeof data === 'number' && Number.isInteger(data);
    case 'number':
      return typeof data === 'number';
    case 'boolean':
      return typeof data === 'boolean';
    case 'null':
      return data === null;
    default:
      return true; // 未知类型，不拦截
  }
}

/**
 * 获取数据的实际类型名称（用于错误消息）
 * @param {*} data
 * @returns {string}
 */
function getActualType(data) {
  if (data === null) return 'null';
  if (Array.isArray(data)) return 'array';
  return typeof data;
}

// ============================================================
//  主函数
// ============================================================

function main() {
  const options = parseArgs(process.argv);

  // 加载 Schema
  let schema;
  try {
    schema = JSON.parse(fs.readFileSync(path.resolve(options.schema), 'utf8'));
  } catch (e) {
    console.error(`Error: 无法加载 Schema 文件 ${options.schema}: ${e.message}`);
    process.exit(2);
  }

  // 获取待验证数据
  let data;
  let dataSource;

  if (options.data) {
    // 模式1：直接验证 JSON 文件
    dataSource = options.data;
    try {
      data = JSON.parse(fs.readFileSync(path.resolve(options.data), 'utf8'));
    } catch (e) {
      console.error(`Error: 无法加载数据文件 ${options.data}: ${e.message}`);
      process.exit(2);
    }
  } else if (options.prose) {
    // 模式2：运行 check-quality-score.js --json 获取输出再验证
    // check-quality-score.js 输出的是 score 对象，自动使用 properties.score 子 Schema
    if (!options.subschema) {
      options.subschema = 'properties.score';
    }
    dataSource = `check-quality-score.js --json --file=${options.prose}`;
    const scriptPath = path.resolve(__dirname, 'check-quality-score.js');
    try {
      const stdout = execFileSync('node', [scriptPath, '--json', `--file=${options.prose}`], {
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'], // 捕获 stderr，不输出到控制台
      });
      // check-quality-score.js 将 JSON 输出到 stdout，人类可读报告输出到 stderr
      data = JSON.parse(stdout);
    } catch (e) {
      console.error(`Error: 运行 check-quality-score.js 失败: ${e.message}`);
      if (e.stderr) {
        console.error(`  stderr: ${e.stderr.toString().trim()}`);
      }
      process.exit(2);
    }
  }

  // 执行验证（若指定 --subschema 则验证子节点）
  const effectiveSchema = options.subschema
    ? getSubSchema(schema, options.subschema)
    : schema;

  if (!effectiveSchema) {
    console.error(`Error: subschema 路径 "${options.subschema}" 在 Schema 中不存在`);
    process.exit(2);
  }

  const schemaLabel = options.subschema
    ? `${options.schema} #/${options.subschema.split('.').join('/')}`
    : options.schema;
  const errors = validate(data, effectiveSchema, 'root', schema);

  // 输出结果
  console.log(`=== Schema 验证结果 ===`);
  console.log(`Schema: ${schemaLabel}`);
  console.log(`数据源: ${dataSource}`);
  console.log(``);

  if (errors.length === 0) {
    console.log('✓ 验证通过 — 数据完全符合 Schema 定义');
    process.exit(0);
  } else {
    console.log(`✗ 验证失败 — 发现 ${errors.length} 个错误:\n`);
    errors.forEach((err, i) => {
      console.log(`  ${i + 1}. ${err}`);
    });
    console.log('');
    process.exit(1);
  }
}

main();

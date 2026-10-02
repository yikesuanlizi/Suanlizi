// Workflow 受限脚本静态校验（计划 §5.4 / §12.3）。
// 白名单 AST 校验：脚本只允许编排（agent/pipeline/parallel/phase/log/args + 局部变量），
// 禁止 import/模块加载、文件系统/shell/process/网络访问、Date.now/Math.random/无参 new Date、
// this 逃逸、constructor/prototype 访问、动态成员访问、修改运行时 API 引用。
// 任何绕过尝试都在这里被显式拒绝，不依赖运行时沙箱隐式失败。

import * as acorn from 'acorn';

/** 运行时注入的可调用 API 名称（readResult 属 §14.5 大结果分页消费入口）。 */
export const WORKFLOW_API_NAMES = ['agent', 'pipeline', 'parallel', 'phase', 'log', 'readResult'] as const;
/** 运行时注入的全部值名称（含不可调用的 args）。 */
export const WORKFLOW_VALUE_NAMES = [...WORKFLOW_API_NAMES, 'args'] as const;

/** 明确禁止的标识符：命中时给出比"未知标识符"更具体的错误信息。 */
const BANNED_IDENTIFIERS = new Set([
  'import', 'require', 'eval', 'Function', 'Date', 'Math', 'JSON',
  'process', 'globalThis', 'global', 'window', 'document', 'self',
  'fetch', 'XMLHttpRequest', 'WebSocket', 'setTimeout', 'setInterval', 'setImmediate',
  'queueMicrotask', 'Buffer', 'crypto', 'Reflect', 'Proxy', 'WebAssembly', 'Symbol',
]);

/** 禁止访问的属性名：原型链逃逸向量。 */
const BANNED_PROPERTIES = new Set(['constructor', '__proto__', 'prototype']);

/** 无副作用纯内建值：仅允许引用与调用静态方法（如 Array.isArray、Object.keys）。 */
export const WORKFLOW_PURE_BUILTINS = ['Boolean', 'String', 'Number', 'Array', 'Object', 'undefined', 'NaN', 'Infinity'] as const;

export interface WorkflowScriptDiagnostic {
  code: string;
  message: string;
  line?: number;
}

export interface WorkflowScriptMeta {
  name: string;
  description: string;
  phases: string[];
}

/**
 * P5：静态成本度量（计划 §7 P5「大任务警告和成本统计」）。
 * 只做展示与警告依据，不参与放行判定 —— 批准闸门始终是人。
 */
export interface WorkflowScriptCostMetrics {
  /** `agent(...)` 调用点数量（字面量个数，不含循环放大）。 */
  agentCallSites: number;
  /** 是否存在位于循环 / `pipeline` / `parallel` 体内的 `agent(...)` 调用（运行时成倍放大）。 */
  agentsInsideLoop: boolean;
  /** `pipeline(...)` / `parallel(...)` 调用点数量。 */
  fanOutSites: number;
}

export interface WorkflowScriptValidationResult {
  ok: boolean;
  diagnostics: WorkflowScriptDiagnostic[];
  meta?: WorkflowScriptMeta;
  /** 校验通过时的静态成本度量（不通过时为 undefined）。 */
  cost?: WorkflowScriptCostMetrics;
  /**
   * 可执行体：剥离唯一合法的 `export const meta` 前缀后的脚本正文。
   * 仅校验通过时存在；交给 WorkflowScriptRuntime 用受限 API 闭包执行。
   */
  executableBody?: string;
}

/** 脚本最大长度：防超大脚本拖垮校验。 */
export const WORKFLOW_SCRIPT_MAX_LENGTH = 64 * 1024;

export function validateWorkflowScript(script: string): WorkflowScriptValidationResult {
  const diagnostics: WorkflowScriptDiagnostic[] = [];
  const trimmed = typeof script === 'string' ? script : '';
  if (!trimmed.trim()) {
    return { ok: false, diagnostics: [{ code: 'script_empty', message: 'Workflow script is empty.' }] };
  }
  if (trimmed.length > WORKFLOW_SCRIPT_MAX_LENGTH) {
    return {
      ok: false,
      diagnostics: [{
        code: 'script_too_large',
        message: `Workflow script exceeds the ${WORKFLOW_SCRIPT_MAX_LENGTH} byte limit.`,
      }],
    };
  }

  // 预扫描：静态 import 与非 meta 的 export 在 script 模式下是语法错误，
  // 先文本级识别给出精确诊断并快速拒绝。
  const prescanDiagnostics: WorkflowScriptDiagnostic[] = [];
  for (const match of trimmed.matchAll(/(^|\n)\s*import\b/g)) {
    prescanDiagnostics.push({
      code: 'import_forbidden',
      message: 'import is not allowed in workflow scripts (scripts orchestrate only).',
      line: trimmed.slice(0, match.index ?? 0).split('\n').length,
    });
  }
  for (const match of trimmed.matchAll(/(^|\n)\s*export\s+(?!const\s+meta\b)/g)) {
    prescanDiagnostics.push({
      code: 'export_forbidden',
      message: 'Only `export const meta = {...}` is allowed in workflow scripts.',
      line: trimmed.slice(0, match.index ?? 0).split('\n').length,
    });
  }
  if (prescanDiagnostics.length > 0) {
    return { ok: false, diagnostics: prescanDiagnostics };
  }

  const preprocessed = trimmed.replace(/export\s+const\s+meta/, 'const meta');
  let program: acorn.Node;
  try {
    program = acorn.parse(preprocessed, {
      ecmaVersion: 'latest',
      sourceType: 'script',
      allowReturnOutsideFunction: true,
      allowAwaitOutsideFunction: true,
      locations: true,
    }) as unknown as acorn.Node;
  } catch (error) {
    return {
      ok: false,
      diagnostics: [{
        code: 'script_parse_error',
        message: `Workflow script is not parseable JavaScript: ${error instanceof Error ? error.message : String(error)}`,
      }],
    };
  }

  // Pass 1：收集全部局部声明名（变量/函数/参数/解构），支持函数提升。
  const declared = new Set<string>();
  collectDeclarations(program, declared);

  // Pass 2：白名单遍历校验；meta 从剥离后的顶层 const 声明提取。
  visit(program, declared, diagnostics);
  let meta: WorkflowScriptMeta | undefined;
  const metaDeclarator = findMetaDeclarator(program);
  if (metaDeclarator) {
    meta = extractMeta(metaDeclarator.init, diagnostics);
  } else {
    diagnostics.push({ code: 'meta_missing', message: 'Workflow script must declare `export const meta = { name, description, phases }`.' });
  }

  const ok = diagnostics.length === 0;
  return {
    ok,
    diagnostics,
    meta,
    cost: ok ? collectCostMetrics(program) : undefined,
    executableBody: ok ? preprocessed : undefined,
  };
}

// ─── 静态成本度量（P5；与白名单遍历独立，不影响安全判定） ────────────────────

const WORKFLOW_FAN_OUT_NAMES = new Set(['pipeline', 'parallel']);
const LOOP_NODE_TYPES = new Set(['ForStatement', 'ForInStatement', 'ForOfStatement', 'WhileStatement', 'DoWhileStatement']);

/**
 * 统计 `agent(...)` 调用点、`pipeline/parallel` 扇出点，以及 agent 调用是否处于
 * 循环体或 `pipeline/parallel` 回调内（两者都会在运行时把单次调用放大成 N 次）。
 */
function collectCostMetrics(program: acorn.Node): WorkflowScriptCostMetrics {
  let agentCallSites = 0;
  let fanOutSites = 0;
  let agentsInsideLoop = false;

  const walk = (node: unknown, loopDepth: number): void => {
    if (!node || typeof node !== 'object') return;
    const record = node as Record<string, unknown>;
    const type = typeof record.type === 'string' ? record.type : '';
    const nextDepth = LOOP_NODE_TYPES.has(type) || isFanOutCall(record) ? loopDepth + 1 : loopDepth;
    if (type === 'CallExpression') {
      const callee = record.callee as Record<string, unknown> | undefined;
      const name = callee && callee.type === 'Identifier' ? String(callee.name) : '';
      if (name === 'agent') {
        agentCallSites += 1;
        if (nextDepth > 0 || loopDepth > 0) agentsInsideLoop = true;
      } else if (WORKFLOW_FAN_OUT_NAMES.has(name)) {
        fanOutSites += 1;
      }
    }
    const childDepth = type === 'CallExpression' && isFanOutCall(record) ? Math.max(nextDepth, 1) : nextDepth;
    for (const key of Object.keys(record)) {
      if (key === 'type' || key === 'loc' || key === 'start' || key === 'end') continue;
      const child = record[key];
      if (Array.isArray(child)) {
        for (const item of child) walk(item, childDepth);
      } else if (child && typeof child === 'object') {
        walk(child, childDepth);
      }
    }
  };

  walk(program, 0);
  return { agentCallSites, agentsInsideLoop, fanOutSites };
}

function isFanOutCall(record: Record<string, unknown>): boolean {
  if (record.type !== 'CallExpression') return false;
  const callee = record.callee as Record<string, unknown> | undefined;
  return Boolean(callee && callee.type === 'Identifier' && WORKFLOW_FAN_OUT_NAMES.has(String(callee.name)));
}

// ─── Pass 1：声明收集 ─────────────────────────────────────────────────────────

function findMetaDeclarator(program: acorn.Node): Record<string, unknown> | undefined {
  const body = (program as unknown as { body?: Array<Record<string, unknown>> }).body ?? [];
  for (const statement of body) {
    if (statement.type !== 'VariableDeclaration' || statement.kind !== 'const' || !Array.isArray(statement.declarations)) continue;
    for (const declarator of statement.declarations as Array<Record<string, unknown>>) {
      const id = declarator.id as Record<string, unknown> | undefined;
      if (id?.type === 'Identifier' && id.name === 'meta') return declarator;
    }
  }
  return undefined;
}

function collectDeclarations(node: unknown, declared: Set<string>): void {
  if (!node || typeof node !== 'object') return;
  const n = node as Record<string, unknown>;
  if (n.type === 'VariableDeclaration' && Array.isArray(n.declarations)) {
    for (const declarator of n.declarations) {
      collectPatternNames((declarator as Record<string, unknown>).id, declared);
    }
  }
  if ((n.type === 'FunctionDeclaration' || n.type === 'FunctionExpression' || n.type === 'ArrowFunctionExpression')
    && n.id && typeof n.id === 'object' && (n.id as Record<string, unknown>).type === 'Identifier') {
    declared.add(String((n.id as Record<string, unknown>).name));
  }
  if (n.type === 'FunctionDeclaration' || n.type === 'FunctionExpression' || n.type === 'ArrowFunctionExpression') {
    collectPatternNames(n.params, declared);
  }
  if (n.type === 'CatchClause' && n.param) {
    collectPatternNames(n.param, declared);
  }
  for (const key of Object.keys(n)) {
    if (key === 'type' || key === 'loc' || key === 'start' || key === 'end') continue;
    const value = n[key];
    if (Array.isArray(value)) {
      for (const item of value) collectDeclarations(item, declared);
    } else if (value && typeof value === 'object' && typeof (value as Record<string, unknown>).type === 'string') {
      collectDeclarations(value, declared);
    }
  }
}

function collectPatternNames(pattern: unknown, declared: Set<string>): void {
  if (!pattern || typeof pattern !== 'object') return;
  const p = pattern as Record<string, unknown>;
  if (Array.isArray(p)) {
    for (const item of p) collectPatternNames(item, declared);
    return;
  }
  if (p.type === 'Identifier') declared.add(String(p.name));
  if (p.type === 'ObjectPattern' && Array.isArray(p.properties)) {
    for (const prop of p.properties) collectPatternNames((prop as Record<string, unknown>).value, declared);
  }
  if (p.type === 'ArrayPattern' && Array.isArray(p.elements)) {
    for (const item of p.elements) collectPatternNames(item, declared);
  }
  if (p.type === 'AssignmentPattern') collectPatternNames(p.left, declared);
  if (p.type === 'RestElement') collectPatternNames(p.argument, declared);
}

// ─── Pass 2：白名单遍历 ───────────────────────────────────────────────────────

function visit(
  node: unknown,
  declared: Set<string>,
  diagnostics: WorkflowScriptDiagnostic[],
): void {
  walk(node, null);

  function walk(current: unknown, parent: unknown): void {
    if (!current || typeof current !== 'object') return;
    const n = current as Record<string, unknown>;
    const type = typeof n.type === 'string' ? n.type : '';

    switch (type) {
      case 'ImportDeclaration':
      case 'ImportExpression':
      case 'ExportAllDeclaration':
        diagnostics.push(diag(n, 'import_forbidden', `${type === 'ImportExpression' ? 'Dynamic import()' : 'import'} is not allowed in workflow scripts.`));
        return;
      case 'ExportNamedDeclaration':
      case 'ExportDefaultDeclaration':
        // 预处理已剥侨唯一合法的 `export const meta`；走到这里的 export 都是非法形态。
        diagnostics.push(diag(n, 'export_forbidden', 'Only `export const meta = {...}` is allowed in workflow scripts.'));
        return;
      case 'ThisExpression':
        diagnostics.push(diag(n, 'this_forbidden', '`this` is not allowed in workflow scripts.'));
        return;
      case 'NewExpression':
        diagnostics.push(diag(n, 'new_forbidden', '`new` expressions are not allowed in workflow scripts (scripts orchestrate only).'));
        return;
      case 'TaggedTemplateExpression':
        diagnostics.push(diag(n, 'tagged_template_forbidden', 'Tagged template expressions are not allowed.'));
        return;
      case 'MemberExpression':
        checkMemberExpression(n, declared, diagnostics);
        break;
      case 'AssignmentExpression':
      case 'UpdateExpression':
        checkAssignmentTarget(n, declared, diagnostics);
        break;
      case 'CallExpression':
        checkCallExpression(n, declared, diagnostics);
        break;
      default:
        break;
    }

    // 标识符引用检查：跳过声明位置与属性键。
    if (type === 'Identifier' && !isDeclarationPosition(n, parent)) {
      const name = String(n.name);
      if (BANNED_IDENTIFIERS.has(name)) {
        diagnostics.push(diag(n, 'banned_identifier', `\`${name}\` is banned in workflow scripts.`));
      } else if (
        !declared.has(name)
        && !(WORKFLOW_VALUE_NAMES as readonly string[]).includes(name)
        && !(WORKFLOW_PURE_BUILTINS as readonly string[]).includes(name)
      ) {
        diagnostics.push(diag(n, 'unknown_identifier', `\`${name}\` is not allowed: only ${WORKFLOW_VALUE_NAMES.join('/')} and locally declared names may be referenced.`));
      }
    }
    // 局部声明不得遮蔽运行时 API 名。
    if (isDeclarationPosition(n, parent) && type === 'Identifier') {
      const name = String(n.name);
      if ((WORKFLOW_VALUE_NAMES as readonly string[]).includes(name)) {
        diagnostics.push(diag(n, 'shadow_runtime_api', `Local declaration \`${name}\` would shadow a workflow runtime API name and is not allowed.`));
      }
    }

    for (const key of Object.keys(n)) {
      if (key === 'type' || key === 'loc' || key === 'start' || key === 'end') continue;
      const value = n[key];
      if (Array.isArray(value)) {
        for (const item of value) walk(item, n);
      } else if (value && typeof value === 'object' && typeof (value as Record<string, unknown>).type === 'string') {
        walk(value, n);
      }
    }
  }
}

function extractMeta(init: unknown, diagnostics: WorkflowScriptDiagnostic[]): WorkflowScriptMeta | undefined {
  if (!init || (init as Record<string, unknown>).type !== 'ObjectExpression') {
    diagnostics.push(diag((init as Record<string, unknown>) ?? {}, 'meta_invalid', '`meta` must be a plain object literal.'));
    return undefined;
  }
  const fields = new Map<string, unknown>();
  for (const prop of (init as Record<string, unknown>).properties as Array<Record<string, unknown>>) {
    if (prop.type !== 'Property' || prop.computed === true) {
      diagnostics.push(diag(prop, 'meta_invalid', '`meta` properties must be plain string/array literal fields.'));
      return undefined;
    }
    const key = prop.key as Record<string, unknown>;
    fields.set(String(key.name ?? key.value), prop.value);
  }
  const name = metaString(fields.get('name'));
  const description = metaString(fields.get('description'));
  const phasesValue = fields.get('phases');
  if (name === undefined || description === undefined) {
    diagnostics.push(diag(init as Record<string, unknown>, 'meta_invalid', '`meta` requires literal `name` and `description` strings.'));
    return undefined;
  }
  const phases: string[] = [];
  if (phasesValue !== undefined) {
    if (!phasesValue || (phasesValue as Record<string, unknown>).type !== 'ArrayExpression') {
      diagnostics.push(diag((phasesValue as Record<string, unknown>) ?? ({}), 'meta_invalid', '`meta.phases` must be an array of string literals.'));
      return undefined;
    }
    for (const element of (phasesValue as Record<string, unknown>).elements as unknown[]) {
      const value = metaString(element);
      if (value === undefined) {
        diagnostics.push(diag((element as Record<string, unknown>) ?? ({}), 'meta_invalid', '`meta.phases` must only contain string literals.'));
        return undefined;
      }
      phases.push(value);
    }
  }
  return { name, description, phases };
}

function metaString(value: unknown): string | undefined {
  if (value && (value as Record<string, unknown>).type === 'Literal' && typeof (value as Record<string, unknown>).value === 'string') {
    return (value as Record<string, unknown>).value as string;
  }
  return undefined;
}

function checkMemberExpression(
  n: Record<string, unknown>,
  declared: Set<string>,
  diagnostics: WorkflowScriptDiagnostic[],
): void {
  // 先查属性名（原型逃逸向量），再查根对象 —— 让 `agent['constructor']` 报原型错误而非 API 成员错误。
  for (const node of memberChain(n)) {
    if (node.computed === true) {
      const property = node.property as Record<string, unknown>;
      if (!property || property.type !== 'Literal' || typeof property.value !== 'string') {
        diagnostics.push(diag(node, 'dynamic_member_access', 'Computed member access requires a string literal key.'));
        continue;
      }
    }
    const property = node.property as Record<string, unknown>;
    const propertyName = node.computed === true ? String((property as Record<string, unknown>)?.value) : String(property?.name);
    if (BANNED_PROPERTIES.has(propertyName)) {
      diagnostics.push(diag(node, 'prototype_access_forbidden', `Access to \`${propertyName}\` is not allowed in workflow scripts.`));
    }
  }

  const root = memberRoot(n);
  if (!root || root.type !== 'Identifier') {
    diagnostics.push(diag(n, 'member_root_forbidden', 'Member access must start from a local identifier, `args` or a pure builtin.'));
    return;
  }
  const rootName = String(root.name);
  if ((WORKFLOW_API_NAMES as readonly string[]).includes(rootName)) {
    diagnostics.push(diag(n, 'member_on_runtime_api', `Member access on runtime API \`${rootName}\` is not allowed.`));
    return;
  }
  if (rootName !== 'args' && !declared.has(rootName) && !(WORKFLOW_PURE_BUILTINS as readonly string[]).includes(rootName)) {
    diagnostics.push(diag(root, 'unknown_identifier', `\`${rootName}\` is not allowed: only ${WORKFLOW_VALUE_NAMES.join('/')} and locally declared names may be referenced.`));
  }
}

function memberChain(node: Record<string, unknown>): Array<Record<string, unknown>> {
  const chain: Array<Record<string, unknown>> = [];
  let current: Record<string, unknown> | undefined = node;
  while (current && current.type === 'MemberExpression') {
    chain.push(current);
    current = current.object as Record<string, unknown> | undefined;
  }
  return chain;
}

function memberRoot(node: Record<string, unknown>): Record<string, unknown> | undefined {
  let current: Record<string, unknown> | undefined = node;
  while (current && current.type === 'MemberExpression') {
    current = current.object as Record<string, unknown> | undefined;
  }
  return current;
}

function checkAssignmentTarget(
  n: Record<string, unknown>,
  declared: Set<string>,
  diagnostics: WorkflowScriptDiagnostic[],
): void {
  const target = n.left ?? n.argument;
  if (!target || typeof target !== 'object') return;
  const t = target as Record<string, unknown>;
  if (t.type === 'MemberExpression') {
    diagnostics.push(diag(n, 'member_assignment_forbidden', 'Property assignment is not allowed in workflow scripts.'));
    return;
  }
  if (t.type !== 'Identifier') {
    diagnostics.push(diag(n, 'assignment_target_forbidden', 'Only simple local variable assignment is allowed.'));
    return;
  }
  const name = String(t.name);
  if ((WORKFLOW_VALUE_NAMES as readonly string[]).includes(name) || !declared.has(name)) {
    diagnostics.push(diag(n, 'runtime_api_mutation', `Assignment to \`${name}\` is not allowed: workflow runtime API references are read-only and undeclared targets are forbidden.`));
  }
}

function checkCallExpression(
  n: Record<string, unknown>,
  declared: Set<string>,
  diagnostics: WorkflowScriptDiagnostic[],
): void {
  const callee = n.callee as Record<string, unknown> | undefined;
  if (!callee) return;
  if (callee.type === 'MemberExpression') {
    const root = memberRoot(callee);
    if (root && root.type === 'Identifier') {
      const rootName = String(root.name);
      if ((WORKFLOW_API_NAMES as readonly string[]).includes(rootName)) {
        diagnostics.push(diag(n, 'member_on_runtime_api', `Method call on runtime API \`${rootName}\` is not allowed.`));
      } else if (
        rootName !== 'args'
        && !declared.has(rootName)
        && !(WORKFLOW_PURE_BUILTINS as readonly string[]).includes(rootName)
      ) {
        diagnostics.push(diag(root, 'unknown_identifier', `\`${rootName}\` is not allowed: only ${WORKFLOW_VALUE_NAMES.join('/')} and locally declared names may be referenced.`));
      }
    }
    return;
  }
  if (callee.type !== 'Identifier') {
    diagnostics.push(diag(n, 'callee_forbidden', 'Only calls to workflow runtime APIs and locally declared functions are allowed.'));
  }
}

function isDeclarationPosition(node: Record<string, unknown>, parent: unknown): boolean {
  if (!parent || typeof parent !== 'object') return false;
  const p = parent as Record<string, unknown>;
  if (p.type === 'VariableDeclarator' && p.id === node) return true;
  if ((p.type === 'FunctionDeclaration' || p.type === 'FunctionExpression' || p.type === 'ArrowFunctionExpression') && p.id === node) return true;
  if ((p.type === 'FunctionDeclaration' || p.type === 'FunctionExpression' || p.type === 'ArrowFunctionExpression') && Array.isArray(p.params) && p.params.includes(node)) return true;
  if (p.type === 'CatchClause' && p.param === node) return true;
  if ((p.type === 'Property' || p.type === 'MethodDefinition') && p.key === node && p.computed !== true) return true;
  if (p.type === 'MemberExpression' && p.property === node && p.computed !== true) return true;
  if ((p.type === 'ObjectPattern' || p.type === 'ArrayPattern') && Array.isArray(p.properties) && p.properties.includes(node)) {
    // 解构模式中的键不是声明名；值才是。
    return false;
  }
  if (p.type === 'LabeledStatement' || p.type === 'BreakStatement' || p.type === 'ContinueStatement') return true;
  return false;
}

function diag(node: Record<string, unknown>, code: string, message: string): WorkflowScriptDiagnostic {
  const loc = node.loc as { start?: { line?: number } } | undefined;
  return { code, message, line: loc?.start?.line };
}

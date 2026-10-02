// Workflow 脚本静态校验测试（计划 §5.4 验收 + §12.3 白名单绕过用例）。
import { describe, expect, it } from 'vitest';
import { validateWorkflowScript } from './validator.js';

const PLAN_SAMPLE = `export const meta = {
  name: 'audit-auth-files',
  description: '扫描缺少鉴权检查的文件',
  phases: ['发现文件', '并行审计', '汇总']
}

phase('发现文件')

const found = await agent('找出可能包含鉴权检查的文件，返回文件路径列表。', {
  schema: {
    type: 'object',
    properties: { files: { type: 'array', items: { type: 'string' } } },
    required: ['files']
  }
})

phase('并行审计')

const audits = await pipeline(found.files, file =>
  agent(\`审计 \${file} 是否缺少鉴权检查，返回风险和证据。\`, {
    label: file,
    schema: {
      type: 'object',
      properties: {
        file: { type: 'string' },
        risk: { type: 'string', enum: ['low', 'medium', 'high'] },
        issue: { type: 'string' },
        evidence: { type: 'array', items: { type: 'string' } }
      },
      required: ['file', 'risk', 'issue', 'evidence']
    }
  })
)

return audits.filter(Boolean)`;

describe('validateWorkflowScript 正向用例', () => {
  it('计划 §5.4 示例脚本通过校验并提取 meta', () => {
    const result = validateWorkflowScript(PLAN_SAMPLE);
    expect(result.ok).toBe(true);
    expect(result.diagnostics).toEqual([]);
    expect(result.meta).toEqual({
      name: 'audit-auth-files',
      description: '扫描缺少鉴权检查的文件',
      phases: ['发现文件', '并行审计', '汇总'],
    });
    expect(result.executableBody).toBeDefined();
    expect(result.executableBody).not.toMatch(/export\s+const\s+meta/);
  });

  it('局部辅助函数、循环、解构和 args 属性访问通过校验', () => {
    const script = `export const meta = { name: 'n', description: 'd', phases: [] }
const files = (args && args.files) || []
async function auditOne(file) {
  const detail = await agent(\`审计 \${file}\`, { label: file })
  return detail
}
for (const file of files) {
  log(\`开始处理 \${file}\`)
}
const results = await parallel(files.map((file, index) => () => auditOne(file, index)))
return { results }
`;
    const result = validateWorkflowScript(script);
    expect(result.diagnostics).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('空脚本 / 超长脚本 / 不可解析脚本被拒绝', () => {
    expect(validateWorkflowScript('   ').ok).toBe(false);
    expect(validateWorkflowScript('const a ='.repeat(1)).ok).toBe(false);
    expect(validateWorkflowScript('x'.repeat(64 * 1024 + 1)).diagnostics[0]?.code).toBe('script_too_large');
  });
});

describe('validateWorkflowScript 负向用例（§5.4 + §12.3）', () => {
  const rejects = (script: string, expectedCode: string) => {
    const result = validateWorkflowScript(script);
    expect(result.ok).toBe(false);
    expect(result.diagnostics.map((d) => d.code)).toContain(expectedCode);
  };

  it('静态 import 被拒绝', () => {
    rejects("import fs from 'fs'", 'import_forbidden');
  });

  it('动态 import() 被拒绝（含逗号表达式包裹）', () => {
    rejects("const fs = await import('fs')", 'import_forbidden');
    rejects("(0, import('fs'))", 'import_forbidden');
  });

  it('fs / shell / process / fetch 等未声明标识符被拒绝', () => {
    rejects("const fs = require('fs')", 'banned_identifier');
    rejects("process.env.PATH", 'banned_identifier');
    rejects('fetch("https://example.com")', 'banned_identifier');
    rejects('setTimeout(() => agent("x"), 100)', 'banned_identifier');
  });

  it('Date.now / Math.random / new Date() 被拒绝', () => {
    rejects('const t = Date.now()', 'banned_identifier');
    rejects('const r = Math.random()', 'banned_identifier');
    rejects('const d = new Date()', 'new_forbidden');
  });

  it('eval / Function 动态构造被拒绝', () => {
    rejects("eval('1 + 1')", 'banned_identifier');
    rejects("Function('return 1')()", 'banned_identifier');
  });

  it('agent["constructor"] 与 ({}) .constructor 原型逃逸被拒绝', () => {
    rejects("const C = agent['constructor']", 'prototype_access_forbidden');
    rejects('const proto = ({}).constructor.prototype', 'member_root_forbidden');
  });

  it('this 逃逸被拒绝', () => {
    rejects('const self = this', 'this_forbidden');
  });

  it('__proto__ / prototype 原型链污染被拒绝', () => {
    rejects('const obj = {}; obj.__proto__.x = 1', 'prototype_access_forbidden');
  });

  it('getter/setter 间接访问（非标识符根对象）被拒绝', () => {
    rejects('const v = ({ get x() { return 1 } }).x', 'member_root_forbidden');
  });

  it('修改 agent / pipeline / parallel 引用被拒绝（赋值与遮蔽声明）', () => {
    rejects('agent = 1', 'runtime_api_mutation');
    rejects('const agent = () => 1', 'shadow_runtime_api');
    rejects('let pipeline = null', 'shadow_runtime_api');
  });

  it('对 API 的成员访问被拒绝（agent.constructor、args 原型向量除外规则）', () => {
    rejects('const c = agent.constructor', 'member_on_runtime_api');
    rejects('const p = pipeline.prototype', 'member_on_runtime_api');
  });

  it('动态计算成员访问被拒绝', () => {
    rejects('const key = "a"; const obj = { a: 1 }; const v = obj[key]', 'dynamic_member_access');
  });

  it('调用未知标识符被拒绝', () => {
    rejects('mysteryFn()', 'unknown_identifier');
  });

  it('非 meta 的 export 被拒绝', () => {
    rejects('export const helper = 1', 'export_forbidden');
    rejects('export default 1', 'export_forbidden');
  });
});

// ─── P5：静态成本度量（大任务警告依据） ───────────────────────────────────

describe('validateWorkflowScript 成本度量（P5）', () => {
  it('pipeline 内的 agent 调用 → agentsInsideLoop + 扇出点计数', () => {
    const result = validateWorkflowScript(PLAN_SAMPLE);
    expect(result.ok).toBe(true);
    expect(result.cost?.agentsInsideLoop).toBe(true);
    expect(result.cost?.fanOutSites).toBe(1);
    expect(result.cost?.agentCallSites).toBeGreaterThanOrEqual(2);
  });

  it('单个直列 agent 调用不触发放大标记', () => {
    const result = validateWorkflowScript([
      "export const meta = { name: 'one', description: 'd', phases: ['p'] };",
      'phase("p");',
      "const r = await agent('single call', { label: 'only' });",
      'return r;',
    ].join('\n'));
    expect(result.ok).toBe(true);
    expect(result.cost).toEqual({ agentCallSites: 1, agentsInsideLoop: false, fanOutSites: 0 });
  });

  it('for 循环体内的 agent 调用计入放大风险', () => {
    const result = validateWorkflowScript([
      "export const meta = { name: 'loop', description: 'd', phases: ['p'] };",
      'phase("p");',
      'const files = ["a.ts", "b.ts"];',
      'for (const file of files) {',
      '  await agent(`审计 ${file}`, { label: file });',
      '}',
      'return files.length;',
    ].join('\n'));
    expect(result.ok).toBe(true);
    expect(result.cost?.agentsInsideLoop).toBe(true);
  });

  it('校验不通过时不产出 cost', () => {
    expect(validateWorkflowScript("import fs from 'node:fs';\nreturn 1;").cost).toBeUndefined();
  });
});

// ─── §14.5：readResult 已纳入白名单 ────────────────────────────────────

describe('validateWorkflowScript readResult（§14.5）', () => {
  it('readResult 可作为函数调用，且句柄属性访问合法', () => {
    const result = validateWorkflowScript([
      "export const meta = { name: 'pages', description: 'd', phases: ['p1'] };",
      'phase("p1");',
      "const big = await agent('big');",
      'const page = readResult(big, { offset: 0, limit: 1000 });',
      'return { text: page.text, truncated: big.truncated };',
    ].join('\n'));
    expect(result.diagnostics).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('未列入白名单的名字仍被拒绝（readResult 不能为遮蔽声明）', () => {
    const unknown = validateWorkflowScript([
      "export const meta = { name: 'x', description: 'd', phases: ['p1'] };",
      'readResults(1);',
      'return 1;',
    ].join('\n'));
    expect(unknown.ok).toBe(false);
    expect(unknown.diagnostics.some((d) => d.code === 'unknown_identifier')).toBe(true);

    const shadow = validateWorkflowScript([
      "export const meta = { name: 'x', description: 'd', phases: ['p1'] };",
      'const readResult = 1;',
      'return readResult;',
    ].join('\n'));
    expect(shadow.ok).toBe(false);
    expect(shadow.diagnostics.some((d) => d.code === 'shadow_runtime_api')).toBe(true);
  });
});

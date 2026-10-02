/**
 * 输入栏的执行入口。它只描述用户此刻希望如何提交，不把 Goal、Dynamic
 * Workflow 或静态 Blueprint Workflow 混成同一个运行时对象。
 */
export type ComposerExecutionMode = 'chat' | 'plan' | 'goal' | 'ops';

/** 输入栏思考程度：no 关闭思考，Dynamic Workflow 固定使用最高档。 */
export type ComposerThinkingMode = 'no' | 'medium' | 'high' | 'xhigh' | 'max' | 'workflow';

/** Goal / Dynamic Workflow 的明确高自主默认值；项目当前不支持虚构的 max。 */
export const HIGH_AUTONOMY_OVERRIDES = {
  permissions: 'danger_full_access',
  reasoningEffort: 'max',
  runProfile: 'runtime_os',
} as const;

/**
 * 创建一份可审阅的最小合法 Script Workflow。
 * 用户提交 Workflow 时仅生成提案，必须在运行观察中批准后才会执行。
 */
export function createInitialWorkflowScript(objective: string): string {
  const normalized = objective.trim();
  const encodedObjective = JSON.stringify(normalized);
  return [
    `export const meta = { name: "用户工作流", description: ${encodedObjective}, phases: ["执行"] };`,
    'phase("执行");',
    `const result = await agent(${encodedObjective}, { label: "主代理" });`,
    'return { result };',
  ].join('\n');
}

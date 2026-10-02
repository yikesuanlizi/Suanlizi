/** 输入栏执行模式：Goal 是目标推进/验收，Dynamic Workflow 是独立的受限脚本运行。 */
export type ComposerExecutionMode = 'chat' | 'plan' | 'goal';

/** 输入栏思考程度：no 关闭思考，Dynamic Workflow 固定使用最高档。 */
export type ComposerThinkingMode = 'no' | 'medium' | 'high' | 'xhigh' | 'max' | 'workflow';

/** Goal 与 Dynamic Workflow 的高自主运行配置，统一固定最高思考档。 */
export const HIGH_AUTONOMY_OVERRIDES = {
  permissions: 'danger_full_access',
  reasoningEffort: 'max',
  runProfile: 'runtime_os',
} as const;

/**
 * Dynamic Workflow 的初始提案：受限 JS DSL，先进入待审阅状态，绝不直接执行。
 * 输入由 JSON.stringify 转义，避免目标文本破坏脚本字符串字面量。
 */
export function createInitialWorkflowScript(objective: string): string {
  const normalizedObjective = objective.trim();
  const encodedObjective = JSON.stringify(normalizedObjective);
  return [
    `export const meta = { name: "用户工作流", description: ${encodedObjective}, phases: ["执行"] };`,
    'phase("执行");',
    `const result = await agent(${encodedObjective}, { label: "主代理" });`,
    'return { result };',
  ].join('\n');
}

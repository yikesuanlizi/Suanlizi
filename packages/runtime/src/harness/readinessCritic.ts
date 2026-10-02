// 确定性规则 gate：ReadinessCritic
// 借鉴 Reasonix finalReadinessCheckFor — 先规则，后模型。
// 全部 gate 都是确定性判定，不调模型。
//
// Gate 规则：
// 1. todo_complete: 所有 plan node 状态为 completed
// 2. mutation_verified: 有 file_change → 必须有对应成功 verification command（Gap 7）
// 3. no_unresolved_errors: 最近 N 轮无未恢复的 error item
// 4. criteria_evidence: 每条 acceptanceCriteria 至少有 1 个 evidenceReceipt 支撑（Gap 8）
// 5. no_storm: StormBreaker 未触发

import type { ThreadItem } from '@suanlizi/protocol';
import type {
  EvidenceLedger,
} from './evidenceLedger.js';
import type { GoalTracker } from './goalTracker.js';
import type {
  EvidenceReceiptKind,
  ReadinessGate,
  ReadinessResult,
  StormBreakerResult,
} from './types.js';

// ─── Gap 7: verification command 识别 ───────────────────────────────────────
// 避免 `echo ok` / `ls` / `cat` 被误判为 verification 证据。

const VERIFICATION_COMMAND_PATTERNS: RegExp[] = [
  /^npm\s+test(\s|$)/,
  /^npm\s+run\s+(test|build|lint|typecheck)(\s|$)/,
  /^npx\s+(vitest|jest|tsc|eslint|prettier)(\s|$)/,
  /^pnpm\s+(test|build|lint|typecheck)(\s|$)/,
  /^yarn\s+(test|build|lint|typecheck)(\s|$)/,
  /^tsc\s+(-p|--project|--noEmit)(\s|$)/,
  /^vitest(\s|$)/,
  /^jest(\s|$)/,
  /^pytest(\s|$)/,
  /^python\s+-m\s+(pytest|unittest)(\s|$)/,
  /^go\s+(test|build|vet)(\s|$)/,
  /^cargo\s+(test|build|clippy)(\s|$)/,
  /^mvn\s+(test|verify|compile)(\s|$)/,
  /^gradle\s+(test|build)(\s|$)/,
  /^make\s+(test|check)(\s|$)/,
  /^dotnet\s+(test|build)(\s|$)/,
];

export function isVerificationCommand(command: string): boolean {
  const trimmed = command.trim();
  return VERIFICATION_COMMAND_PATTERNS.some(re => re.test(trimmed));
}

// ─── P3 证据 kind 白名单 ───────────────────────────────────────────────────
// readiness gate 只承认已知 kind 的证据；未知/伪造 kind 的收据一律视为无效证据
// （fail-closed），不得支撑 criteria 或 mutation 验收（计划 §7 P3）。

export const EVIDENCE_KIND_WHITELIST: readonly EvidenceReceiptKind[] = [
  'tool',
  'file_change',
  'command',
  'test',
  'checkpoint',
  'mcp',
  'error',
  'workflow_result',
];

function isWhitelistedEvidence(receipt: { kind: string }): boolean {
  return EVIDENCE_KIND_WHITELIST.includes(receipt.kind as EvidenceReceiptKind);
}

// ─── ReadinessCritic ─────────────────────────────────────────────────────────

export class ReadinessCritic {
  constructor(
    private ledger: EvidenceLedger,
    private goalTracker: GoalTracker,
  ) {}

  /**
   * 模型给出 final answer 后调用，检查所有确定性 gate。
   */
  check(items: ThreadItem[], stormResult?: StormBreakerResult): ReadinessResult {
    const gates: ReadinessGate[] = [];
    const state = this.goalTracker.getState();

    // Gate 1: todo_complete — 所有 plan node 状态为 completed
    gates.push(this.checkTodoComplete(state.plan));

    // Gate 2: mutation_verified — file_change 必须有对应 verification command
    gates.push(this.checkMutationVerified(items));

    // Gate 3: no_unresolved_errors — 最近 N 轮无未恢复的 error item
    gates.push(this.checkNoUnresolvedErrors(items));

    // Gate 4: criteria_evidence — 每条 acceptanceCriteria 至少有 1 个 evidenceReceipt 支撑
    gates.push(this.checkCriteriaEvidence(state.goal.acceptanceCriteria));

    // Gate 5: no_storm — StormBreaker 未触发
    gates.push(this.checkNoStorm(stormResult));

    const failedGates = gates.filter(g => !g.passed);
    const passed = failedGates.length === 0;

    return {
      passed,
      failedGates,
      retryInstruction: passed ? undefined : this.buildRetryInstruction(failedGates),
    };
  }

  // ─── Gate 实现 ──────────────────────────────────────────────────────────────

  private checkTodoComplete(plan: { status: string; id: string; description: string }[]): ReadinessGate {
    const pending = plan.filter(n => n.status !== 'completed');
    if (pending.length === 0) {
      return { name: 'todo_complete', passed: true, detail: 'all plan nodes completed' };
    }
    return {
      name: 'todo_complete',
      passed: false,
      detail: `未完成节点: ${pending.map(n => `${n.id}(${n.status})`).join(', ')}`,
    };
  }

  private checkMutationVerified(items: ThreadItem[]): ReadinessGate {
    const fileChanges = items.filter(i => i.type === 'file_change' && i.status === 'completed');
    if (fileChanges.length === 0) {
      return { name: 'mutation_verified', passed: true, detail: 'no mutations' };
    }

    // 必须有 isVerificationCommand = true 的成功 command 证据（kind 白名单内）
    const verifiedCommands = this.ledger
      .getRecentEvidence(50)
      .filter(isWhitelistedEvidence)
      .filter(r => r.kind === 'command' && r.status === 'passed')
      .filter(r => isVerificationCommand(r.refs.command ?? ''));

    if (verifiedCommands.length === 0) {
      return {
        name: 'mutation_verified',
        passed: false,
        detail: `检测到 ${fileChanges.length} 个文件变更，但没有对应的 verification command (npm test/vitest/tsc/pytest 等)`,
      };
    }

    return { name: 'mutation_verified', passed: true, detail: `${verifiedCommands.length} 个 verification 通过` };
  }

  private checkNoUnresolvedErrors(items: ThreadItem[]): ReadinessGate {
    // 检查最近 10 条 item 是否有 error
    const recent = items.slice(-10);
    const errors = recent.filter(i => i.type === 'error');
    if (errors.length === 0) {
      return { name: 'no_unresolved_errors', passed: true, detail: 'no recent errors' };
    }
    return {
      name: 'no_unresolved_errors',
      passed: false,
      detail: `${errors.length} 个未恢复错误: ${errors.map(e => (e as { message: string }).message.slice(0, 80)).join('; ')}`,
    };
  }

  private checkCriteriaEvidence(criteria: string[]): ReadinessGate {
    if (criteria.length === 0) {
      return { name: 'criteria_evidence', passed: true, detail: 'no criteria to check' };
    }
    if (this.ledger.size() === 0) {
      return { name: 'criteria_evidence', passed: true, detail: 'no structured evidence; defer to evaluator' };
    }
    const missing = criteria.filter(c =>
      this.ledger.getEvidenceForCriteria(c).filter(isWhitelistedEvidence).length === 0,
    );
    if (missing.length > 0) {
      return {
        name: 'criteria_evidence',
        passed: false,
        detail: `缺少证据支撑的 criteria: ${missing.join('; ')}`,
      };
    }
    return { name: 'criteria_evidence', passed: true, detail: 'all criteria have evidence' };
  }

  private checkNoStorm(stormResult?: StormBreakerResult): ReadinessGate {
    if (stormResult?.triggered) {
      return {
        name: 'no_storm',
        passed: false,
        detail: stormResult.reason ?? 'storm breaker triggered',
      };
    }
    return { name: 'no_storm', passed: true, detail: 'no storm detected' };
  }

  // ─── retry instruction 构造 ────────────────────────────────────────────────

  private buildRetryInstruction(failedGates: ReadinessGate[]): string {
    const lines: string[] = [];
    lines.push('Readiness check failed. Please address the following gates:');
    for (const g of failedGates) {
      lines.push(`- [${g.name}] ${g.detail}`);
    }
    lines.push('');
    lines.push('Do not declare completion until all gates pass. Continue working on the task.');
    return lines.join('\n');
  }
}

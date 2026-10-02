// 浏览器领域协议 Zod Schema 测试
// — English: browser domain protocol Zod schema tests
import { describe, expect, it } from 'vitest';
import {
  actionIntentSchema,
  actionRecordSchema,
  browserTaskEventSchema,
  browserTaskStateSchema,
  humanRequestSchema,
  observationSchema,
  type ActionIntent,
  type ActionRecord,
  type BrowserTaskEvent,
  type BrowserTaskState,
  type HumanRequest,
  type Observation,
} from '@suanlizi/protocol';

function makeObservation(overrides: Partial<Observation> = {}): Observation {
  return {
    observationId: 'obs-1',
    taskId: 'task-1',
    pageId: 'page-1',
    navigationEpoch: 1,
    capturedAt: 1700000000000,
    url: 'https://example.com/list',
    title: '示例列表',
    readiness: 'stable',
    elements: [
      {
        ref: '[e1]',
        role: 'link',
        name: '结果一',
        text: '结果一',
        frameId: 'frame-main',
        visible: true,
        enabled: true,
        fingerprint: 'fp-1',
        provenance: { trust: 'untrusted', source: 'dom', origin: 'https://example.com', pageId: 'page-1', observationId: 'obs-1' },
      },
    ],
    mainContent: [{ type: 'heading', text: '示例列表' }],
    forms: [],
    network: { pendingRequests: 0, recentFailures: [] },
    pageState: { captchaDetected: false, authRequired: false },
    ...overrides,
  };
}

function makeIntent(overrides: Partial<ActionIntent> = {}): ActionIntent {
  return {
    actionId: 'act-1',
    taskId: 'task-1',
    pageId: 'page-1',
    observationId: 'obs-1',
    expectedNavigationEpoch: 1,
    kind: 'click',
    targetRef: '[e1]',
    arguments: {},
    rationale: '打开结果一',
    effect: 'local',
    risk: 'low',
    postcondition: { kind: 'url_contains', value: 'detail' },
    ...overrides,
  };
}

function makeRecord(overrides: Partial<ActionRecord> = {}): ActionRecord {
  return {
    actionId: 'act-1',
    taskId: 'task-1',
    actionDigest: 'sha256:abc',
    effect: 'external_reversible',
    status: 'prepared',
    preState: {
      pageId: 'page-1',
      url: 'https://example.com/list',
      observationId: 'obs-1',
      navigationEpoch: 1,
    },
    expectedPostcondition: { kind: 'url_contains', value: 'detail' },
    preparedAt: 1700000000000,
    evidenceRefs: [],
    ...overrides,
  };
}

function makeHumanRequest(overrides: Partial<HumanRequest> = {}): HumanRequest {
  return {
    requestId: 'hr-1',
    taskId: 'task-1',
    type: 'confirm',
    prompt: '确认提交订单？',
    origin: 'https://example.com',
    timeoutMs: 60000,
    onTimeout: 'abort',
    ...overrides,
  };
}

function makeTaskState(overrides: Partial<BrowserTaskState> = {}): BrowserTaskState {
  return {
    taskId: 'task-1',
    goal: '比较两个结果',
    status: 'running',
    plan: [{ stepId: 's1', description: '打开页面', status: 'completed' }],
    budget: {
      maxSteps: 20, maxTokens: 100000, maxReplans: 3, maxConsecutiveFailures: 3,
      maxDurationMs: 600000, maxExternalWrites: 2, maxDownloadBytes: 10485760,
    },
    usage: { steps: 1, tokens: 100, replans: 0, consecutiveFailures: 0, externalWrites: 0, downloadBytes: 0, startedAt: 1700000000000 },
    ...overrides,
  };
}

describe('browser 领域协议 schema', () => {
  it('observation schema 接受合法观测并保留字段', () => {
    const parsed = observationSchema.parse(makeObservation());
    expect(parsed.pageId).toBe('page-1');
    expect(parsed.elements[0].ref).toBe('[e1]');
    expect(parsed.elements[0].provenance.trust).toBe('untrusted');
  });

  it('observation schema 接受无标题的初始空白页', () => {
    const parsed = observationSchema.parse(makeObservation({ title: '' }));
    expect(parsed.title).toBe('');
  });

  it('observation schema 拒绝非法元素引用格式', () => {
    const bad = makeObservation({ elements: [{ ...makeObservation().elements[0], ref: 'e1' }] });
    expect(() => observationSchema.parse(bad)).toThrow();
  });

  it('observation schema 拒绝未知字段（strict）', () => {
    const bad = { ...makeObservation(), surprise: true };
    expect(() => observationSchema.parse(bad)).toThrow();
  });

  it('actionIntent schema 接受合法意图', () => {
    const parsed = actionIntentSchema.parse(makeIntent());
    expect(parsed.expectedNavigationEpoch).toBe(1);
    expect(parsed.postcondition).toEqual({ kind: 'url_contains', value: 'detail' });
  });

  it('actionIntent schema 拒绝缺失 rationale', () => {
    const { rationale: _dropped, ...bad } = makeIntent();
    expect(() => actionIntentSchema.parse(bad)).toThrow();
  });

  it('actionRecord schema 接受 prepared 状态账本', () => {
    const parsed = actionRecordSchema.parse(makeRecord());
    expect(parsed.status).toBe('prepared');
    expect(parsed.preState.navigationEpoch).toBe(1);
  });

  it('actionRecord schema 拒绝非法账本状态', () => {
    const bad = makeRecord({ status: 'half-done' as never });
    expect(() => actionRecordSchema.parse(bad)).toThrow();
  });

  it('humanRequest schema 接受 confirm 请求并支持 captcha 类型', () => {
    expect(humanRequestSchema.parse(makeHumanRequest()).type).toBe('confirm');
    expect(humanRequestSchema.parse(makeHumanRequest({ type: 'captcha' })).type).toBe('captcha');
  });

  it('browserTaskState schema 接受完整任务状态', () => {
    const parsed = browserTaskStateSchema.parse(makeTaskState());
    expect(parsed.status).toBe('running');
    expect(parsed.budget.maxSteps).toBe(20);
  });

  it('browserTaskState schema 拒绝未知状态值', () => {
    const bad = makeTaskState({ status: 'exploding' as never });
    expect(() => browserTaskStateSchema.parse(bad)).toThrow();
  });

  it('任务事件 discriminated union 支持全部 13 种事件', () => {
    const events: BrowserTaskEvent[] = [
      { type: 'task.created', taskId: 'task-1', goal: 'g', createdAt: '2024-01-01T00:00:00.000Z' },
      { type: 'plan.updated', taskId: 'task-1', plan: [], updatedAt: '2024-01-01T00:00:00.000Z' },
      { type: 'observation.accepted', taskId: 'task-1', observationId: 'obs-1', pageId: 'page-1', navigationEpoch: 1, elementCount: 1, acceptedAt: '2024-01-01T00:00:00.000Z' },
      { type: 'action.prepared', taskId: 'task-1', record: makeRecord(), preparedAt: '2024-01-01T00:00:00.000Z' },
      { type: 'action.completed', taskId: 'task-1', actionId: 'act-1', outcome: 'committed', evidenceRefs: ['ev-1'], completedAt: '2024-01-01T00:00:00.000Z' },
      { type: 'action.uncertain', taskId: 'task-1', actionId: 'act-1', reason: '无法确认提交结果', uncertainAt: '2024-01-01T00:00:00.000Z' },
      { type: 'human.requested', taskId: 'task-1', request: makeHumanRequest() },
      { type: 'human.resolved', taskId: 'task-1', requestId: 'hr-1', approved: true, resolvedAt: '2024-01-01T00:00:00.000Z' },
      { type: 'budget.updated', taskId: 'task-1', usage: makeTaskState().usage, updatedAt: '2024-01-01T00:00:00.000Z' },
      { type: 'task.paused', taskId: 'task-1', pausedAt: '2024-01-01T00:00:00.000Z' },
      { type: 'task.cancelled', taskId: 'task-1', reason: '用户停止', cancelledAt: '2024-01-01T00:00:00.000Z' },
      { type: 'task.failed', taskId: 'task-1', failure: { kind: 'element', code: 'ELEM_STALE', message: '引用失效', retryable: true }, failedAt: '2024-01-01T00:00:00.000Z' },
      { type: 'task.completed', taskId: 'task-1', summary: '完成', completedAt: '2024-01-01T00:00:00.000Z' },
    ];
    for (const event of events) {
      expect(browserTaskEventSchema.parse(event).type).toBe(event.type);
    }
  });

  it('任务事件拒绝未知事件类型', () => {
    const bad = { type: 'task.exploded', taskId: 'task-1' };
    expect(() => browserTaskEventSchema.parse(bad)).toThrow();
  });

  it('任务事件拒绝缺少必填字段的 action.completed', () => {
    const bad = { type: 'action.completed', taskId: 'task-1', actionId: 'act-1' };
    expect(() => browserTaskEventSchema.parse(bad)).toThrow();
  });
});

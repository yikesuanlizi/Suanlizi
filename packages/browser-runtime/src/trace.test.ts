// 浏览器 Trace 记录器测试：observation 通过 runTraceObservationSchema 校验，
// spanId 递增、payload 关联、级别映射
// — English: browser trace recorder tests — observations pass
//   runTraceObservationSchema, spanIds increment, payloads correlate, levels map
import { describe, expect, it } from 'vitest';
import { runTraceObservationSchema, type RunTraceObservation } from '@suanlizi/protocol';
import { BrowserTraceRecorder } from './trace.js';

describe('BrowserTraceRecorder', () => {
  it('依次发出 observed/policy/actionStarted/actionFinished，全部通过 schema 校验', () => {
    const observations: RunTraceObservation[] = [];
    const recorder = new BrowserTraceRecorder({
      runId: 'run-1',
      threadId: 'thread-1',
      turnId: 'turn-1',
      runKind: 'turn',
      emit: (observation) => observations.push(observation),
    });

    recorder.observed({ pageId: 'p1', observationId: 'obs-1', url: 'https://example.com', elementCount: 12 });
    recorder.policy({ actionId: 'act-1', actionKind: 'click', outcome: 'denied', risk: 'high', effect: 'external_irreversible', reason: 'origin not in grant' });
    recorder.actionStarted({ actionId: 'act-2', actionKind: 'type', risk: 'low', effect: 'local' });
    recorder.actionFinished({ actionId: 'act-2', outcome: 'failed', verificationPassed: false, errorCode: 'E_TIMEOUT', actionKind: 'type' });

    expect(observations).toHaveLength(4);
    for (const observation of observations) {
      // schema 校验（strict payload + 关联 refine）；zod 推断退化时显式断言类型
      // — English: schema validation (strict payload + correlation refine)
      const parsed = runTraceObservationSchema.parse(observation) as RunTraceObservation;
      expect(parsed.category).toBe('browser');
      expect(observation.category).toBe('browser');
      expect(observation.lifecycle).toBe('instant');
      expect(observation.runKind).toBe('turn');
    }

    // spanId 递增
    // — English: spanIds increment
    expect(observations.map((o) => o.spanId)).toEqual(['span:browser:1', 'span:browser:2', 'span:browser:3', 'span:browser:4']);
    expect(observations.map((o) => o.name)).toEqual(['browser.observe', 'browser.policy', 'browser.action', 'browser.action']);

    // payload 关联与阶段
    // — English: payload correlation and phases
    expect(observations[0].payload).toMatchObject({ phase: 'observe', pageId: 'p1', observationId: 'obs-1', url: 'https://example.com/', elementCount: 12 });
    expect(observations[1].payload).toMatchObject({ phase: 'policy', actionId: 'act-1', actionKind: 'click', outcome: 'denied', risk: 'high' });
    expect(observations[2].payload).toMatchObject({ phase: 'execute', actionId: 'act-2', actionKind: 'type', risk: 'low', effect: 'local' });
    expect(observations[3].payload).toMatchObject({ phase: 'verify', actionId: 'act-2', outcome: 'failed', verificationPassed: false, errorCode: 'E_TIMEOUT' });

    // 级别映射：denied→warning、failed→error、其余 info
    // — English: level mapping — denied→warning, failed→error, else info
    expect(observations.map((o) => o.level)).toEqual(['info', 'warning', 'info', 'error']);
  });

  it('outcome 级别映射：denied→warning、uncertain/failed/cancelled→error、committed→info', () => {
    const observations: RunTraceObservation[] = [];
    const recorder = new BrowserTraceRecorder({
      runId: 'run-1',
      threadId: 'thread-1',
      runKind: 'control',
      emit: (observation) => observations.push(observation),
    });

    recorder.policy({ actionId: 'a1', actionKind: 'submit', outcome: 'allowed', risk: 'medium', effect: 'external_reversible' });
    recorder.actionFinished({ actionId: 'a1', outcome: 'committed', verificationPassed: true });
    recorder.actionFinished({ actionId: 'a2', outcome: 'uncertain', verificationPassed: false });
    recorder.actionFinished({ actionId: 'a3', outcome: 'cancelled', actionKind: 'click' });
    recorder.policy({ actionId: 'a4', actionKind: 'download', outcome: 'denied', risk: 'critical', reason: 'download not allowed' });

    expect(observations.map((o) => o.level)).toEqual(['info', 'info', 'error', 'error', 'warning']);
    // cancelled → phase 'cancel'
    // — English: cancelled maps to phase 'cancel'
    expect(observations[3].payload).toMatchObject({ phase: 'cancel', outcome: 'cancelled', actionId: 'a3' });
    expect(observations[1].payload).toMatchObject({ phase: 'verify', outcome: 'committed', verificationPassed: true });

    for (const observation of observations) {
      const parsed = runTraceObservationSchema.parse(observation) as RunTraceObservation;
      expect(parsed.category).toBe('browser');
    }
  });

  it('observed URL 的查询参数与片段被剥离（防 code/token 泄漏）', () => {
    const observations: RunTraceObservation[] = [];
    const recorder = new BrowserTraceRecorder({
      runId: 'run-1',
      threadId: 'thread-1',
      runKind: 'turn',
      turnId: 'turn-1',
      emit: (observation) => observations.push(observation),
    });

    recorder.observed({ pageId: 'p1', observationId: 'obs-1', url: 'https://user:secret@example.com/oauth/callback?code=abc123&state=x#frag', elementCount: 1 });

    expect(observations[0].payload).toMatchObject({
      phase: 'observe',
      url: 'https://example.com/oauth/callback',
    });
    expect(JSON.stringify(observations[0].payload)).not.toContain('abc123');
    expect(JSON.stringify(observations[0].payload)).not.toContain('secret');
  });
});

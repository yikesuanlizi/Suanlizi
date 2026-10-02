// 内存 Fake Browser Runtime 测试：观测契约、动作闭环、纪元校验、取消传播与后置条件验证
// — English: fake browser runtime tests — observation contract, action loop,
//   epoch validation, cancellation propagation and postcondition verification.
import { describe, expect, it } from 'vitest';
import type { ActionIntent } from '@suanlizi/protocol';
import { FakeBrowserRuntime, type FakeSessionHandle, type FakeSiteDefinition } from './fakeRuntime.js';

// 构造 ActionIntent 的测试辅助函数。
// — English: test helper building an ActionIntent.
function makeIntent(overrides: Partial<ActionIntent> = {}): ActionIntent {
  return {
    actionId: 'act-1',
    taskId: 'task-1',
    pageId: 'page-1',
    observationId: 'obs-task-1-1-1',
    expectedNavigationEpoch: 1,
    kind: 'click',
    targetRef: '[e1]',
    arguments: {},
    rationale: '测试动作',
    effect: 'none',
    risk: 'low',
    postcondition: { kind: 'none' },
    ...overrides,
  };
}

describe('FakeBrowserRuntime', () => {
  it('startUrl 不在 pages 中时构造抛错', () => {
    expect(() => new FakeBrowserRuntime({ startUrl: 'https://example.com/missing', pages: [] })).toThrow(
      /startUrl/,
    );
  });

  it('观测分配 [e1]/[e2]，provenance untrusted/dom，content/forms 透传', async () => {
    const site: FakeSiteDefinition = {
      startUrl: 'https://example.com/list',
      pages: [
        {
          url: 'https://example.com/list',
          title: '列表页',
          elements: [
            { ref: 'link-result-1', role: 'link', name: '结果一', text: '结果一', href: 'https://example.com/detail' },
            { ref: 'btn-submit', role: 'button', name: '提交', text: '提交' },
          ],
          content: [{ type: 'heading', text: '示例列表' }],
          forms: [{ formId: 'f1', method: 'get', fields: [{ name: 'q', required: false }] }],
        },
      ],
    };
    const session = await new FakeBrowserRuntime(site).start({ taskId: 'task-1' });
    expect(session.sessionId).toBe('sess-task-1');
    expect(session.taskId).toBe('task-1');

    const obs = await session.observe();
    expect(obs.observationId).toBe('obs-task-1-1-1');
    expect(obs.taskId).toBe('task-1');
    expect(obs.pageId).toBe('page-1');
    expect(obs.navigationEpoch).toBe(1);
    expect(obs.url).toBe('https://example.com/list');
    expect(obs.title).toBe('列表页');
    expect(obs.readiness).toBe('stable');
    expect(obs.screenshotRef).toBeUndefined();
    expect(obs.network).toEqual({ pendingRequests: 0, recentFailures: [] });
    expect(obs.pageState).toEqual({ captchaDetected: false, authRequired: false });

    expect(obs.elements.map((e) => e.ref)).toEqual(['[e1]', '[e2]']);
    const [first, second] = obs.elements;
    expect(first).toMatchObject({
      role: 'link',
      name: '结果一',
      text: '结果一',
      frameId: 'frame-main',
      visible: true,
      enabled: true,
    });
    expect(first.fingerprint).toBe('fp:link-result-1:1');
    expect(first.provenance).toEqual({
      trust: 'untrusted',
      source: 'dom',
      origin: 'https://example.com',
      pageId: 'page-1',
      observationId: 'obs-task-1-1-1',
    });
    expect(second).toMatchObject({ role: 'button', name: '提交', enabled: true });
    expect(second.fingerprint).toBe('fp:btn-submit:1');

    expect(obs.mainContent).toEqual([{ type: 'heading', text: '示例列表' }]);
    expect(obs.forms).toEqual([{ formId: 'f1', method: 'get', fields: [{ name: 'q', required: false }] }]);

    // 元素数组深拷贝：修改站点定义不影响会话内状态。
    // — English: deep copy — mutating the site definition must not affect the session.
    site.pages[0].elements![0].text = '被篡改';
    const obs2 = await session.observe();
    expect(obs2.elements[0].text).toBe('结果一');

    await session.close();
  });

  it('闭环：click 导航后 committed，再观测看到新页面元素', async () => {
    const site: FakeSiteDefinition = {
      startUrl: 'https://example.com/list',
      pages: [
        {
          url: 'https://example.com/list',
          title: '列表页',
          elements: [{ ref: 'link-result-1', role: 'link', name: '结果一', text: '结果一', href: 'https://example.com/detail' }],
          onAction: () => ({ kind: 'navigate', url: 'https://example.com/detail' }),
        },
        {
          url: 'https://example.com/detail',
          title: '详情页',
          elements: [{ ref: 'heading-detail', role: 'heading', name: '详情内容', text: '详情内容' }],
        },
      ],
    };
    const session = await new FakeBrowserRuntime(site).start({ taskId: 'task-1' });
    const obs = await session.observe();

    const result = await session.act({
      intent: makeIntent({
        actionId: 'act-1',
        observationId: obs.observationId,
        expectedNavigationEpoch: obs.navigationEpoch,
        kind: 'click',
        targetRef: '[e1]',
        postcondition: { kind: 'url_contains', value: 'detail' },
      }),
    });
    expect(result.status).toBe('committed');
    if (result.status === 'committed') {
      expect(result.evidence.actionId).toBe('act-1');
      expect(result.evidence.observed?.url).toBe('https://example.com/detail');
      expect(result.evidence.observed?.title).toBe('详情页');
      expect(result.evidence.observed?.navigationEpoch).toBe(2);
      expect(result.evidence.checks).toEqual([
        { postcondition: JSON.stringify({ kind: 'url_contains', value: 'detail' }), passed: true },
      ]);
    }

    const obs2 = await session.observe();
    expect(obs2.url).toBe('https://example.com/detail');
    expect(obs2.title).toBe('详情页');
    expect(obs2.navigationEpoch).toBe(2);
    // 观测计数按页面累计：该页面第 2 次观测。
    expect(obs2.observationId).toBe('obs-task-1-2-2');
    expect(obs2.elements).toHaveLength(1);
    expect(obs2.elements[0].ref).toBe('[e1]');
    expect(obs2.elements[0].name).toBe('详情内容');
    expect(obs2.elements[0].fingerprint).toBe('fp:heading-detail:2');

    await session.close();
  });

  it('旧引用拒绝：导航 epoch 递增后用旧 epoch 的 intent → STALE_EPOCH', async () => {
    const site: FakeSiteDefinition = {
      startUrl: 'https://example.com/list',
      pages: [
        { url: 'https://example.com/list', title: '列表页', elements: [{ ref: 'link-1', role: 'link', text: 'A' }] },
        { url: 'https://example.com/detail', title: '详情页', elements: [{ ref: 'link-2', role: 'link', text: 'B' }] },
      ],
    };
    const session = await new FakeBrowserRuntime(site).start({ taskId: 'task-1' });
    const obs = await session.observe(); // epoch 1
    await session.navigate({ url: 'https://example.com/detail' }); // epoch 2

    const result = await session.act({
      intent: makeIntent({
        actionId: 'act-1',
        observationId: obs.observationId,
        expectedNavigationEpoch: obs.navigationEpoch, // 旧 epoch（1）
        targetRef: '[e1]',
      }),
    });
    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.error.kind).toBe('element');
      expect(result.error.code).toBe('STALE_EPOCH');
      expect(result.error.retryable).toBe(true);
      expect(result.error.message).toBe('观测已过期，请重新观测');
      expect(result.error.actionId).toBe('act-1');
    }

    await session.close();
  });

  it('不可见元素不出现在观测中；禁用元素出现但 click → ELEMENT_DISABLED', async () => {
    const site: FakeSiteDefinition = {
      startUrl: 'https://example.com/list',
      pages: [
        {
          url: 'https://example.com/list',
          title: '列表页',
          elements: [
            { ref: 'hidden-1', role: 'button', text: '隐藏', visible: false },
            { ref: 'disabled-1', role: 'button', text: '禁用', enabled: false },
          ],
        },
      ],
    };
    const session = await new FakeBrowserRuntime(site).start({ taskId: 'task-1' });
    const obs = await session.observe();
    // 只有禁用元素可见 → [e1]。
    expect(obs.elements).toHaveLength(1);
    expect(obs.elements[0].ref).toBe('[e1]');
    expect(obs.elements[0].enabled).toBe(false);

    const disabled = await session.act({
      intent: makeIntent({ kind: 'click', targetRef: '[e1]' }),
    });
    expect(disabled.status).toBe('failed');
    if (disabled.status === 'failed') {
      expect(disabled.error.code).toBe('ELEMENT_DISABLED');
      expect(disabled.error.kind).toBe('element');
      expect(disabled.error.retryable).toBe(true);
    }

    // 隐藏元素不在观测中：直接按稳定 ref 引用 → ELEMENT_NOT_FOUND（动作只能引用观测结果）。
    // — English: hidden elements are absent from observations; referencing an unobserved
    //   element is ELEMENT_NOT_FOUND (actions may only reference validated observations).
    const hidden = await session.act({
      intent: makeIntent({ kind: 'click', targetRef: 'hidden-1' }),
    });
    expect(hidden.status).toBe('failed');
    if (hidden.status === 'failed') {
      expect(hidden.error.code).toBe('ELEMENT_NOT_FOUND');
    }

    // 不存在的元素 → ELEMENT_NOT_FOUND。
    const missing = await session.act({
      intent: makeIntent({ kind: 'click', targetRef: '[e9]' }),
    });
    expect(missing.status).toBe('failed');
    if (missing.status === 'failed') {
      expect(missing.error.code).toBe('ELEMENT_NOT_FOUND');
    }

    await session.close();
  });

  it('取消传播：onAction 返回 delay，act 期间 abort → ABORTED（cancelled）', async () => {
    const site: FakeSiteDefinition = {
      startUrl: 'https://example.com/list',
      pages: [
        {
          url: 'https://example.com/list',
          title: '列表页',
          elements: [{ ref: 'btn-1', role: 'button', text: '提交' }],
          onAction: () => ({ kind: 'delay', delayMs: 100 }),
        },
      ],
    };
    const session = await new FakeBrowserRuntime(site).start({ taskId: 'task-1' });
    await session.observe();

    const controller = new AbortController();
    const resultPromise = session.act({
      intent: makeIntent({ actionId: 'act-1', kind: 'click', targetRef: '[e1]' }),
      signal: controller.signal,
    });
    controller.abort();
    const result = await resultPromise;

    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.error.kind).toBe('cancelled');
      expect(result.error.code).toBe('ABORTED');
      expect(result.error.retryable).toBe(false);
      expect(result.error.actionId).toBe('act-1');
    }

    await session.close();
  });

  it('后置条件未满足 → uncertain（不盲目重试）', async () => {
    const site: FakeSiteDefinition = {
      startUrl: 'https://example.com/list',
      pages: [
        { url: 'https://example.com/list', title: '列表页', elements: [{ ref: 'btn-1', role: 'button', text: '提交' }] },
      ],
    };
    const session = await new FakeBrowserRuntime(site).start({ taskId: 'task-1' });
    const obs = await session.observe();

    const result = await session.act({
      intent: makeIntent({
        actionId: 'act-1',
        observationId: obs.observationId,
        expectedNavigationEpoch: obs.navigationEpoch,
        kind: 'click',
        targetRef: '[e1]',
        postcondition: { kind: 'element_appears', ref: '[e99]' },
      }),
    });
    expect(result.status).toBe('uncertain');
    if (result.status === 'uncertain') {
      expect(result.reason).toBe('后置条件未满足');
      expect(result.evidence.actionId).toBe('act-1');
      expect(result.evidence.checks).toHaveLength(1);
      expect(result.evidence.checks[0]).toEqual({
        postcondition: JSON.stringify({ kind: 'element_appears', ref: '[e99]' }),
        passed: false,
      });
      expect(result.evidence.observed?.navigationEpoch).toBe(1);
    }

    await session.close();
  });

  it('download_completed 后置条件 → uncertain（fake 无法证明下载）', async () => {
    const site: FakeSiteDefinition = {
      startUrl: 'https://example.com/list',
      pages: [
        { url: 'https://example.com/list', title: '列表页', elements: [{ ref: 'btn-1', role: 'button', text: '提交' }] },
      ],
    };
    const session = await new FakeBrowserRuntime(site).start({ taskId: 'task-1' });
    await session.observe();

    const result = await session.act({
      intent: makeIntent({
        actionId: 'act-1',
        kind: 'click',
        targetRef: '[e1]',
        postcondition: { kind: 'download_completed' },
      }),
    });
    expect(result.status).toBe('uncertain');
    if (result.status === 'uncertain') {
      expect(result.evidence.checks[0].passed).toBe(false);
      expect(result.evidence.checks[0].detail).toContain('下载');
    }

    await session.close();
  });

  it('download 动作：committed + externalEvidence.downloadId + readDownloads 记录 + 页面不变', async () => {
    const site: FakeSiteDefinition = {
      startUrl: 'https://example.com/files',
      pages: [
        {
          url: 'https://example.com/files',
          title: '文件列表',
          elements: [{ ref: 'dl-link', role: 'link', name: '下载报告', text: '下载报告' }],
        },
      ],
    };
    const session = (await new FakeBrowserRuntime(site).start({ taskId: 'task-1' })) as FakeSessionHandle;
    const obs = await session.observe();

    const result = await session.act({
      intent: makeIntent({
        actionId: 'act-dl-1',
        observationId: obs.observationId,
        expectedNavigationEpoch: obs.navigationEpoch,
        kind: 'download',
        targetRef: undefined,
        arguments: {
          url: 'https://example.com/files/report.pdf',
          suggestedName: 'report.pdf',
          mimeType: 'application/pdf',
          sizeBytes: 1024,
        },
        postcondition: { kind: 'download_completed' },
      }),
    });
    expect(result.status).toBe('committed');
    if (result.status === 'committed') {
      expect(result.evidence.externalEvidence?.downloadId).toMatch(/^dl-[0-9a-z]+-1$/);
      // 下载不改变页面：url/title/epoch 保持原值。
      expect(result.evidence.observed?.url).toBe('https://example.com/files');
      expect(result.evidence.observed?.title).toBe('文件列表');
      expect(result.evidence.observed?.navigationEpoch).toBe(1);
    }

    // 会话账本记录一条下载，字段完整。
    const downloads = session.readDownloads();
    expect(downloads).toHaveLength(1);
    expect(downloads[0]).toMatchObject({
      url: 'https://example.com/files/report.pdf',
      suggestedName: 'report.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 1024,
    });
    expect(downloads[0].at).toBeGreaterThan(0);

    // 页面状态确实未变：再次观测 url/title/epoch/元素一致。
    const obs2 = await session.observe();
    expect(obs2.url).toBe('https://example.com/files');
    expect(obs2.title).toBe('文件列表');
    expect(obs2.navigationEpoch).toBe(1);
    expect(obs2.elements.map((e) => e.ref)).toEqual(['[e1]']);

    await session.close();
  });

  it('download_completed 只对下载动作成立：click 动作即使会话已有下载记录仍 uncertain', async () => {
    const site: FakeSiteDefinition = {
      startUrl: 'https://example.com/files',
      pages: [
        {
          url: 'https://example.com/files',
          title: '文件列表',
          elements: [{ ref: 'dl-link', role: 'link', name: '下载报告', text: '下载报告' }],
        },
      ],
    };
    const session = (await new FakeBrowserRuntime(site).start({ taskId: 'task-1' })) as FakeSessionHandle;
    const obs = await session.observe();

    // 先成功下载一次（会话已有下载记录）。
    const dl = await session.act({
      intent: makeIntent({
        actionId: 'act-dl-1',
        observationId: obs.observationId,
        expectedNavigationEpoch: obs.navigationEpoch,
        kind: 'download',
        targetRef: undefined,
        arguments: { url: 'https://example.com/files/report.pdf', suggestedName: 'report.pdf' },
        postcondition: { kind: 'download_completed' },
      }),
    });
    expect(dl.status).toBe('committed');

    // click 动作配 download_completed：本次动作未产生下载 → uncertain。
    const click = await session.act({
      intent: makeIntent({
        actionId: 'act-click-1',
        observationId: obs.observationId,
        expectedNavigationEpoch: obs.navigationEpoch,
        kind: 'click',
        targetRef: '[e1]',
        postcondition: { kind: 'download_completed' },
      }),
    });
    expect(click.status).toBe('uncertain');
    if (click.status === 'uncertain') {
      expect(click.evidence.checks[0].passed).toBe(false);
      expect(click.evidence.checks[0].detail).toContain('下载');
    }
    // click 不产生下载：账本仍只有 1 条。
    expect(session.readDownloads()).toHaveLength(1);

    await session.close();
  });

  it('navigate 后 currentPageGraph 反映 url 变化、epoch 递增', async () => {
    const site: FakeSiteDefinition = {
      startUrl: 'https://example.com/list',
      pages: [
        { url: 'https://example.com/list', title: '列表页', elements: [{ ref: 'link-1', role: 'link', text: 'A' }] },
        { url: 'https://example.com/detail', title: '详情页', elements: [{ ref: 'link-2', role: 'link', text: 'B' }] },
      ],
    };
    const session = await new FakeBrowserRuntime(site).start({ taskId: 'task-1' });

    const graph1 = session.currentPageGraph();
    expect(graph1.activePageId).toBe('page-1');
    expect(graph1.pages).toHaveLength(1);
    expect(graph1.pages[0]).toEqual({
      pageId: 'page-1',
      url: 'https://example.com/list',
      title: '列表页',
      state: 'active',
      navigationEpoch: 1,
    });

    await session.navigate({ url: 'https://example.com/detail' });
    const graph2 = session.currentPageGraph();
    expect(graph2.activePageId).toBe('page-1');
    expect(graph2.pages[0].url).toBe('https://example.com/detail');
    expect(graph2.pages[0].title).toBe('详情页');
    expect(graph2.pages[0].state).toBe('active');
    expect(graph2.pages[0].navigationEpoch).toBe(2);

    await session.close();
  });

  it('close 后再调用 observe 抛错', async () => {
    const site: FakeSiteDefinition = {
      startUrl: 'https://example.com/list',
      pages: [{ url: 'https://example.com/list', title: '列表页' }],
    };
    const session = await new FakeBrowserRuntime(site).start({ taskId: 'task-1' });
    await session.close('测试结束');
    await expect(session.observe()).rejects.toThrow('session closed');
    expect(() => session.currentPageGraph()).toThrow('session closed');
  });

  it('act(kind=navigate) 无 onAction 时按 arguments.url 默认导航并验证后置条件', async () => {
    const site: FakeSiteDefinition = {
      startUrl: 'https://example.com/list',
      pages: [
        { url: 'https://example.com/list', title: '列表页' },
        { url: 'https://example.com/detail', title: '详情页', elements: [{ ref: 'back', role: 'link', name: '返回', text: '返回' }] },
      ],
    };
    const session = await new FakeBrowserRuntime(site).start({ taskId: 'task-1' });
    const obs = await session.observe();

    const result = await session.act({
      intent: {
        actionId: 'act-nav',
        taskId: 'task-1',
        pageId: obs.pageId,
        observationId: obs.observationId,
        expectedNavigationEpoch: obs.navigationEpoch,
        kind: 'navigate',
        arguments: { url: 'https://example.com/detail' },
        rationale: '导航到详情页',
        effect: 'none',
        risk: 'low',
        postcondition: { kind: 'url_contains', value: 'detail' },
      },
    });

    expect(result.status).toBe('committed');
    if (result.status === 'committed') {
      expect(result.evidence.observed?.url).toBe('https://example.com/detail');
      expect(result.evidence.observed?.navigationEpoch).toBe(2);
    }
    const after = await session.observe();
    expect(after.elements.map((e) => e.ref)).toEqual(['[e1]']);
    await session.close();
  });
});

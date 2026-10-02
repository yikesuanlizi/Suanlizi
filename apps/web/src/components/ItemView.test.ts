import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AssistantTurnView, ItemView, TurnPreparingIndicator, sanitizeAgentMessageTextForDisplay, summarizeToolItem } from './ItemView.js';

const here = dirname(fileURLToPath(import.meta.url));

it('keeps transcript errors visible after legacy dismissal rules', () => {
  const styles = readFileSync(join(here, '..', 'styles.css'), 'utf-8');
  const selector = '.appShell :is(.message.error, .assistantTurnError, .childActivityError, .workspaceFileError, .gitNexusError, .gitNexusResultError) {';
  const ruleStart = styles.lastIndexOf(selector);
  const ruleEnd = styles.indexOf('}', ruleStart);
  const finalRule = styles.slice(ruleStart, ruleEnd);

  expect(ruleStart).toBeGreaterThan(styles.lastIndexOf('animation: suanliziErrorNoticeDismiss'));
  expect(finalRule).toContain('animation: none !important;');
  expect(finalRule).toContain('opacity: 1 !important;');
  expect(finalRule).toContain('max-height: none !important;');
});

describe('agent message avatars', () => {
  it('renders the Suanlizi robot mood avatar for assistant history and streaming turns', () => {
    const source = readFileSync(join(here, 'ItemView.tsx'), 'utf-8');

    expect(source).toContain('messageAgentAvatar');
    expect(source).toContain('<RobotMoodIcon variant={moodVariant} />');
    // 进行中不再播放 working/thinking 头像动画（流式输出旁已有 StreamingOutputIcon），
    // 避免同一气泡两个"思考"动画重复。
    // — English: in-progress avatars are static now (the StreamingOutputIcon is
    //   the single thinking indicator) — no duplicate animations in one bubble.
    expect(source).toContain("if (item.status === 'in_progress') return 'idle';");
  });

  it('renders the working icon inline on the active streaming output line', () => {
    const source = readFileSync(join(here, 'ItemView.tsx'), 'utf-8');
    const styles = readFileSync(join(here, '..', 'styles.css'), 'utf-8');

    expect(source).toContain('showStreamingOutputIcon');
    expect(source).toContain('function StreamingOutputIcon()');
    expect(source).toContain('streamingOutputIcon');
    expect(source).toContain('M18 62 L8 66');
    expect(source).toContain('values="84; 115; 115"');
    expect(source).toContain('from="0 82 82" to="360 82 82"');
    expect(source).toContain("item.id === streamingAgentItemId");
    expect(styles).toContain('.streamingOutputLine');
    expect(styles).toContain('grid-template-columns: 34px minmax(0, 1fr);');
  });

  it('renders user messages with the configured user avatar on the right side', () => {
    const source = readFileSync(join(here, 'ItemView.tsx'), 'utf-8');
    const styles = readFileSync(join(here, '..', 'styles.css'), 'utf-8');

    expect(source).toContain('messageUserAvatar');
    expect(source).toContain('<UserAvatar avatarId={userAvatarId} customDataUrl={customUserAvatarDataUrl} size="sm" />');
    expect(styles).toContain('.messageBlock.user > .messageUserAvatar');
    expect(styles).toContain('grid-template-columns: minmax(0, 1fr) 38px;');
  });
});

describe('tool item summaries', () => {
  it('shows the searched content for search_content calls', () => {
    const summary = summarizeToolItem({
      id: 'tool-1',
      type: 'tool_call',
      toolName: 'search_content',
      arguments: { pattern: '工具调用', path: 'apps/web' },
      status: 'completed',
    }, 'zh');

    expect(summary.name).toBe('search_content');
    expect(summary.value).toBe('工具调用');
    expect(summary.meta).toBe('apps/web');
  });

  it('shows the file path for read_file calls', () => {
    const summary = summarizeToolItem({
      id: 'tool-2',
      type: 'tool_call',
      toolName: 'read_file',
      arguments: { filePath: 'apps/web/src/main.tsx', offset: 10 },
      status: 'completed',
    }, 'zh');

    expect(summary.name).toBe('read_file');
    expect(summary.value).toBe('apps/web/src/main.tsx');
    expect(summary.meta).toBe('offset 10');
  });

  it('uses the command text for command execution rows', () => {
    const summary = summarizeToolItem({
      id: 'cmd-1',
      type: 'command_execution',
      command: 'npm test',
      status: 'completed',
    }, 'zh');

    expect(summary.name).toBe('shell_command');
    expect(summary.value).toBe('npm test');
  });
});

describe('message markdown rendering', () => {
  it('renders markdown tables and emphasis in assistant messages', () => {
    const html = renderToStaticMarkup(
      React.createElement(ItemView, {
        item: {
          id: 'agent-1',
          type: 'agent_message',
          text: [
            '文档缺失:',
            '| 知识类型 | 时效特征 | 当前文档缺失 |',
            '|---|---|---|',
            '| **MEL/CDL** | 经常更新 | 未说明版本 |',
          ].join('\n'),
          status: 'completed',
        },
        locale: 'zh',
      }),
    );

    expect(html).toContain('<table>');
    expect(html).toContain('<strong>MEL/CDL</strong>');
    expect(html).not.toContain('|---|---|---|');
  });

  it('keeps assistant markdown emphasis on the base text color', () => {
    const styles = readFileSync(join(here, '..', 'styles.css'), 'utf-8');
    const paleMessageStrongRule = styles.indexOf('.message summary,\n  .message strong,');
    const readableMarkdownStrongRule = styles.indexOf('.message.agent .markdownMessageText :where(strong, b)');

    expect(paleMessageStrongRule).toBeGreaterThan(-1);
    expect(readableMarkdownStrongRule).toBeGreaterThan(paleMessageStrongRule);
    expect(styles).toMatch(/\.message\.agent \.markdownMessageText :where\(strong, b\)\s*\{\s*color: var\(--nx-text\);\s*\}/);
  });
});

describe('message action visibility', () => {
  it('renders a compact preparing marker before the first streamed event', () => {
    const html = renderToStaticMarkup(React.createElement(TurnPreparingIndicator, { locale: 'zh' }));
    expect(html).toContain('role="status"');
    expect(html).toContain('正在准备回复');
    expect(html).toContain('turnPreparingDots');
  });

  it('only keeps the currently running expandable block open', () => {
    const html = renderToStaticMarkup(
      React.createElement(AssistantTurnView, {
        group: {
          turnId: 'turn-running',
          status: 'running',
          items: [
            { id: 'reasoning-running', type: 'reasoning', turnId: 'turn-running', text: '正在思考', status: 'completed' },
            { id: 'tool-previous', type: 'tool_call', turnId: 'turn-running', toolName: 'list_files', arguments: {}, status: 'in_progress' },
            { id: 'tool-running', type: 'tool_call', turnId: 'turn-running', toolName: 'read_file', arguments: {}, status: 'in_progress' },
          ],
        },
        locale: 'zh',
      }),
    );
    expect(html).not.toMatch(/<details class="reasoningDetails"[^>]*open=""/);
    expect(html).toMatch(/<details class="toolBatchDetails"[^>]*open=""/);
    expect(html.match(/<details class="message tool inlineTool"[^>]*open=""/g) ?? []).toHaveLength(1);
  });


  it('keeps a streaming reasoning block open even before status arrives', () => {
    const html = renderToStaticMarkup(
      React.createElement(AssistantTurnView, {
        group: {
          turnId: 'turn-reasoning-running',
          status: 'running',
          items: [
            { id: 'reasoning-streaming', type: 'reasoning', turnId: 'turn-reasoning-running', text: '正在思考', timestamp: '2026-08-23T00:00:00.000Z' },
          ],
        },
        locale: 'zh',
      }),
    );

    expect(html).toContain('data-running="true"');
    expect(html).toMatch(/open=""/);
  });

  it('keeps a live tool batch open while any child is still running', () => {
    const html = renderToStaticMarkup(
      React.createElement(AssistantTurnView, {
        group: {
          turnId: 'turn-tool-running',
          status: 'running',
          items: [
            { id: 'tool-active', type: 'tool_call', turnId: 'turn-tool-running', toolName: 'web_search', arguments: {}, status: 'in_progress' },
          ],
        },
        locale: 'zh',
      }),
    );

    expect(html).toMatch(/<details class="toolBatchDetails"[^>]*open=""/);
  });

  it('keeps reasoning output collapsed instead of rendering its raw item payload', () => {
    const html = renderToStaticMarkup(
      React.createElement(AssistantTurnView, {
        group: {
          turnId: 'turn-reasoning',
          items: [
            { id: 'reasoning-1', type: 'reasoning', turnId: 'turn-reasoning', text: '内部推理文本', status: 'completed', timestamp: new Date(Date.now() - 3000).toISOString(), completedAt: new Date().toISOString() },
          ],
        },
        locale: 'zh',
      }),
    );

    expect(html).toContain('<details class="reasoningDetails">');
    // 折叠标题由 CSS 显示为 THINK 小字；summary 内容为思考时长（思考 Ns）。
    // — English: the fold title is the CSS THINK label; the summary carries the
    //   thinking-time span.
    expect(html).toContain('reasoningElapsed');
    expect(html).toContain('思考 ');
    expect(html).toContain('内部推理文本');
    expect(html).not.toContain('&quot;type&quot;:&quot;reasoning&quot;');
  });

  it('lets the whole reasoning summary row toggle, not only the THINK label', () => {
    const styles = readFileSync(join(here, '..', 'styles.css'), 'utf-8');
    const marker = '/* Chromium 在 flex summary 上只把点击算在 summary 自身（::before 的 THINK）。';
    const start = styles.lastIndexOf(marker);
    const rule = styles.slice(start, styles.indexOf('/* Settings density', start));

    expect(start).toBeGreaterThan(styles.lastIndexOf('.appShell .reasoningDetails > summary {'));
    expect(rule).toContain('justify-content: flex-start');
    expect(rule).toContain('width: auto');
    expect(rule).not.toContain('width: 100%');
    expect(rule).toContain('pointer-events: none');
    expect(rule).toContain('padding-right: 12px');
  });

  it('shows timestamp and copy actions for error-only assistant turns', () => {
    const html = renderToStaticMarkup(
      React.createElement(AssistantTurnView, {
        group: {
          turnId: 'turn-error',
          items: [
            { id: 'err-1', type: 'error', turnId: 'turn-error', message: 'OpenAI gateway error (401)', status: 'failed' },
          ],
        },
        locale: 'zh',
      }),
    );

    expect(html).toContain('模型服务未授权');
    expect(html).not.toContain('OpenAI gateway error (401)');
    expect(html).toContain('messageActions');
    expect(html).toContain('messageTimestamp');
    expect(html).toContain('aria-label="复制"');
  });

  it('only renders rollback on a user message when explicitly allowed', () => {
    const baseItem = { id: 'u1', type: 'user_message', turnId: 'turn-1', text: '你好', status: 'completed' };
    const hidden = renderToStaticMarkup(
      React.createElement(ItemView, { item: baseItem, locale: 'zh', canRollback: false }),
    );
    const visible = renderToStaticMarkup(
      React.createElement(ItemView, { item: baseItem, locale: 'zh', canRollback: true }),
    );

    expect(hidden).not.toContain('回退到这里');
    expect(visible).toContain('回退到这里');
  });

  it('renders regenerate only for the latest assistant turn when allowed', () => {
    const group = {
      turnId: 'turn-1',
      items: [{ id: 'a1', type: 'agent_message', turnId: 'turn-1', text: '回答', status: 'completed' }],
    };
    const hidden = renderToStaticMarkup(
      React.createElement(AssistantTurnView, { group, locale: 'zh', canRegenerate: false }),
    );
    const visible = renderToStaticMarkup(
      React.createElement(AssistantTurnView, { group, locale: 'zh', canRegenerate: true }),
    );

    expect(hidden).not.toContain('重新回答');
    expect(visible).toContain('重新回答');
  });
});

describe('agent message display sanitizing', () => {
  it('hides Gitee flattened tool-call transcripts from assistant history', () => {
    const sanitized = sanitizeAgentMessageTextForDisplay([
      '我继续处理。',
      '',
      '[工具调用]',
      '名称: read_file',
      '参数: {"filePath":"README.md"}',
      '[工具结果]',
      '内容: ...',
    ].join('\n'), 'zh');

    expect(sanitized).toContain('我继续处理。');
    expect(sanitized).toContain('已隐藏模型误输出的文本工具调用');
    expect(sanitized).not.toContain('[工具调用]');
    expect(sanitized).not.toContain('README.md');
  });
});

describe('assistant turn file summary', () => {
  it('renders read and changed files after assistant turn content', () => {
    const html = renderToStaticMarkup(
      React.createElement(AssistantTurnView, {
        group: {
          turnId: 'turn-1',
          items: [
            { id: 'a1', type: 'agent_message', turnId: 'turn-1', text: '完成', status: 'completed' },
            { id: 'r1', type: 'tool_call', turnId: 'turn-1', toolName: 'read_file', arguments: { filePath: 'apps/web/src/main.tsx' }, result: { path: 'E:\\langchain\\Suanlizi\\apps\\web\\src\\main.tsx' }, status: 'completed' },
            { id: 'c1', type: 'file_change', turnId: 'turn-1', changes: [{ path: 'apps/web/src/components/ItemView.tsx', kind: 'update', addedLines: 4, removedLines: 1 }], status: 'completed' },
          ],
        },
        locale: 'zh',
        workspaceRoot: 'E:\\langchain\\Suanlizi',
      }),
    );

    expect(html).toContain('阅读文件');
    expect(html).toContain('修改文件');
    expect(html).toContain('E:\\langchain\\Suanlizi\\apps\\web\\src\\main.tsx');
    expect(html).toContain('+4');
    expect(html).toContain('-1');
  });

  it('renders involved files as preview buttons when preview is available', () => {
    const html = renderToStaticMarkup(
      React.createElement(AssistantTurnView, {
        group: {
          turnId: 'turn-1',
          items: [
            { id: 'a1', type: 'agent_message', turnId: 'turn-1', text: '完成', status: 'completed' },
            { id: 'r1', type: 'tool_call', turnId: 'turn-1', toolName: 'read_file', arguments: { filePath: 'apps/web/src/main.tsx' }, result: { path: 'E:\\langchain\\Suanlizi\\apps\\web\\src\\main.tsx' }, status: 'completed' },
          ],
        },
        locale: 'zh',
        onPreviewFile: () => undefined,
        workspaceRoot: 'E:\\langchain\\Suanlizi',
      }),
    );

    expect(html).toContain('class="turnFileSummaryPath"');
    expect(html).toContain('type="button"');
    expect(html).toContain('aria-label="预览文件 E:\\langchain\\Suanlizi\\apps\\web\\src\\main.tsx"');
  });

  it('keeps involved file summary text on neutral readable colors', () => {
    const styles = readFileSync(join(here, '..', 'styles.css'), 'utf-8');
    const paleMessageStrongRule = styles.indexOf('.message summary,\n  .message strong,');
    const readableHeaderRule = styles.indexOf('.message.agent .turnFileSummaryHeader :where(strong, span)');

    expect(paleMessageStrongRule).toBeGreaterThan(-1);
    expect(readableHeaderRule).toBeGreaterThan(paleMessageStrongRule);
    expect(styles).toMatch(/\.message\.agent \.turnFileSummaryHeader :where\(strong, span\)\s*\{\s*color: var\(--nx-text\);\s*\}/);
    expect(styles).toMatch(/\.message\.agent \.turnFileSummaryPath\s*\{[\s\S]*?color: var\(--nx-text\);/);
  });
});

describe('conversation surface contract', () => {
  it('uses semantic chat and involved-file surfaces instead of a pale card stack', () => {
    const styles = readFileSync(join(here, '..', 'styles.css'), 'utf-8');
    const finalContract = styles.slice(styles.lastIndexOf('/* Suanlizi conversation surface contract */'));

    expect(finalContract).toContain('.appShell .messageBlock.agent .message.agent');
    expect(finalContract).toContain('background: var(--nx-surface-panel);');
    expect(finalContract).toContain('.appShell .turnFileSummary');
    expect(finalContract).toContain('background: var(--nx-surface-overlay);');
    expect(finalContract).toContain('.appShell .messageActionButton');
  });
});

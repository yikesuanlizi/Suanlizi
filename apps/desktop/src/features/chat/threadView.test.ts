import { describe, expect, it } from 'vitest';
import { applyAgentMessageDelta, describeEvent, eventKey, eventRenderKey, groupTranscriptItems, itemKey, mergeThreadItems, removeThreadItem, withSyntheticUserMessages } from './threadView.js';

describe('threadView', () => {
  it('groups assistant text and tool calls from the same turn into one assistant bubble', () => {
    const groups = groupTranscriptItems(
      [
        { id: 'u1', type: 'user_message', turnId: 'turn-1', text: 'start' },
        { id: 'a1', type: 'agent_message', turnId: 'turn-1', text: 'first' },
        { id: 'tool1', type: 'collab_tool_call', turnId: 'turn-1', tool: 'spawn_agent', status: 'completed' },
        { id: 'a2', type: 'agent_message', turnId: 'turn-1', text: 'second' },
      ],
      [{ turnId: 'turn-1', userInput: { type: 'text', text: 'start' }, status: 'completed' }],
    );

    expect(groups).toEqual([
      expect.objectContaining({ kind: 'user', item: expect.objectContaining({ id: 'u1' }) }),
      expect.objectContaining({
        kind: 'assistant',
        turnId: 'turn-1',
        status: 'completed',
        items: [
          expect.objectContaining({ id: 'a1' }),
          expect.objectContaining({ id: 'tool1' }),
          expect.objectContaining({ id: 'a2' }),
        ],
      }),
    ]);
  });

  it('keeps a turn user message before its error bubble even when the error item arrives first', () => {
    const groups = groupTranscriptItems(
      [
        { id: 'err-1', type: 'error', turnId: 'turn-1', message: 'model failed' },
        { id: 'u1', type: 'user_message', turnId: 'turn-1', text: '为什么失败' },
      ],
      [{ turnId: 'turn-1', userInput: { type: 'text', text: '为什么失败' }, status: 'failed' }],
    );

    expect(groups.map((group) => group.kind)).toEqual(['user', 'assistant']);
    expect(groups[0]).toMatchObject({ kind: 'user', item: { id: 'u1' } });
    expect(groups[1]).toMatchObject({
      kind: 'assistant',
      turnId: 'turn-1',
      items: [expect.objectContaining({ id: 'err-1' })],
    });
  });

  it('keeps context compaction items out of the transcript', () => {
    const groups = groupTranscriptItems([
      {
        id: 'compact-1',
        type: 'context_compaction',
        turnId: 'turn-1',
        status: 'completed',
        summary: {
          raw: '[Context compaction completed]\n当前进度：内部摘要不应显示在聊天气泡里。',
        },
      },
      { id: 'user-1', type: 'user_message', turnId: 'turn-2', text: '继续' },
    ]);

    expect(groups).toEqual([
      expect.objectContaining({ kind: 'user', item: expect.objectContaining({ id: 'user-1' }) }),
    ]);
  });

  it('replaces existing items by id instead of appending duplicates', () => {
    const current = [
      { id: 'item-1', type: 'agent_message', text: 'old' },
      { id: 'item-2', type: 'tool_call', toolName: 'read_file', status: 'in_progress' },
    ];
    const incoming = [
      { id: 'item-1', type: 'agent_message', text: 'new' },
      { id: 'item-3', type: 'agent_message', text: 'third' },
    ];

    expect(mergeThreadItems(current, incoming)).toEqual([
      { id: 'item-1', type: 'agent_message', text: 'new' },
      { id: 'item-2', type: 'tool_call', toolName: 'read_file', status: 'in_progress' },
      { id: 'item-3', type: 'agent_message', text: 'third' },
    ]);
  });

  it('deduplicates the same terminal error from SSE and a later snapshot', () => {
    const message = 'Gitee AI gateway error (422): invalid tool_calls';
    const merged = mergeThreadItems(
      [{ id: 'turn-error:thread:turn-1', type: 'error', turnId: 'turn-1', message }],
      [{ id: 'persisted-error-1', type: 'error', turnId: 'turn-1', message, status: 'failed' }],
    );

    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ id: 'persisted-error-1', message, status: 'failed' });
  });

  it('marks error item events as failures', () => {
    const event = describeEvent({ type: 'item.completed', item: { id: 'error-item', type: 'error', turnId: 'turn-1', message: 'timeout' } }, 'zh');
    expect(event?.tone).toBe('danger');
  });

  it('applies agent message deltas directly to the current transcript item', () => {
    expect(
      applyAgentMessageDelta(
        [
          {
            id: 'agent-1',
            type: 'agent_message',
            turnId: 'turn-1',
            text: '你',
          },
        ],
        {
          itemId: 'agent-1',
          threadId: 'thread-1',
          turnId: 'turn-1',
          delta: '好',
        },
      ),
    ).toEqual([
      {
        id: 'agent-1',
        type: 'agent_message',
        turnId: 'turn-1',
        text: '你好',
      },
    ]);
  });

  it('creates a temporary agent item when a delta arrives before item.started', () => {
    const current = applyAgentMessageDelta([], {
      itemId: 'agent-late',
      turnId: 'turn-1',
      delta: '流式片段',
    });
    expect(current).toHaveLength(1);
    expect(current[0]).toMatchObject({
      id: 'agent-late',
      type: 'agent_message',
      turnId: 'turn-1',
      status: 'in_progress',
      text: '流式片段',
    });

    const merged = mergeThreadItems(current, [{
      id: 'agent-late',
      type: 'agent_message',
      turnId: 'turn-1',
      status: 'in_progress',
      text: '',
    }]);
    expect(merged[0].text).toBe('流式片段');
  });

  it('renders an omitted cache report with a stable zero cache-hit value', () => {
    expect(describeEvent({
      type: 'turn.completed',
      usage: { inputTokens: 100, cachedInputTokens: 0, outputTokens: 20 },
    }, 'zh')).toMatchObject({ detail: 'Token：输入 100，缓存命中 0，输出 20。' });
  });

  it('keeps timestamped tool calls before the final assistant output', () => {
    const groups = groupTranscriptItems([
      { id: 'answer', type: 'agent_message', turnId: 'turn-1', text: '完成', timestamp: '2026-08-27T10:00:03.000Z' },
      { id: 'tool', type: 'tool_call', turnId: 'turn-1', toolName: 'list_files', status: 'completed', timestamp: '2026-08-27T10:00:01.000Z' },
      { id: 'user', type: 'user_message', turnId: 'turn-1', text: '检查', timestamp: '2026-08-27T10:00:00.000Z' },
    ]);
    expect(groups[0]).toMatchObject({ kind: 'user', item: { id: 'user' } });
    expect(groups[1]).toMatchObject({
      kind: 'assistant',
      items: [{ id: 'tool' }, { id: 'answer' }],
    });
  });

  it('keeps the original creation timestamp when a terminal lifecycle update arrives', () => {
    const merged = mergeThreadItems(
      [{ id: 'tool', type: 'tool_call', turnId: 'turn-1', status: 'in_progress', timestamp: '2026-08-27T10:00:01.000Z' }],
      [{ id: 'tool', type: 'tool_call', turnId: 'turn-1', status: 'completed', timestamp: '2026-08-27T10:00:04.000Z', completedAt: '2026-08-27T10:00:04.000Z' }],
    );
    expect(merged[0]).toMatchObject({
      status: 'completed',
      timestamp: '2026-08-27T10:00:01.000Z',
      completedAt: '2026-08-27T10:00:04.000Z',
    });
  });

  it('does not let a partial stale snapshot erase live item fields', () => {
    const merged = mergeThreadItems(
      [{
        id: 'agent-live',
        type: 'agent_message',
        turnId: 'turn-1',
        status: 'completed',
        text: '完整的流式回复',
        timestamp: '2026-08-27T10:00:01.000Z',
        completedAt: '2026-08-27T10:00:05.000Z',
      }],
      [{ id: 'agent-live', type: 'agent_message', status: 'in_progress', text: '完整的', timestamp: undefined, completedAt: null } as never],
    );

    expect(merged[0]).toMatchObject({
      turnId: 'turn-1',
      status: 'completed',
      text: '完整的流式回复',
      timestamp: '2026-08-27T10:00:01.000Z',
      completedAt: '2026-08-27T10:00:05.000Z',
    });
  });

  it('removes a transient transcript item by id', () => {
    expect(
      removeThreadItem(
        [
          { id: 'agent-1', type: 'agent_message', turnId: 'turn-1', text: '临时工具文本' },
          { id: 'agent-2', type: 'agent_message', turnId: 'turn-1', text: '最终回答' },
        ],
        'agent-1',
      ),
    ).toEqual([
      { id: 'agent-2', type: 'agent_message', turnId: 'turn-1', text: '最终回答' },
    ]);
  });

  it('never removes a persisted error item when a late discard event arrives', () => {
    const error = { id: 'error-1', type: 'error' as const, turnId: 'turn-1', message: 'model failed' };
    expect(removeThreadItem([error], error.id)).toEqual([error]);
  });

  it('does not let a late same-id lifecycle update overwrite an error item', () => {
    const error = { id: 'error-1', type: 'error' as const, turnId: 'turn-1', message: 'model failed' };
    expect(mergeThreadItems([error], [{ id: error.id, type: 'agent_message' as const, turnId: error.turnId, text: 'late output' } as never])).toEqual([error]);
  });

  it('turns raw lifecycle events into readable Chinese timeline entries', () => {
    expect(describeEvent({ type: 'turn.started', turnIndex: 0 }, 'zh')).toMatchObject({
      title: '第 1 轮开始',
      tone: 'running',
    });

    expect(
      describeEvent(
        {
          type: 'item.completed',
          item: {
            id: 'item-1',
            type: 'tool_call',
            toolName: 'shell_command',
            status: 'completed',
          },
        },
        'zh',
      ),
    ).toMatchObject({
      title: '工具调用：完成',
      detail: 'shell_command · completed',
      tone: 'success',
    });
  });

  it('does not create timeline noise for streaming agent text updates', () => {
    expect(
      describeEvent(
        {
          type: 'item.updated',
          item: {
            id: 'agent-1',
            type: 'agent_message',
            turnId: 'turn-1',
            text: '流式',
          },
        },
        'zh',
      ),
    ).toBeNull();
  });

  it('describes model retry events in the timeline', () => {
    expect(
      describeEvent(
        {
          type: 'model.retry',
          threadId: 'thread-1',
          turnId: 'turn-1',
          attempt: 1,
          maxAttempts: 3,
          delayMs: 1,
          status: 429,
        },
        'zh',
      ),
    ).toMatchObject({
      title: '模型重试',
      detail: expect.stringContaining('1/3'),
      tone: 'warning',
    });
  });

  it('describes rejected model protocol output distinctly', () => {
    expect(
      describeEvent(
        {
          type: 'model.output.rejected',
          turnId: 'turn-1',
          message: 'Model output leaked tool-call protocol text into assistant content',
        },
        'zh',
      ),
    ).toMatchObject({
      title: '模型输出格式错误',
      detail: 'Model output leaked tool-call protocol text into assistant content',
      tone: 'warning',
    });
  });

  it('describes recoverable stream errors without treating them as turn failure', () => {
    expect(
      describeEvent(
        {
          type: 'stream.error',
          threadId: 'thread-1',
          turnId: 'turn-1',
          recoverable: true,
          message: 'The operation was aborted due to timeout',
          error: {
            message: 'The operation was aborted due to timeout',
            info: { kind: 'ResponseStreamDisconnected' },
          },
        },
        'zh',
      ),
    ).toMatchObject({
      title: '流式响应中断',
      tone: 'warning',
    });
  });

  it('keeps user messages in the transcript instead of the event timeline', () => {
    expect(
      describeEvent(
        {
          type: 'item.completed',
          item: {
            id: 'user-1',
            type: 'user_message',
            turnId: 'turn-1',
            text: '现在几点',
          },
        },
        'zh',
      ),
    ).toBeNull();
  });

  it('uses stable render keys for event status updates', () => {
    expect(
      eventRenderKey({
        id: 25,
        key: 'item:turn-1:tool:current_time',
        kind: 'item.started',
        title: '工具调用：进行中',
        detail: 'current_time · in_progress',
        tone: 'running',
        timestamp: '2026-06-08T02:00:00.000Z',
      }),
    ).toBe(
      eventRenderKey({
        id: 26,
        key: 'item:turn-1:tool:current_time',
        kind: 'item.completed',
        title: '工具调用：完成',
        detail: 'current_time · completed',
        tone: 'success',
        timestamp: '2026-06-08T02:00:01.000Z',
      }),
    );
  });

  it('synthesizes missing user messages from persisted turns', () => {
    expect(
      withSyntheticUserMessages(
        [
          {
            turnId: 'turn-1',
            userInput: { type: 'text', text: '现在几点' },
          },
        ],
        [
          {
            id: 'item-1',
            type: 'agent_message',
            turnId: 'turn-1',
            text: '现在是上午 10 点。',
          },
        ],
      ),
    ).toEqual([
      {
        id: 'turn-1_user',
        type: 'user_message',
        turnId: 'turn-1',
        text: '现在几点',
      },
      {
        id: 'item-1',
        type: 'agent_message',
        turnId: 'turn-1',
        text: '现在是上午 10 点。',
      },
    ]);
  });

  it('produces distinct keys for two same-named tool calls in the same turn', () => {
    const toolCall1 = { id: 'tool-1', type: 'tool_call' as const, turnId: 'turn-1', toolName: 'read_file' };
    const toolCall2 = { id: 'tool-2', type: 'tool_call' as const, turnId: 'turn-1', toolName: 'read_file' };
    expect(itemKey(toolCall1)).not.toBe(itemKey(toolCall2));
  });

  it('produces distinct keys for two file_change items in the same turn', () => {
    const change1 = { id: 'change-1', type: 'file_change' as const, turnId: 'turn-1' };
    const change2 = { id: 'change-2', type: 'file_change' as const, turnId: 'turn-1' };
    expect(itemKey(change1)).not.toBe(itemKey(change2));
  });

  it('produces distinct keys for two error items in the same turn', () => {
    const error1 = { id: 'error-1', type: 'error' as const, turnId: 'turn-1', message: 'fail' };
    const error2 = { id: 'error-2', type: 'error' as const, turnId: 'turn-1', message: 'fail' };
    expect(itemKey(error1)).not.toBe(itemKey(error2));
  });

  it('produces the same key for the same item id across started/completed updates', () => {
    const started = { id: 'item-1', type: 'tool_call' as const, turnId: 'turn-1', toolName: 'test', status: 'in_progress' as const };
    const completed = { id: 'item-1', type: 'tool_call' as const, turnId: 'turn-1', toolName: 'test', status: 'completed' as const };
    expect(itemKey(started)).toBe(itemKey(completed));
    expect(eventKey(started)).toBe(eventKey(completed));
  });

  it('keys always start with item: for real items', () => {
    const item = { id: 'real-item', type: 'agent_message' as const, text: 'hello' };
    expect(itemKey(item)).toMatch(/^item:/);
    expect(eventKey(item)).toMatch(/^item:/);
  });
});

import { describe, expect, it } from 'vitest';
import { validateModelOutputItems } from './modelOutput.js';

describe('validateModelOutputItems', () => {
  it('rejects assistant text that leaks tool-call protocol syntax', () => {
    const result = validateModelOutputItems([
      {
        type: 'assistant_message_final',
        itemId: 'a1',
        turnId: 'turn-1',
        text: '我继续读取。\n\n<｜｜DSML｜｜tool_calls><｜｜DSML｜｜invoke name="read_file">',
      },
    ]);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.info.kind).toBe('BadRequest');
      expect(result.error.message).toContain('protocol');
    }
  });

  it('rejects human-readable tool transcript text', () => {
    const result = validateModelOutputItems([
      {
        type: 'assistant_message_final',
        itemId: 'a2',
        turnId: 'turn-2',
        text: 'search_content\nE:\\langchain\\Suanlizi\\apps\\api\\src\n完成\nread_file\npackages\\bot\\src\\routes\\botRoute.ts\n完成',
      },
    ]);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain('protocol');
    }
  });

  it('rejects bracketed Chinese tool-call transcript text', () => {
    const result = validateModelOutputItems([
      {
        type: 'assistant_message_final',
        itemId: 'a3',
        turnId: 'turn-3',
        text: '发送似乎未成功，让我再试一次：\n\n[调用 dingtalk_send_group_message] {"text":"冒个泡","groupName":"打完我去打DD·"}',
      },
    ]);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain('protocol');
    }
  });

  it('rejects Gitee flattened tool-call transcripts with name and arguments fields', () => {
    const result = validateModelOutputItems([
      {
        type: 'assistant_message_final',
        itemId: 'a-gitee',
        turnId: 'turn-gitee',
        text: [
          '我继续处理。',
          '',
          '[工具调用]',
          '名称: read_file',
          '参数: {"filePath":"README.md"}',
          '',
          '[工具结果]',
          '内容: ...',
        ].join('\n'),
      },
    ]);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain('protocol');
  });

  it('rejects redacted DingTalk tool history text when the model repeats it as assistant content', () => {
    const result = validateModelOutputItems([
      {
        type: 'assistant_message_final',
        itemId: 'a4',
        turnId: 'turn-4',
        text: [
          '好的，换人！',
          '',
          '[Tool dingtalk_forward_to_group completed]',
          'DingTalk group message tool result redacted. Do not reuse this prior tool call or reveal internal routing details.',
          '',
          '已在群里艾特了付守凡。',
        ].join('\n'),
      },
    ]);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain('protocol');
    }
  });

  it('requires tool results to match a prior tool call', () => {
    const result = validateModelOutputItems([
      {
        type: 'tool_result',
        callId: 'call-missing',
        toolName: 'read_file',
        output: 'orphan',
      },
    ]);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain('orphan');
  });

  it('accepts paired tool calls and tool results', () => {
    const result = validateModelOutputItems([
      {
        type: 'tool_call',
        callId: 'call-1',
        toolName: 'read_file',
        arguments: { filePath: 'README.md' },
      },
      {
        type: 'tool_result',
        callId: 'call-1',
        toolName: 'read_file',
        output: 'ok',
      },
    ]);

    expect(result.ok).toBe(true);
  });
});

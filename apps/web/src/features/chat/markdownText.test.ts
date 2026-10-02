import { describe, expect, it } from 'vitest';
import { normalizeMarkdownForDisplay } from './markdownText.js';

describe('normalizeMarkdownForDisplay', () => {
  it('adds block spacing around markdown tables emitted next to paragraphs', () => {
    const normalized = normalizeMarkdownForDisplay([
      '文档缺失:',
      '| 知识类型 | 时效特征 | 当前文档缺失 |',
      '|---|---|---|',
      '| **MEL/CDL** | 经常更新 | 未说明版本 |',
      '**建议配置:** 增加版本字段。',
    ].join('\n'));

    expect(normalized).toContain('文档缺失:\n\n| 知识类型 | 时效特征 | 当前文档缺失 |');
    expect(normalized).toContain('| **MEL/CDL** | 经常更新 | 未说明版本 |\n\n**建议配置:** 增加版本字段。');
  });

  it('keeps fenced code blocks byte-for-byte unchanged', () => {
    const code = [
      '说明:',
      '```md',
      '| not | a rendered table |',
      '|---|---|',
      '```',
      '结论',
    ].join('\n');

    expect(normalizeMarkdownForDisplay(code)).toBe(code);
  });

  it('hides provider think tags in normal message text but preserves code blocks', () => {
    expect(normalizeMarkdownForDisplay('<think>内部思考</think>最终答案')).toBe('最终答案');
    const code = '```xml\n<think>keep this example</think>\n```';
    expect(normalizeMarkdownForDisplay(code)).toBe(code);
  });
});

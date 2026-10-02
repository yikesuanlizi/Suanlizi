import { describe, expect, it } from 'vitest';
import { titleFromInput, shouldRetitleThread } from './threadTitle.js';

describe('thread title helpers', () => {
  it('retitles generated empty conversation titles', () => {
    expect(shouldRetitleThread('未命名对话')).toBe(true);
    expect(shouldRetitleThread('Untitled chat')).toBe(true);
    expect(shouldRetitleThread('Untitled')).toBe(true);
    expect(shouldRetitleThread('未命名工作流项目')).toBe(true);
    expect(shouldRetitleThread('Untitled workflow project')).toBe(true);
    expect(shouldRetitleThread('Suanlizi')).toBe(true);
    expect(shouldRetitleThread('用户自己改过的标题')).toBe(false);
  });

  it('uses the first user message as a compact title', () => {
    expect(titleFromInput('  第一条消息\n需要自动成为标题  ')).toBe('第一条消息 需要自动成为标题');
    expect(titleFromInput('')).toBe('');
    expect(titleFromInput('a'.repeat(80))).toHaveLength(60);
  });

  it('uses a clean title for skill installation commands', () => {
    expect(titleFromInput('/skills add https://github.com/anthropics/skills/tree/main/s')).toBe('安装 Skills');
    expect(titleFromInput('/skills install https://github.com/acme/repo/tree/main/foo')).toBe('安装 Skills');
  });
});

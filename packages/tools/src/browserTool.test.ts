import { describe, expect, it } from 'vitest';
import type { ToolDefinition } from './registry.js';

const browserToolSource = './browserTool.ts';

describe('browser tools', () => {
  it('registers the browser working-memory tool', async () => {
    const browserTools = (await import(browserToolSource)).browserTools as ToolDefinition[];
    expect(browserTools.map((tool) => tool.name)).toEqual([
      'browser_observe',
      'browser_pages',
      'browser_navigate',
      'browser_act',
      'browser_download',
      'browser_screenshot',
      'browser_memory',
    ]);

    const memory = browserTools.find((tool) => tool.name === 'browser_memory');
    expect(memory).toBeDefined();

    const pages = browserTools.find((tool) => tool.name === 'browser_pages');
    const navigate = browserTools.find((tool) => tool.name === 'browser_navigate');
    expect(pages?.description).toContain('不接受 URL');
    expect(pages?.description).toContain('不会打开或导航网页');
    expect(navigate?.description).toContain('打开 URL 的唯一浏览器工具');

    const result = await memory!.execute({}, {
      workspaceRoot: 'D:\\suanlizi',
      threadId: 'browser-tool-empty-memory',
      turnId: 'turn-1',
      approved: false,
    });

    expect(result).toMatchObject({
      output: '当前线程没有已保存的浏览页面摘要。',
      data: { pages: [] },
      status: 'completed',
    });

    const act = browserTools.find((tool) => tool.name === 'browser_act');
    const unsafeResult = await act!.execute({ kind: 'type', value: 'unscoped input' }, {
      workspaceRoot: 'D:\\suanlizi',
      threadId: 'browser-tool-empty-memory',
      turnId: 'turn-2',
      approved: true,
    });
    expect(unsafeResult).toMatchObject({
      error: { message: 'type 需要来自最近一次 browser_observe 的 targetRef' },
      status: 'failed',
    });

    const download = browserTools.find((tool) => tool.name === 'browser_download');
    const invalidDownload = await download!.execute({ url: 'file:///C:/secret.txt' }, {
      workspaceRoot: 'D:\\suanlizi',
      threadId: 'browser-tool-empty-memory',
      turnId: 'turn-3',
      approved: true,
    });
    expect(invalidDownload).toMatchObject({
      error: { message: 'browser_download 需要有效的 http/https URL' },
      status: 'failed',
    });
  });
});

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { TaskCenterDrawer } from './TaskCenterDrawer.js';

describe('TaskCenterDrawer', () => {
  it('renders a narrow non-modal run observer without a backdrop', () => {
    const html = renderToStaticMarkup(
      <TaskCenterDrawer open locale="zh" onClose={vi.fn()} onJumpToThread={vi.fn()} />,
    );

    expect(html).toContain('role="complementary"');
    expect(html).not.toContain('aria-modal');
    expect(html).not.toContain('runMonitorBackdrop');
    expect(html).toContain('运行观察');
    expect(html).toContain('进行中 0 个 / 共 0 个');
  });
});

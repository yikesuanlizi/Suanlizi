import React from 'react';
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { SystemMonitorStatus } from '@suanlizi/protocol';
import { SystemMonitorWidget } from './SystemMonitorWidget.js';

const status: SystemMonitorStatus = {
  enabled: true,
  level: 'light',
  recommendation: 'Host under light pressure.',
  snapshot: {
    timestamp: '2026-08-26T00:00:00.000Z',
    cpuUsage: 42.4,
    cpuCount: 8,
    memTotal: 1000,
    memUsed: 520,
    memUsage: 52,
    disks: [{ mount: 'C:', size: 1000, used: 700, available: 300, usage: 70 }],
  },
};

describe('SystemMonitorWidget', () => {
  it('does not render when sampling is disabled', () => {
    expect(renderToStaticMarkup(<SystemMonitorWidget status={null} zh />)).toBe('');
    expect(renderToStaticMarkup(<SystemMonitorWidget status={{ ...status, enabled: false }} zh />)).toBe('');
  });

  it('renders compact metrics and a help affordance when enabled', () => {
    const html = renderToStaticMarkup(<SystemMonitorWidget status={status} zh />);
    expect(html).toContain('CPU 42%');
    expect(html).toContain('RAM 52%');
    expect(html).toContain('DISK 30%');
    expect(html).toContain('systemMonitorHelp');
  });

  it('labels the first empty snapshot as sampling', () => {
    const html = renderToStaticMarkup(<SystemMonitorWidget status={{ ...status, snapshot: { ...status.snapshot, cpuCount: 0, memTotal: 0, disks: [] } }} zh />);
    expect(html).toContain('采样中');
  });
});

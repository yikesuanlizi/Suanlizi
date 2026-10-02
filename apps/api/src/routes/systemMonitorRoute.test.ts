import { describe, expect, it, vi } from 'vitest';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { SystemMonitorStatus } from '@suanlizi/protocol';
import { handleSystemMonitorRoute } from './systemMonitorRoute.js';

function request(method: string, url: string): IncomingMessage {
  return Object.assign(Readable.from([]), { method, url }) as IncomingMessage;
}

function response(): ServerResponse & { status?: number; body?: unknown } {
  const output = {
    writeHead(status: number) { output.status = status; return output; },
    end(raw: string) { output.body = raw ? JSON.parse(raw) : undefined; },
  } as unknown as ServerResponse & { status?: number; body?: unknown };
  return output;
}

const enabledStatus: SystemMonitorStatus = {
  enabled: true,
  level: 'none',
  recommendation: 'Host load is normal.',
  snapshot: {
    timestamp: '2026-08-26T00:00:00.000Z',
    cpuUsage: 12,
    cpuCount: 8,
    memTotal: 100,
    memUsed: 40,
    memUsage: 40,
    disks: [],
  },
};

describe('system monitor route', () => {
  it('returns the current status for the monitor panel', async () => {
    const res = response();
    const getStatus = vi.fn(async () => enabledStatus);
    await expect(handleSystemMonitorRoute({
      req: request('GET', '/api/system-monitor/status'),
      res,
      pathname: '/api/system-monitor/status',
      getStatus,
    })).resolves.toBe(true);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: enabledStatus });
    expect(getStatus).toHaveBeenCalledOnce();
  });

  it('ignores other methods and paths', async () => {
    const getStatus = vi.fn(async () => enabledStatus);
    const res = response();
    await expect(handleSystemMonitorRoute({
      req: request('POST', '/api/system-monitor/status'),
      res,
      pathname: '/api/system-monitor/status',
      getStatus,
    })).resolves.toBe(false);
    expect(getStatus).not.toHaveBeenCalled();
  });
});

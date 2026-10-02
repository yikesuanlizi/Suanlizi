import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, expect, it } from 'vitest';
import { handleTerminalRoute } from './terminal.js';

function request(body: unknown): IncomingMessage {
  const stream = Readable.from([Buffer.from(JSON.stringify(body), 'utf8')]);
  return Object.assign(stream, { method: 'POST', url: '/api/terminal/session', headers: {} }) as IncomingMessage;
}

function response(): ServerResponse & { status?: number; body?: unknown } {
  const output = {
    writeHead(status: number) { output.status = status; return output; },
    end(raw: string) { output.body = raw ? JSON.parse(raw) : undefined; },
  } as unknown as ServerResponse & { status?: number; body?: unknown };
  return output;
}

describe('terminal session routes', () => {
  it('requires a thread scope before allocating a terminal process', async () => {
    const res = response();
    const handled = await handleTerminalRoute({
      req: request({ root: process.cwd(), cols: 120, rows: 32 }),
      res,
      url: new URL('http://localhost/api/terminal/session'),
    });
    expect(handled).toBe(true);
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: 'Thread id is required' });
  });
});

import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, expect, it } from 'vitest';
import { resolveCorsOptions } from '../shared/cors.js';
import { handleRequestGate } from './requestGate.js';

function request(method: string, origin?: string): IncomingMessage {
  return Object.assign(Readable.from([]), {
    method,
    headers: origin ? { origin } : {},
  }) as IncomingMessage;
}

function response(): ServerResponse & { status?: number; body?: unknown; headers: Record<string, string> } {
  const output = {
    headers: {} as Record<string, string>,
    setHeader(name: string, value: string) {
      output.headers[name] = value;
      return output;
    },
    writeHead(status: number, headers?: Record<string, string>) {
      output.status = status;
      Object.assign(output.headers, headers ?? {});
      return output;
    },
    end(raw?: string) {
      output.body = raw ? JSON.parse(raw) : undefined;
      return output;
    },
  } as unknown as ServerResponse & { status?: number; body?: unknown; headers: Record<string, string> };
  return output;
}

describe('request gate CORS boundary', () => {
  it('rejects an untrusted browser origin before a state-changing route can run', () => {
    const res = response();
    const result = handleRequestGate({
      req: request('POST', 'https://evil.example'),
      res,
      corsOptions: resolveCorsOptions({}),
    });

    expect(result.handled).toBe(true);
    expect(res.status).toBe(403);
    expect(res.headers).not.toHaveProperty('Access-Control-Allow-Origin');
  });

  it('allows Suanlizi local UI preflight requests', () => {
    const res = response();
    const result = handleRequestGate({
      req: request('OPTIONS', 'http://localhost:5178'),
      res,
      corsOptions: resolveCorsOptions({}),
    });

    expect(result.handled).toBe(true);
    expect(res.status).toBe(204);
    expect(res.headers).toMatchObject({
      'Access-Control-Allow-Origin': 'http://localhost:5178',
    });
  });
});

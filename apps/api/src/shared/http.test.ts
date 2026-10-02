import { Readable } from 'node:stream';
import type { IncomingMessage } from 'node:http';
import { describe, expect, it } from 'vitest';
import { RequestBodyTooLargeError, readJson } from './http.js';

function jsonRequest(body: string, headers: Record<string, string> = {}): IncomingMessage {
  return Object.assign(Readable.from([Buffer.from(body)]), { headers }) as IncomingMessage;
}

describe('readJson', () => {
  it('parses JSON within the default request limit', async () => {
    await expect(readJson<{ ok: boolean }>(jsonRequest('{"ok":true}'))).resolves.toEqual({ ok: true });
  });

  it('rejects an oversized declared body before buffering it', async () => {
    const request = jsonRequest('{"ignored":true}', { 'content-length': '1048577' });
    await expect(readJson(request)).rejects.toBeInstanceOf(RequestBodyTooLargeError);
  });

  it('rejects an oversized streamed body when Content-Length is absent', async () => {
    const request = jsonRequest(JSON.stringify({ payload: 'x'.repeat(128) }));
    await expect(readJson(request, { maxBytes: 64 })).rejects.toBeInstanceOf(RequestBodyTooLargeError);
  });
});

import type { IncomingMessage, ServerResponse } from 'node:http';

export const DEFAULT_JSON_BODY_LIMIT_BYTES = 1 * 1024 * 1024;

export class RequestBodyTooLargeError extends Error {
  readonly statusCode = 413;
  readonly code = 'REQUEST_BODY_TOO_LARGE';

  constructor(maxBytes: number) {
    super(`Request body exceeds the ${maxBytes} byte limit`);
    this.name = 'RequestBodyTooLargeError';
  }
}

export async function readJson<T>(
  req: IncomingMessage,
  options: { maxBytes?: number } = {},
): Promise<T> {
  const maxBytes = options.maxBytes ?? DEFAULT_JSON_BODY_LIMIT_BYTES;
  const contentLength = Number(req.headers?.['content-length']);
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    req.resume();
    throw new RequestBodyTooLargeError(maxBytes);
  }
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.byteLength;
    if (bytes > maxBytes) {
      req.resume();
      throw new RequestBodyTooLargeError(maxBytes);
    }
    chunks.push(buffer);
  }
  const raw = Buffer.concat(chunks).toString('utf-8');
  return raw ? (JSON.parse(raw) as T) : ({} as T);
}

export function sendJson(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
  });
  res.end(JSON.stringify(data));
}

export function sendError(res: ServerResponse, status: number, message: string): void {
  const normalizedStatus = status === 400 && message.startsWith('Request body exceeds the ')
    ? 413
    : status;
  sendJson(res, normalizedStatus, { error: message });
}

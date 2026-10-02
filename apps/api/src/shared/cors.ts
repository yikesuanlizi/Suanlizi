import type { IncomingMessage, ServerResponse } from 'node:http';

export interface CorsOptions {
  authEnabled: boolean;
  origins: string[];
}

const DEFAULT_LOCAL_ORIGINS = [
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'http://localhost:5178',
  'http://127.0.0.1:5178',
  'app://bundle',
];

const BASE_ALLOW_HEADERS = [
  'Content-Type',
  'X-CSRF-Token',
];

export function resolveCorsOptions(
  env: Record<string, string | undefined> = process.env,
  authEnabled = false,
): CorsOptions {
  const configuredOrigins = env.SUANLIZI_CORS_ORIGINS;
  const origins = configuredOrigins === undefined
    ? DEFAULT_LOCAL_ORIGINS
    : configuredOrigins.split(',').map((origin) => origin.trim()).filter(Boolean);
  return { authEnabled, origins };
}

export function corsHeadersForOrigin(origin: string | undefined, options: CorsOptions): Record<string, string> {
  const headers: Record<string, string> = {
    'Access-Control-Allow-Headers': [
      ...BASE_ALLOW_HEADERS,
      ...(options.authEnabled ? ['Authorization'] : []),
    ].join(', '),
    'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
    Vary: 'Origin',
  };
  if (origin && options.origins.includes(origin)) {
    headers['Access-Control-Allow-Origin'] = origin;
  }
  return headers;
}

export function applyCorsHeaders(req: IncomingMessage, res: ServerResponse, options: CorsOptions): boolean {
  const origin = headerValue(req.headers.origin);
  const headers = corsHeadersForOrigin(origin, options);
  for (const [key, value] of Object.entries(headers)) {
    res.setHeader(key, value);
  }
  return !origin || options.origins.includes(origin);
}

function headerValue(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0]?.trim() ?? '' : value?.trim() ?? '';
}

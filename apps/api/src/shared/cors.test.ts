import { describe, expect, it } from 'vitest';
import { corsHeadersForOrigin, resolveCorsOptions } from './cors.js';

describe('CORS', () => {
  it('allows configured origins and exposes authorization headers', () => {
    const options = resolveCorsOptions({
      SUANLIZI_CORS_ORIGINS: 'http://localhost:5177,https://suanlizi.example.com',
    }, true);

    expect(corsHeadersForOrigin('https://suanlizi.example.com', options)).toMatchObject({
      'Access-Control-Allow-Origin': 'https://suanlizi.example.com',
      'Access-Control-Allow-Headers': expect.stringContaining('Authorization'),
      'Access-Control-Allow-Methods': expect.stringContaining('PATCH'),
      Vary: 'Origin',
    });
  });

  it('does not use wildcard origins when auth is enabled', () => {
    const options = resolveCorsOptions({}, true);
    expect(corsHeadersForOrigin('http://evil.example', options)).not.toHaveProperty('Access-Control-Allow-Origin');
  });

  it('allows only bundled and local Suanlizi UI origins by default', () => {
    const options = resolveCorsOptions({}, false);
    expect(corsHeadersForOrigin('http://localhost:5178', options)).toMatchObject({
      'Access-Control-Allow-Origin': 'http://localhost:5178',
    });
    expect(corsHeadersForOrigin('app://bundle', options)).toMatchObject({
      'Access-Control-Allow-Origin': 'app://bundle',
    });
    expect(corsHeadersForOrigin('http://anything.local', options)).not.toHaveProperty('Access-Control-Allow-Origin');
  });

  it('lets an explicit environment value override default local origins', () => {
    const options = resolveCorsOptions({ SUANLIZI_CORS_ORIGINS: 'https://suanlizi.example.com' });
    expect(corsHeadersForOrigin('http://localhost:5178', options)).not.toHaveProperty('Access-Control-Allow-Origin');
    expect(corsHeadersForOrigin('https://suanlizi.example.com', options)).toMatchObject({
      'Access-Control-Allow-Origin': 'https://suanlizi.example.com',
    });
  });
});

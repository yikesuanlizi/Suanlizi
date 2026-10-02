import { describe, expect, it } from 'vitest';
import type { IncomingHttpHeaders } from 'node:http';
import { safeTenantId, tenantEventKey, parseTenantContext, scopedSettingKey } from './tenant.js';

describe('TenantContext', () => {
  it('defaults to the local default tenant when the header is absent', () => {
    expect(parseTenantContext({} as IncomingHttpHeaders)).toEqual({ tenantId: 'default' });
  });

  // 产品定位（AGENTS §1）：Suanlizi 只面向单用户工作区，任何入参都固定为 default；
  // 历史数据里的 tenant_id 仅作 SQLite 兼容字段。路径类非法值仍由 safeTenantId 拒绝。
  // — Chinese: single-local-user product rule pins the tenant; path-like ids stay invalid.
  it('pins every request to the default tenant and rejects path-like tenant ids', () => {
    expect(parseTenantContext({ 'x-suanlizi-tenant-id': 'team_A-1' } as unknown as IncomingHttpHeaders)).toEqual({ tenantId: 'default' });
    expect(parseTenantContext({ 'x-suanlizi-tenant-id': '../other' } as unknown as IncomingHttpHeaders)).toEqual({ tenantId: 'default' });
    expect(safeTenantId('team_A-1')).toBe('team_A-1');
    expect(() => safeTenantId('../other')).toThrow(/Invalid tenant id/);
    expect(() => safeTenantId('team/a')).toThrow(/Invalid tenant id/);
    expect(() => safeTenantId('')).not.toThrow();
    expect(safeTenantId('')).toBe('default');
  });

  it('builds tenant-scoped setting keys and event keys without exposing other tenants', () => {
    expect(scopedSettingKey('tenantA', 'runConfig.default')).toBe('tenant:tenantA:runConfig.default');
    expect(scopedSettingKey('default', 'storage.schemaVersion')).toBe('storage.schemaVersion');
    expect(scopedSettingKey('tenantA', 'auth.tokens.v1')).toBe('auth.tokens.v1');
    expect(tenantEventKey('tenantA', 'thread-1')).toBe('tenantA:thread-1');
  });
});

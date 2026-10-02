// 服务端短 id 生成（从 server.ts 拆出）：turn / 条目 id 前缀统一来源。
// — Chinese: server-side short id helper extracted from server.ts.

/** 服务端生成的短 id（turn / 条目 id 前缀）。 */
export function generateServerId(): string {
  return `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

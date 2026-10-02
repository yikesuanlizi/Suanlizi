import type { IncomingMessage, ServerResponse } from 'node:http';
import type { StorageOptions } from '@suanlizi/storage';
import { publicRunConfig, type AgentRunConfig } from '../config/config.js';
import { sendJson } from '../shared/http.js';

// 处理 /api/status — 返回服务器状态与运行配置摘要（用于健康检查与启动后状态）
// — Chinese: handle /api/status — return server status + run config summary
export async function handleStatusRoute(options: {
  req: IncomingMessage;
  res: ServerResponse;
  pathname: string;
  storageOptions: StorageOptions;
  getDefaultRunConfig(): Promise<AgentRunConfig>;
}): Promise<boolean> {
  if (options.req.method !== 'GET' || options.pathname !== '/api/status') return false;
  sendJson(options.res, 200, {
    ok: true,
    defaultConfig: publicRunConfig(await options.getDefaultRunConfig()),
    initialized: true,
    storageBackend: options.storageOptions.backend,
  });
  return true;
}

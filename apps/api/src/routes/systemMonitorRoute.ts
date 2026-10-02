import type { IncomingMessage, ServerResponse } from 'node:http';
import type { SystemMonitorStatus } from '@suanlizi/protocol';
import { sendJson } from '../shared/http.js';

/** 提供监控面板读取当前系统采样状态的只读接口。 */
export async function handleSystemMonitorRoute(options: {
  req: IncomingMessage;
  res: ServerResponse;
  pathname: string;
  getStatus(): Promise<SystemMonitorStatus>;
}): Promise<boolean> {
  if (options.req.method !== 'GET' || options.pathname !== '/api/system-monitor/status') return false;
  const status = await options.getStatus();
  sendJson(options.res, 200, { status });
  return true;
}

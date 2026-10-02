import * as path from 'node:path';

// Suanlizi 运行数据放在应用自身目录下的 app-data；禁止写入项目源码区。
// Chinese: resolve application-owned portable data next to the installed app.
export function resolveAppDataRoot(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.SUANLIZI_DATA_DIR?.trim();
  if (configured) return path.resolve(configured);
  const portable = env.SUANLIZI_PORTABLE_DATA_DIR?.trim();
  if (portable) return path.resolve(portable);
  return path.resolve(process.cwd(), 'app-data');
}

export function resolveAppLogDir(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.SUANLIZI_LOG_DIR?.trim();
  return configured ? path.resolve(configured) : path.join(resolveAppDataRoot(env), 'logs');
}

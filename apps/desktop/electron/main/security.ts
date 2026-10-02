// 桌面安全配置（迁移计划 §3.3 / Electron 安全清单）：
// - BrowserWindow：contextIsolation + sandbox + 无 Node 集成
// - 权限请求默认拒绝（Phase 0 无白名单）
// - window.open / 外部协议由 Main 统一处理
// — English: desktop security config (§3.3 / Electron security checklist):
//   contextIsolation + sandbox + no Node integration; permissions denied by
//   default; window.open / external protocols handled in Main.
import { app, session, type WebContents } from 'electron';

export function applySecurityDefaults(): void {
  // 权限请求：默认拒绝（Phase 0 不授予任何权限；后续按能力白名单逐项放行）。
  // — English: permission requests are denied by default (no grants in Phase 0;
  //   later, a capability whitelist grants them one by one).
  session.defaultSession.setPermissionRequestHandler(
    (_webContents: WebContents, _permission: string, callback: (granted: boolean) => void) => {
      callback(false);
    },
  );

  // 拒绝第三方访问系统能力（Phase 0）。
  // — English: deny third-party access to system capabilities (Phase 0).
  session.defaultSession.setPermissionCheckHandler(() => false);

  // 单实例：第二个实例聚焦已有窗口并退出（Phase 1 完善窗口状态）。
  // 集成测试/多实例场景用 SUANLIZI_DISABLE_SINGLE_INSTANCE=1 绕过。
  // — English: single-instance lock — a second instance focuses the existing
  //   window. SUANLIZI_DISABLE_SINGLE_INSTANCE=1 bypasses it (integration tests /
  //   multiple instances).
  if (process.env.SUANLIZI_DISABLE_SINGLE_INSTANCE !== '1' && !app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }
}

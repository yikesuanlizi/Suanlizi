// @suanlizi/browser-runtime 统一入口
// — English: @suanlizi/browser-runtime entry
export * from './port.js';
export * from './policy.js';
export * from './fakeRuntime.js';
export * from './taskMachine.js';
export * from './trace.js';
export * from './progress.js';
export * from './recovery.js';
export * from './download.js';
export * from './metrics.js';
export * from './reconcile.js';
export * from './sessionState.js';
export * from './pageGraph.js';
export * from './capabilities.js';
export * from './contextSlim.js';
export * from './checkpointStore.js';
export * from './urlSafe.js';
export * from './playwrightRuntime.js';
export * from './orchestrator.js';
export * from './golden/goldenTypes.js';
export * from './golden/goldenRunner.js';
export * from './golden/goldenOrchestrator.js';
export * from './golden/tasks.js';
export * from './ipc/ipcTypes.js';
export * from './ipc/ipcSchemas.js';
export * from './ipc/codec.js';
export * from './sidecar/sidecar.js';
export * from './sidecar/sidecarClient.js';
export * from './sidecar/sidecarProcessHost.js';
export * from './sidecar/tcpTransport.js';
// 注意：sidecarEntry / runtimeHostEntry 是进程入口（顶层代码含 stdin 循环），
// 绝不从 index 导出——import 即执行会抢占宿主进程 stdin（Electron Main/测试）。
// — English: sidecarEntry/runtimeHostEntry are process entries whose top-level
//   code owns stdin — never re-export them from the index (importing the index
//   must not start their loops).

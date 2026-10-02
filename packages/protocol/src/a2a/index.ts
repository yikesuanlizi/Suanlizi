// A2A 适配层统一出口：导出 TaskStore、AgentExecutor、AgentCard 构建器
// 英文说明：A2A adapter layer entry — exports TaskStore, AgentExecutor, AgentCard builder

export { SuanliziTaskStore } from './suanliziTaskStore.js';
export type { TaskStoreBackend } from './suanliziTaskStore.js';
export { SuanliziAgentExecutor } from './suanliziAgentExecutor.js';
export type { AgentRuntimePort, SuanliziAgentExecutorOptions } from './suanliziAgentExecutor.js';
export { buildAgentCard } from './agentCardBuilder.js';
export type { SuanliziAgentCardConfig } from './agentCardBuilder.js';

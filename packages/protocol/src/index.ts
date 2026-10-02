// 协议层统一入口：聚合 types、schemas、runConfig、runControl、runTrace 和 a2a 模块
// 英文说明：Central entry re-exporting types + schemas + runConfig + runControl + runTrace + a2a
export * from './types.js';
export * from './schemas.js';
export * from './runConfig.js';
export * from './runControl.js';
export * from './threadInteraction.js';
export * from './runTrace.js';
export * from './runTraceSchemas.js';
export * from './fileKnowledge.js';
export * from './fileKnowledgeSchemas.js';
export * from './modelCapabilities.js';
export * from './modelContextReferences.js';
export * from './accessPolicy.js';
export * from './accessPolicySchemas.js';
export * from './opsTask.js';
export * from './task.js';
export type {
  TaskListFilter,
  TaskStorePort,
  WorkflowRunListFilter,
} from './taskStoreContract.js';
export * from './sshProfile.js';
export * from './browser/index.js';
export * from './a2a/index.js';
export * from './errorMessages.js';

// 协议版本号：用于跨端兼容性与版本协商；英文说明：Protocol version for cross-runtime compatibility
export const PROTOCOL_VERSION = '0.1.0';
export * from './providerFavicon.js';

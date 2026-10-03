export { ToolRegistry } from './registry.js';
export type {
  ToolDefinition,
  ToolContext,
  ToolResult,
  ToolParamSchema,
  ToolRegistrySchemaFilter,
  ToolSearchMatch,
  ToolSearchOptions,
} from './registry.js';
export {
  BUILTIN_TOOLS,
  currentTimeTool,
  readDocumentTool,
  readFileTool,
  writeFileTool,
  shellCommandTool,
  searchContentTool,
  webSearchTool,
  webFetchTool,
  applyPatchTool,
  getSystemStatusTool,
  requestUserDecisionTool,
} from './builtin.js';
export { artifactRoot } from './fileKnowledge.js';
export {
  DOCUMENT_EXTRACTOR_VERSION,
  extractDocumentText,
  extractorForDocumentPath,
} from './documentExtractors.js';
export type { ExtractedDocumentText } from './documentExtractors.js';
export {
  artifactRecordForResult,
  assessArtifactFreshness,
  documentArtifactPathForSource,
  findArtifactByPath,
  findArtifactBySource,
  loadDocumentArtifactLedger,
  registerExternalDocumentArtifactsFromText,
  saveDocumentArtifactRecord,
  updateArtifactLastUsed,
} from './documentArtifacts.js';
export type { DocumentArtifactLedger } from './documentArtifacts.js';
export {
  FirecrawlWebProvider,
  NativeFetchWebProvider,
  WebProviderRouter,
  extractReadableText,
} from './web/provider.js';
export type {
  FirecrawlProviderOptions,
  WebFindInPageRequest,
  WebFindResult,
  WebOpenPageRequest,
  WebPageResult,
  WebProvider,
  WebProviderCapabilities,
  WebProviderId,
  WebProviderRouterOptions,
  WebSearchRequest,
  WebSearchResult,
} from './web/provider.js';
export {
  resolveToolPath,
  resolveToolPathAccess,
  toolResultFromAccessDecision,
} from './accessGuard.js';

export const TOOLS_VERSION = '0.1.0';

export {
  terminateAllProcessTrees,
  terminateProcessTree,
} from './processTree.js';

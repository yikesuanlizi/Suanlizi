import type { ThreadId, TurnId, ThreadItem } from '@suanlizi/protocol';

export interface AgentContext {
  cognition: CognitionLayer;
  world: WorldLayer;
  memory?: MemoryLayer;
  updatedAt: number;
}

export interface CognitionLayer {
  task: TaskCognition;
}

export interface TaskCognition {
  goal: string;
  constraints: string[];
  assumptions: string[];
  knownFacts: string[];
  unknowns: string[];
  risks: RiskAssessment[];
  confidence: number;
  verificationCriteria: string[];
}

export interface RiskAssessment {
  description: string;
  severity: 'low' | 'medium' | 'high';
  mitigation?: string;
}

export interface WorldLayer {
  environment: EnvironmentContext;
  project?: ProjectContext;
}

export interface ProjectContext {
  architecture?: string;
  architectureHash?: string;
  techStack?: string[];
  framework?: string;
  language?: string;
  modules?: Array<{ name: string; path: string; purpose?: string }>;
  entryPoints?: string[];
  changedFiles?: string[];
  changeVersion?: number;
  riskyAreas?: Array<{ area: string; reason: string; severity: 'low' | 'medium' | 'high' }>;
  lastInjectedTurn?: number;
  lastScannedAt?: number;
  fullInjectedOnce?: boolean;
}

export interface EnvironmentContext {
  cwd: string;
  os: string;
  shell: string;
  gitBranch?: string;
  gitDirty?: boolean;
  hasBuildFiles?: string[];
}

export interface MemoryLayer {
  retrievedExperiences: ExperienceRef[];
}

export interface ExperienceRef {
  id: string;
  type: 'failure_pattern' | 'successful_workflow' | 'gotcha' | 'environment_fact';
  summary: string;
  confidence: number;
}

export type ContextPhase = 'before_turn' | 'after_tool' | 'after_turn';

export interface ContextPatch {
  world?: Partial<WorldLayer>;
  cognition?: Partial<TaskCognition>;
  memory?: Partial<MemoryLayer>;
}

export interface ProviderOutput {
  chunks: ContextChunk[];
  contextPatch?: ContextPatch;
}

export type ContextProviderResult = ContextChunk[] | ProviderOutput;

export interface ContextProvider {
  readonly name: string;
  readonly priority: number;
  readonly maxTokens: number;
  readonly phase: ContextPhase;

  provide(
    ctx: ProviderContext,
    signal?: AbortSignal
  ): Promise<ContextProviderResult>;
}

export interface ContextChunk {
  id: string;
  source: string;
  priority: number;
  tokens: number;
  content: string;
  metadata?: Record<string, unknown>;
}

export interface ProviderContext {
  threadId: ThreadId;
  turnId: TurnId;
  userInput: string;
  agentContext: Readonly<AgentContext>;
  items: readonly ThreadItem[];
  contextBudget: number;
}

export interface ContextEngineConfig {
  totalBudget: number;
  providers: ContextProvider[];
}

export interface AssembledContext {
  chunks: ContextChunk[];
  updatedAgentContext: AgentContext;
  usedTokens: number;
  remainingTokens: number;
}

export function createInitialAgentContext(environment: EnvironmentContext): AgentContext {
  return {
    cognition: {
      task: {
        goal: '',
        constraints: [],
        assumptions: [],
        knownFacts: [],
        unknowns: [],
        risks: [],
        confidence: 0,
        verificationCriteria: [],
      },
    },
    world: {
      environment,
      project: undefined,
    },
    memory: undefined,
    updatedAt: Date.now(),
  };
}

export function mergeCognitionUpdate(
  current: TaskCognition,
  update: Partial<TaskCognition>
): TaskCognition {
  return {
    goal: update.goal ?? current.goal,
    constraints: update.constraints ?? current.constraints,
    assumptions: update.assumptions ?? current.assumptions,
    knownFacts: update.knownFacts ?? current.knownFacts,
    unknowns: update.unknowns ?? current.unknowns,
    risks: update.risks ?? current.risks,
    confidence: update.confidence ?? current.confidence,
    verificationCriteria: update.verificationCriteria ?? current.verificationCriteria,
  };
}

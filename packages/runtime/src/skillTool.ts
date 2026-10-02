import type { ToolDefinition, ToolResult } from '@suanlizi/tools';
import type { LoadedSkill } from '@suanlizi/extensions';
import { SkillExecutor } from './skillExecutor.js';

export const USE_SKILL_TOOL_NAME = 'use_skill';

export interface UseSkillToolOptions {
  getSkills: () => LoadedSkill[];
  executor: SkillExecutor;
  getWorkspaceRoot: () => string;
}

export function createUseSkillTool(options: UseSkillToolOptions): ToolDefinition {
  return {
    name: USE_SKILL_TOOL_NAME,
    description: [
      'Invoke an executable skill by name with parameters.',
      'Skills are pre-built mini-workflows that encapsulate common patterns, domain operations, or composite tool sequences.',
      'Use this only after confirming the skill name is listed in <available_executable_skills>; otherwise use individual tools directly.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Name of the executable skill to invoke.',
        },
        params: {
          type: 'object',
          description: 'Parameters to pass to the skill, matching its declared parameter schema.',
          additionalProperties: true,
        },
      },
      required: ['name'],
      additionalProperties: false,
    },
    requiredPolicy: 'workspace_write',
    async execute(args, ctx): Promise<ToolResult> {
      const skillName = typeof args.name === 'string' ? args.name.trim() : '';
      const params = (args.params && typeof args.params === 'object' && !Array.isArray(args.params))
        ? args.params as Record<string, unknown>
        : {};

      if (!skillName) {
        return {
          status: 'failed',
          output: 'Missing required "name" parameter. Specify the skill name from <available_executable_skills>.',
          error: { message: 'Missing "name"', code: 'INVALID_ARGS' },
        };
      }

      const skills = options.getSkills();
      const skill = skills.find((s) => s.name === skillName);
      if (!skill) {
        const available = skills.filter((s) => s.kind === 'executable').map((s) => s.name).join(', ');
        return {
          status: 'failed',
          output: `Skill "${skillName}" not found. Available executable skills: ${available || '(none)'}`,
          error: { message: `Unknown skill: ${skillName}`, code: 'SKILL_NOT_FOUND' },
        };
      }

      const result = await options.executor.execute(skill, params, {
        workspaceRoot: options.getWorkspaceRoot(),
        threadId: ctx.threadId,
        turnId: ctx.turnId,
        signal: ctx.signal,
      });

      if (!result.success) {
        return {
          status: 'failed',
          output: `Skill "${skillName}" failed: ${result.error?.message ?? 'unknown error'}`,
          error: {
            message: result.error?.message ?? 'unknown error',
            code: result.error?.code ?? 'SKILL_EXECUTION_FAILED',
          },
          data: { durationMs: result.durationMs, toolsUsed: result.toolsUsed, filesChanged: result.filesChanged },
        };
      }

      const summary = result.summary
        ?? (typeof result.output === 'string' ? result.output : JSON.stringify(result.output, null, 2));
      return {
        status: 'completed',
        output: `Skill "${skillName}" completed (${result.durationMs}ms).\n${summary}`,
        data: {
          output: result.output,
          durationMs: result.durationMs,
          toolsUsed: result.toolsUsed,
          filesChanged: result.filesChanged,
        },
      };
    },
  };
}

export function buildSkillParamDescriptions(skills: LoadedSkill[]): Array<{ name: string; description: string; params?: string }> {
  return skills
    .filter((s) => s.kind === 'executable')
    .map((s) => {
      const paramHint = s.parameters
        ? s.parameters.map((p) => `${p.name}${p.required ? '*' : ''}:${p.type}`).join(', ')
        : undefined;
      return { name: s.name, description: s.description, params: paramHint };
    });
}

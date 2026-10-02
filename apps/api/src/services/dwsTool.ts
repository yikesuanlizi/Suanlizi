// DWS Agent 工具 — 让 Agent 通过 dws CLI 操作钉钉企业数据
// Chinese: DWS Agent tool — lets Agent operate DingTalk enterprise data via dws CLI
import { dwsExec, dwsSchema, dwsAuthStatus, isDwsAvailable } from '@suanlizi/bot';
import type { ToolContext, ToolDefinition, ToolResult } from '@suanlizi/tools';
import type { DwsCliConfig } from '../config/botConfig.js';

export const DWS_EXEC_TOOL_NAME = 'dws_exec';
export const DWS_SCHEMA_TOOL_NAME = 'dws_schema';
export const DWS_AUTH_STATUS_TOOL_NAME = 'dws_auth_status';

export interface DwsToolOptions {
  config: DwsCliConfig;
}

/**
 * 创建 dws CLI 相关的 Agent 工具
 * 与钉钉机器人搭配使用：机器人接收用户消息 → Agent 理解意图 → dws 执行操作
 * Chinese: Create dws CLI Agent tools, works alongside the DingTalk bot
 */
export function createDwsTools(options: DwsToolOptions): ToolDefinition[] {
  const { config } = options;
  const binaryPath = config.binaryPath?.trim() || undefined;
  const cliEnv: Record<string, string> = {};
  if (config.clientId?.trim()) {
    cliEnv.DWS_CLIENT_ID = config.clientId.trim();
  }
  if (config.clientSecret?.trim()) {
    cliEnv.DWS_CLIENT_SECRET = config.clientSecret.trim();
  }

  return [
    {
      name: DWS_EXEC_TOOL_NAME,
      description: [
        'Execute a DingTalk Workspace CLI (dws) command to operate DingTalk enterprise data.',
        'Use this when the user asks to: search contacts, create calendar events, manage tasks/todos, query AI tables, send DING messages, manage documents, check attendance, etc.',
        'The command format is: dws <product> <group> <action> [flags].',
        'Examples: ["calendar","event","list"], ["todo","task","create","--title","Review PR","--executors","userId"], ["contact","user","search","--query","张三"]',
        'Always use --dry-run first if unsure about the command. Use -f json for structured output.',
      ].join(' '),
      requiredPolicy: 'workspace_write',
      timeoutMs: 60_000,
      parameters: {
        type: 'object',
        properties: {
          args: {
            type: 'array',
            items: { type: 'string' },
            description: 'Command arguments to pass to dws (without the "dws" prefix). Example: ["calendar","event","list","--format","json"]',
          },
          dryRun: {
            type: 'boolean',
            description: 'If true, preview the request without executing. Recommended for destructive operations.',
          },
          jq: {
            type: 'string',
            description: 'Optional jq expression to filter JSON output and reduce token consumption. Example: ".result[] | {name: .userName, id: .userId}"',
          },
        },
        required: ['args'],
        additionalProperties: false,
      },
      execute: async (args: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult> => {
        const cmdArgs = Array.isArray(args.args) ? args.args.map(String) : [];
        const dryRun = Boolean(args.dryRun);
        const jq = typeof args.jq === 'string' ? args.jq.trim() : undefined;
        if (cmdArgs.length === 0) {
          return { status: 'failed', output: 'Error: no command arguments provided.', error: { message: 'No command arguments provided.' } };
        }
        const available = await isDwsAvailable(binaryPath);
        if (!available) {
          return {
            status: 'failed',
            output: 'dws is not installed or not found in PATH. Please install it first: npm install -g dingtalk-workspace-cli',
            error: { message: 'dws not installed' },
          };
        }
        const result = await dwsExec(cmdArgs, {
          binaryPath,
          env: cliEnv,
          format: 'json',
          dryRun,
          jq,
        });
        if (result.exitCode !== 0 && result.exitCode !== -2) {
          return {
            status: 'failed',
            output: `dws exited with code ${result.exitCode}.\nstderr: ${result.stderr}\nstdout: ${result.stdout}`,
            error: { message: `dws exited with code ${result.exitCode}` },
          };
        }
        const output = result.json !== null ? JSON.stringify(result.json, null, 2) : result.stdout;
        return { status: 'completed', output: output || '(empty output)' };
      },
    },
    {
      name: DWS_SCHEMA_TOOL_NAME,
      description: [
        'Query dws schema to discover available DingTalk products and tools.',
        'Without a tool path, lists all products. With a tool path, shows the parameter schema for that specific tool.',
        'Use this before executing dws commands to understand what arguments are available.',
        'Example tool paths: "ding.send_ding_message", "calendar.event.list", "aitable.query_records"',
      ].join(' '),
      requiredPolicy: 'readonly',
      timeoutMs: 15_000,
      parameters: {
        type: 'object',
        properties: {
          toolPath: {
            type: 'string',
            description: 'Optional tool path to query. Format: product.rpc_name (e.g. "calendar.event.list") or "ding.send_ding_message".',
          },
        },
        required: [],
        additionalProperties: false,
      },
      execute: async (args: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult> => {
        const toolPath = typeof args.toolPath === 'string' ? args.toolPath.trim() : undefined;
        const result = await dwsSchema(toolPath, { binaryPath, env: cliEnv });
        if (result.exitCode !== 0) {
          return { status: 'failed', output: `dws schema failed: ${result.stderr}`, error: { message: `dws schema exited ${result.exitCode}` } };
        }
        return { status: 'completed', output: result.stdout || '(empty)' };
      },
    },
    {
      name: DWS_AUTH_STATUS_TOOL_NAME,
      description: 'Check the authentication status of the dws CLI. Use this to verify if the user is logged in and which organization is selected.',
      requiredPolicy: 'readonly',
      timeoutMs: 10_000,
      parameters: {
        type: 'object',
        properties: {},
        required: [],
        additionalProperties: false,
      },
      execute: async (_args: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult> => {
        const result = await dwsAuthStatus({ binaryPath, env: cliEnv });
        if (result.exitCode !== 0) {
          return { status: 'failed', output: `Not authenticated: ${result.stderr}`, error: { message: 'Not authenticated' } };
        }
        return { status: 'completed', output: result.stdout || '(empty)' };
      },
    },
  ];
}

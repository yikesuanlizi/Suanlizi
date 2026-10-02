import type { ContextProvider, ProviderContext, EnvironmentContext, ContextProviderResult } from '../types.js';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export interface EnvironmentContextProviderOptions {
  cwd: string;
  os?: string;
  shell?: string;
}

export class EnvironmentContextProvider implements ContextProvider {
  readonly name = 'environment';
  readonly priority = 10;
  readonly maxTokens = 400;
  readonly phase = 'before_turn' as const;

  private readonly options: EnvironmentContextProviderOptions;
  private cachedEnv: EnvironmentContext | null = null;

  constructor(options: EnvironmentContextProviderOptions) {
    this.options = options;
  }

  private detectOs(): string {
    if (this.options.os) return this.options.os;
    const platform = process.platform;
    if (platform === 'win32') return 'windows';
    if (platform === 'darwin') return 'macos';
    return platform;
  }

  private detectShell(): string {
    if (this.options.shell) return this.options.shell;
    if (process.platform === 'win32') return process.env.COMSPEC || 'cmd.exe';
    return process.env.SHELL || '/bin/sh';
  }

  private detectGitInfo(cwd: string): { branch?: string; dirty?: boolean } {
    try {
      const gitDir = join(cwd, '.git');
      if (!existsSync(gitDir)) return {};

      const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
        cwd,
        encoding: 'utf8',
        timeout: 3000,
        windowsHide: true,
      }).trim();

      const status = execFileSync('git', ['status', '--porcelain'], {
        cwd,
        encoding: 'utf8',
        timeout: 3000,
        windowsHide: true,
      }).trim();

      return {
        branch: branch || undefined,
        dirty: status.length > 0,
      };
    } catch {
      return {};
    }
  }

  private detectBuildFiles(cwd: string): string[] {
    const candidates = [
      'package.json',
      'tsconfig.json',
      'pnpm-workspace.yaml',
      'pom.xml',
      'build.gradle',
      'requirements.txt',
      'pyproject.toml',
      'Cargo.toml',
      'go.mod',
      'Makefile',
      'Dockerfile',
      'docker-compose.yml',
      '.env',
    ];
    return candidates.filter((f) => existsSync(join(cwd, f)));
  }

  private detectEnvironment(): EnvironmentContext {
    if (this.cachedEnv) return this.cachedEnv;

    const cwd = this.options.cwd;
    const os = this.detectOs();
    const shell = this.detectShell();
    const git = this.detectGitInfo(cwd);
    const hasBuildFiles = this.detectBuildFiles(cwd);

    this.cachedEnv = {
      cwd,
      os,
      shell,
      gitBranch: git.branch,
      gitDirty: git.dirty,
      hasBuildFiles: hasBuildFiles.length > 0 ? hasBuildFiles : undefined,
    };
    return this.cachedEnv;
  }

  invalidateCache(): void {
    this.cachedEnv = null;
  }

  async provide(ctx: ProviderContext): Promise<ContextProviderResult> {
    const env = this.detectEnvironment();
    const existingEnv = ctx.agentContext.world.environment;
    const envChanged = JSON.stringify(env) !== JSON.stringify(existingEnv);

    const lines = [
      '<environment>',
      `OS: ${env.os}`,
      `Shell: ${env.shell}`,
      `Working directory: ${env.cwd}`,
    ];
    if (env.gitBranch) {
      lines.push(`Git branch: ${env.gitBranch}${env.gitDirty ? ' (dirty)' : ''}`);
    }
    if (env.hasBuildFiles?.length) {
      lines.push(`Detected build files: ${env.hasBuildFiles.join(', ')}`);
    }
    lines.push('</environment>');

    const content = lines.join('\n');

    return {
      chunks: [{
        id: `env:${env.cwd}`,
        source: this.name,
        priority: this.priority,
        tokens: Math.ceil(content.length / 3.5),
        content,
      }],
      contextPatch: envChanged ? { world: { environment: env } } : undefined,
    };
  }
}

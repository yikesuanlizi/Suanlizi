import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { execFileSync } from 'node:child_process';
import type {
  ArchitectureSummary,
  ModuleInfo,
  ProjectChangeDelta,
  RiskArea,
} from './projectBrainTypes.js';

const MAX_SCAN_DEPTH = 3;
const MAX_FILES_PER_DIR = 30;
const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.next', 'coverage',
  '.cache', 'out', 'target', 'bin', 'obj', '__pycache__', '.venv',
  'venv', '.tox', '.idea', '.vscode', '.suanlizi',
]);

const BUILD_INDICATORS: Record<string, { buildSystem: string; language: string; framework?: string }> = {
  'package.json': { buildSystem: 'npm', language: 'typescript' },
  'tsconfig.json': { buildSystem: 'tsc', language: 'typescript' },
  'Cargo.toml': { buildSystem: 'cargo', language: 'rust' },
  'go.mod': { buildSystem: 'go', language: 'go' },
  'pyproject.toml': { buildSystem: 'poetry/pip', language: 'python' },
  'requirements.txt': { buildSystem: 'pip', language: 'python' },
  'setup.py': { buildSystem: 'setuptools', language: 'python' },
  'pom.xml': { buildSystem: 'maven', language: 'java' },
  'build.gradle': { buildSystem: 'gradle', language: 'java' },
  'Gemfile': { buildSystem: 'bundler', language: 'ruby' },
  'composer.json': { buildSystem: 'composer', language: 'php' },
};

const FRAMEWORK_INDICATORS: Record<string, string> = {
  'next.config.js': 'Next.js',
  'next.config.mjs': 'Next.js',
  'next.config.ts': 'Next.js',
  'nuxt.config.ts': 'Nuxt',
  'vite.config.ts': 'Vite',
  'vite.config.js': 'Vite',
  'webpack.config.js': 'Webpack',
  'svelte.config.js': 'Svelte',
  'angular.json': 'Angular',
  'nest-cli.json': 'NestJS',
  'pom.xml': 'Spring/Maven',
  'build.gradle': 'Spring/Gradle',
};

const TEST_FRAMEWORK_INDICATORS: Record<string, string> = {
  'vitest': 'Vitest',
  'jest': 'Jest',
  'mocha': 'Mocha',
  'pytest': 'pytest',
  'junit': 'JUnit',
};

function safeReadJson(filePath: string): Record<string, unknown> | null {
  try {
    if (!existsSync(filePath)) return null;
    const raw = readFileSync(filePath, 'utf-8');
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function safeExecGit(cwd: string, args: string[]): string | null {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    }).trim();
  } catch {
    return null;
  }
}

const gitDeltaCache = new Map<string, { delta: ProjectChangeDelta; at: number }>();
const GIT_DELTA_CACHE_MS = 2000;

export function scanGitDelta(workspaceRoot: string): ProjectChangeDelta {
  const empty: ProjectChangeDelta = {
    changedFiles: [],
    addedFiles: [],
    deletedFiles: [],
    riskAreas: [],
  };
  if (!workspaceRoot || !existsSync(join(workspaceRoot, '.git'))) return empty;

  const cached = gitDeltaCache.get(workspaceRoot);
  const now = Date.now();
  if (cached && now - cached.at < GIT_DELTA_CACHE_MS) {
    return cached.delta;
  }

  const statusOut = safeExecGit(workspaceRoot, ['status', '--porcelain']);
  if (statusOut === null) {
    const fallback = empty;
    gitDeltaCache.set(workspaceRoot, { delta: fallback, at: now });
    return fallback;
  }

  const changedFiles: string[] = [];
  const addedFiles: string[] = [];
  const deletedFiles: string[] = [];

  for (const line of statusOut.split('\n')) {
    if (!line) continue;
    const status = line.slice(0, 2).trim();
    const file = line.slice(3).trim();
    if (!file) continue;
    const normalizedFile = file.replace(/\\/g, '/');
    if (status.includes('D')) {
      deletedFiles.push(normalizedFile);
    } else if (status.includes('?') || status === 'A') {
      addedFiles.push(normalizedFile);
    } else {
      changedFiles.push(normalizedFile);
    }
  }

  const riskAreas = computeLocalRiskAreas(changedFiles, addedFiles);

  const delta: ProjectChangeDelta = { changedFiles, addedFiles, deletedFiles, riskAreas };
  gitDeltaCache.set(workspaceRoot, { delta, at: now });
  return delta;
}

function scanModules(root: string, currentDir: string, depth: number, acc: ModuleInfo[]): void {
  if (depth > MAX_SCAN_DEPTH) return;
  let entries: string[];
  try {
    entries = readdirSync(currentDir);
  } catch {
    return;
  }
  let counted = 0;
  for (const entry of entries) {
    if (counted >= MAX_FILES_PER_DIR) break;
    const fullPath = join(currentDir, entry);
    let stat;
    try { stat = statSync(fullPath); } catch { continue; }
    if (stat.isDirectory()) {
      if (SKIP_DIRS.has(entry)) continue;
      if (entry.startsWith('.')) continue;
      const relPath = relative(root, fullPath).replace(/\\/g, '/');
      if (depth >= 1) {
        const hasIndex = existsSync(join(fullPath, 'index.ts'))
          || existsSync(join(fullPath, 'index.js'))
          || existsSync(join(fullPath, 'index.tsx'))
          || existsSync(join(fullPath, 'mod.rs'))
          || existsSync(join(fullPath, '__init__.py'));
        acc.push({
          name: entry,
          path: relPath || '.',
          purpose: hasIndex ? 'module' : 'directory',
        });
        counted++;
      }
      scanModules(root, fullPath, depth + 1, acc);
    }
  }
}

function detectEntryPoints(root: string, pkg: Record<string, unknown> | null): string[] {
  const entries: string[] = [];
  if (pkg) {
    const main = typeof pkg.main === 'string' ? pkg.main : null;
    if (main) entries.push(main);
    const scripts = (pkg.scripts ?? {}) as Record<string, string>;
    for (const [name, cmd] of Object.entries(scripts)) {
      if (name === 'start' || name === 'dev' || name === 'build') {
        entries.push(`npm run ${name} (${cmd})`);
      }
    }
  }
  const candidates = ['src/index.ts', 'src/main.ts', 'src/index.js', 'main.py', 'src/main.rs', 'cmd/main.go', 'app.py', 'server.ts', 'server.js'];
  for (const c of candidates) {
    if (existsSync(join(root, c))) entries.push(c);
  }
  return [...new Set(entries)].slice(0, 8);
}

function detectTechStack(root: string, pkg: Record<string, unknown> | null): {
  techStack: string[];
  framework?: string;
  buildSystem?: string;
  testFramework?: string;
  language: string;
} {
  const techStack: string[] = [];
  let language = 'unknown';
  let buildSystem: string | undefined;
  let framework: string | undefined;
  let testFramework: string | undefined;

  for (const [file, info] of Object.entries(BUILD_INDICATORS)) {
    if (existsSync(join(root, file))) {
      language = info.language;
      buildSystem = info.buildSystem;
      techStack.push(info.language);
      if (info.framework) framework = info.framework;
      break;
    }
  }

  for (const [file, fw] of Object.entries(FRAMEWORK_INDICATORS)) {
    if (existsSync(join(root, file))) {
      framework = fw;
      techStack.push(fw);
      break;
    }
  }

  if (pkg) {
    const deps = {
      ...(pkg.dependencies as Record<string, string> ?? {}),
      ...(pkg.devDependencies as Record<string, string> ?? {}),
    };
    for (const [name, tf] of Object.entries(TEST_FRAMEWORK_INDICATORS)) {
      if (name in deps) { testFramework = tf; techStack.push(tf); break; }
    }
    const notableDeps = ['react', 'vue', 'express', 'fastify', 'langchain', 'typeorm', 'prisma', 'sequelize', 'tailwindcss'];
    for (const dep of notableDeps) {
      if (dep in deps) techStack.push(dep);
    }
  }

  return { techStack: [...new Set(techStack)], framework, buildSystem, testFramework, language };
}

const localProjectCache = new Map<string, { summary: ArchitectureSummary | null; at: number }>();
const LOCAL_PROJECT_CACHE_MS = 30_000;

export function scanLocalProject(workspaceRoot: string): ArchitectureSummary | null {
  if (!workspaceRoot || !existsSync(workspaceRoot)) return null;

  const cached = localProjectCache.get(workspaceRoot);
  const now = Date.now();
  if (cached && now - cached.at < LOCAL_PROJECT_CACHE_MS) {
    return cached.summary;
  }

  const pkgPath = join(workspaceRoot, 'package.json');
  const pkg = safeReadJson(pkgPath);
  const { techStack, framework, buildSystem, testFramework, language } = detectTechStack(workspaceRoot, pkg);

  if (language === 'unknown' && !pkg) {
    const hasAnyCode = existsSync(join(workspaceRoot, 'src')) || existsSync(join(workspaceRoot, 'app'));
    if (!hasAnyCode) {
      localProjectCache.set(workspaceRoot, { summary: null, at: now });
      return null;
    }
  }

  const modules: ModuleInfo[] = [];
  scanModules(workspaceRoot, workspaceRoot, 0, modules);

  const entryPoints = detectEntryPoints(workspaceRoot, pkg);

  const keyPatterns: string[] = [];
  if (existsSync(join(workspaceRoot, '.git'))) keyPatterns.push('git repository');
  if (existsSync(join(workspaceRoot, 'Dockerfile'))) keyPatterns.push('Dockerized');
  if (existsSync(join(workspaceRoot, 'docker-compose.yml')) || existsSync(join(workspaceRoot, 'docker-compose.yaml'))) keyPatterns.push('docker-compose');
  if (existsSync(join(workspaceRoot, '.env.example'))) keyPatterns.push('uses .env');
  if (existsSync(join(workspaceRoot, 'README.md'))) keyPatterns.push('has README');
  if (existsSync(join(workspaceRoot, '.github'))) keyPatterns.push('CI via GitHub Actions');

  const result: ArchitectureSummary = {
    techStack,
    framework,
    language,
    buildSystem,
    testFramework,
    modules: modules.slice(0, 25),
    entryPoints,
    keyPatterns,
    generatedAt: Date.now(),
  };
  localProjectCache.set(workspaceRoot, { summary: result, at: now });
  return result;
}

function computeLocalRiskAreas(changedFiles: string[], addedFiles: string[]): RiskArea[] {
  const risks: RiskArea[] = [];
  const all = [...changedFiles, ...addedFiles];

  const configFiles = all.filter((f) =>
    /(?:^|\/)(?:package\.json|tsconfig\.json|vite\.config|webpack\.config|Dockerfile|docker-compose|\.env|pom\.xml|Cargo\.toml|go\.mod|pyproject\.toml)/.test(f)
  );
  if (configFiles.length > 0) {
    risks.push({
      area: 'build configuration',
      reason: `${configFiles.length} build/config file(s) changed: ${configFiles.slice(0, 3).join(', ')}`,
      severity: 'medium',
      files: configFiles.slice(0, 5),
    });
  }

  const testFiles = all.filter((f) => /(?:test|spec|\.test\.|\.spec\.)/.test(f));
  const sourceFiles = all.filter((f) => !/(?:test|spec|node_modules|\.d\.ts)/.test(f) && /\.(ts|tsx|js|jsx|py|rs|go|java)$/.test(f));
  if (sourceFiles.length > 0 && testFiles.length === 0) {
    risks.push({
      area: 'test coverage',
      reason: `${sourceFiles.length} source file(s) changed without corresponding test changes`,
      severity: 'low',
      files: sourceFiles.slice(0, 3),
    });
  }

  const dbFiles = all.filter((f) => /(?:migration|schema|prisma|typeorm|sequelize|models?\/)/.test(f));
  if (dbFiles.length > 0) {
    risks.push({
      area: 'database/schema',
      reason: `${dbFiles.length} database/schema file(s) changed`,
      severity: 'high',
      files: dbFiles.slice(0, 5),
    });
  }

  const authFiles = all.filter((f) => /(?:auth|login|password|jwt|token|permission)/i.test(f));
  if (authFiles.length > 0) {
    risks.push({
      area: 'security/auth',
      reason: `${authFiles.length} auth-related file(s) changed`,
      severity: 'high',
      files: authFiles.slice(0, 5),
    });
  }

  return risks.slice(0, 5);
}

export function hashArchitectureSummary(summary: ArchitectureSummary): string {
  const key = `${summary.language}|${summary.framework ?? ''}|${summary.buildSystem ?? ''}|${summary.techStack.join(',')}|${summary.modules.map((m) => m.path).join(',')}`;
  let hash = 0;
  for (let i = 0; i < key.length; i++) {
    hash = ((hash << 5) - hash + key.charCodeAt(i)) | 0;
  }
  return `arch_${(hash >>> 0).toString(36)}`;
}

import { randomUUID } from 'node:crypto';

/**
 * Version of the rule set, persisted with Evidence so a replay can use the
 * same detector contract that produced the original redacted content.
 */
export const SECRET_REDACTION_VERSION = 'suanlizi-secret-rules-v1';

export type SecretRuleId =
  | 'private_key'
  | 'bearer_token'
  | 'api_key'
  | 'password'
  | 'connection_string';

export type SecretRedactionFailureCode =
  | 'INPUT_NOT_STRING'
  | 'INPUT_TOO_LARGE'
  | 'OUTPUT_TOO_LARGE'
  | 'INVALID_OPTIONS'
  | 'REDACTION_EXCEPTION';

/** The source fields intentionally mirror Evidence.source without importing protocol. */
export interface RedactionSource {
  adapterId?: string;
  hostId?: string;
  service?: string;
  path?: string;
  lineStart?: number;
  lineEnd?: number;
}

/** Context needed to turn a failed redaction into an EvidenceAttempt audit record. */
export interface SecretRedactionContext {
  taskId?: string;
  runId?: string;
  source?: RedactionSource;
  observedAt?: string;
  attemptId?: string;
}

export interface EvidenceAttempt {
  attemptId: string;
  taskId?: string;
  runId?: string;
  source?: RedactionSource;
  status: 'redaction_failed';
  detectorVersion: string;
  reasonCode: SecretRedactionFailureCode;
  observedAt: string;
}

export interface SecretRedactionMetadata {
  detectorVersion: string;
  inputBytes: number;
  outputBytes?: number;
  matchCount: number;
  rulesApplied: Partial<Record<SecretRuleId, number>>;
}

export interface SecretRedactionSuccess {
  ok: true;
  status: 'redacted' | 'unchanged';
  redactedContent: string;
  metadata: SecretRedactionMetadata;
}

export interface SecretRedactionFailure {
  ok: false;
  status: 'redaction_failed';
  reasonCode: SecretRedactionFailureCode;
  metadata: SecretRedactionMetadata;
  attempt: EvidenceAttempt;
}

export type SecretRedactionResult = SecretRedactionSuccess | SecretRedactionFailure;

export interface SecretRedactorOptions {
  /** Maximum UTF-8 bytes accepted from an adapter result. */
  maxInputBytes?: number;
  /** Maximum UTF-8 bytes allowed after redaction. */
  maxOutputBytes?: number;
  /** Replacement used for every detected secret. It must not contain newlines. */
  replacement?: string;
  /** The detector version is part of every Evidence and EvidenceAttempt. */
  detectorVersion?: string;
}

interface CompiledSecretRule {
  id: SecretRuleId;
  pattern: RegExp;
  replace(match: string, ...groups: string[]): string;
}

const PRIVATE_KEY_PATTERN =
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g;
const BEARER_TOKEN_PATTERN = /(\bBearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi;

// Known provider formats plus JWTs. The patterns deliberately require a
// recognizable prefix and enough entropy to avoid masking ordinary prose.
const API_KEY_PATTERN =
  /\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AIza[A-Za-z0-9_-]{20,}|(?:AKIA|ASIA)[0-9A-Z]{16}|hf_[A-Za-z0-9]{20,}|pplx-[A-Za-z0-9]{20,}|npm_[A-Za-z0-9]{20,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})\b/g;

// Assignment forms cover .env, JSON, YAML and common command output while
// preserving the key and delimiters. The callback also rejects null-like
// values so a config dump does not turn into a misleading secret match.
const API_ASSIGNMENT_PATTERN =
  /(\b(?:api[_ -]?key|access[_ -]?token|auth[_ -]?token|refresh[_ -]?token|id[_ -]?token|token|client[_ -]?secret|secret[_ -]?key)\b\s*[:=]\s*)(["']?)([A-Za-z0-9][A-Za-z0-9._~+/=-]{7,})(\2)/gi;
const PASSWORD_ASSIGNMENT_PATTERN =
  /(\b(?:password|passwd|pwd)\b\s*[:=]\s*)(?:(")[\s\S]*?\2|(')[\s\S]*?\3|([^,\s};]{4,}))/gi;

// Only redact the credential segment of supported connection URLs. A URL
// without user:password@ is not secret by itself and remains inspectable.
const CONNECTION_CREDENTIAL_PATTERN =
  /(\b(?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|redis|rediss|amqps?|jdbc):\/\/)([^\s/@:]+):([^\s/@]+)@/gi;

function createRules(replacement: string): CompiledSecretRule[] {
  return [
    {
      id: 'private_key',
      pattern: PRIVATE_KEY_PATTERN,
      replace: () => replacement,
    },
    {
      id: 'bearer_token',
      pattern: BEARER_TOKEN_PATTERN,
      replace: (_match, prefix) => `${prefix}${replacement}`,
    },
    {
      id: 'api_key',
      pattern: API_KEY_PATTERN,
      replace: () => replacement,
    },
    {
      id: 'api_key',
      pattern: API_ASSIGNMENT_PATTERN,
      replace: (_match, prefix, quote) => `${prefix}${quote}${replacement}${quote}`,
    },
    {
      id: 'password',
      pattern: PASSWORD_ASSIGNMENT_PATTERN,
      replace: (_match, prefix, doubleQuoteValue, singleQuoteValue, unquotedValue) => {
        const quote = doubleQuoteValue || singleQuoteValue;
        const value = quote ? _match.slice(prefix.length + 1, -1) : unquotedValue;
        if (/^(?:true|false|null|undefined|none)$/i.test(value)) return _match;
        return `${prefix}${quote}${replacement}${quote}`;
      },
    },
    {
      id: 'connection_string',
      pattern: CONNECTION_CREDENTIAL_PATTERN,
      replace: (_match, prefix, user) => `${prefix}${user}:${replacement}@`,
    },
  ];
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function buildMetadata(
  detectorVersion: string,
  inputBytes: number,
  rulesApplied: Partial<Record<SecretRuleId, number>>,
  outputBytes?: number,
): SecretRedactionMetadata {
  return {
    detectorVersion,
    inputBytes,
    ...(outputBytes === undefined ? {} : { outputBytes }),
    matchCount: Object.values(rulesApplied).reduce((sum, count) => sum + (count ?? 0), 0),
    rulesApplied,
  };
}

function createAttempt(
  detectorVersion: string,
  reasonCode: SecretRedactionFailureCode,
  context: SecretRedactionContext,
): EvidenceAttempt {
  return {
    attemptId: context.attemptId ?? randomUUID(),
    ...(context.taskId === undefined ? {} : { taskId: context.taskId }),
    ...(context.runId === undefined ? {} : { runId: context.runId }),
    ...(context.source === undefined ? {} : { source: context.source }),
    status: 'redaction_failed',
    detectorVersion,
    reasonCode,
    observedAt: context.observedAt ?? new Date().toISOString(),
  };
}

/**
 * Versioned, deterministic secret detector for adapter text. It never returns
 * source content on failure, which lets callers safely persist `attempt` while
 * refusing to write an Evidence object or send anything to the model.
 */
export class SecretRedactor {
  readonly detectorVersion: string;
  private readonly maxInputBytes: number;
  private readonly maxOutputBytes: number;
  private readonly replacement: string;
  private readonly optionsError?: SecretRedactionFailureCode;

  constructor(options: SecretRedactorOptions = {}) {
    this.detectorVersion = options.detectorVersion ?? SECRET_REDACTION_VERSION;
    this.maxInputBytes = options.maxInputBytes ?? 1024 * 1024;
    this.maxOutputBytes = options.maxOutputBytes ?? 1024 * 1024;
    this.replacement = options.replacement ?? '[REDACTED]';

    if (
      !this.detectorVersion ||
      !Number.isSafeInteger(this.maxInputBytes) ||
      this.maxInputBytes <= 0 ||
      !Number.isSafeInteger(this.maxOutputBytes) ||
      this.maxOutputBytes <= 0 ||
      !this.replacement ||
      /[\r\n]/.test(this.replacement)
    ) {
      this.optionsError = 'INVALID_OPTIONS';
    }
  }

  redact(content: unknown, context: SecretRedactionContext = {}): SecretRedactionResult {
    const inputBytes = typeof content === 'string' ? byteLength(content) : 0;
    const emptyRules: Partial<Record<SecretRuleId, number>> = {};

    if (this.optionsError) {
      return this.failure(this.optionsError, inputBytes, emptyRules, context);
    }
    if (typeof content !== 'string') {
      return this.failure('INPUT_NOT_STRING', inputBytes, emptyRules, context);
    }
    if (inputBytes > this.maxInputBytes) {
      return this.failure('INPUT_TOO_LARGE', inputBytes, emptyRules, context);
    }

    try {
      let redactedContent = content;
      const rulesApplied: Partial<Record<SecretRuleId, number>> = {};
      for (const rule of createRules(this.replacement)) {
        let count = 0;
        redactedContent = redactedContent.replace(rule.pattern, (...args: unknown[]) => {
          const match = String(args[0]);
          const groups = args
            .slice(1, -2)
            .map((group) => (group === undefined ? '' : String(group)));
          const next = rule.replace(match, ...groups);
          if (next !== match) count += 1;
          return next;
        });
        if (count > 0) rulesApplied[rule.id] = (rulesApplied[rule.id] ?? 0) + count;
      }

      const outputBytes = byteLength(redactedContent);
      if (outputBytes > this.maxOutputBytes) {
        return this.failure('OUTPUT_TOO_LARGE', inputBytes, rulesApplied, context);
      }
      const metadata = buildMetadata(this.detectorVersion, inputBytes, rulesApplied, outputBytes);
      return {
        ok: true,
        status: metadata.matchCount > 0 ? 'redacted' : 'unchanged',
        redactedContent,
        metadata,
      };
    } catch {
      return this.failure('REDACTION_EXCEPTION', inputBytes, emptyRules, context);
    }
  }

  private failure(
    reasonCode: SecretRedactionFailureCode,
    inputBytes: number,
    rulesApplied: Partial<Record<SecretRuleId, number>>,
    context: SecretRedactionContext,
  ): SecretRedactionFailure {
    return {
      ok: false,
      status: 'redaction_failed',
      reasonCode,
      metadata: buildMetadata(this.detectorVersion, inputBytes, rulesApplied),
      attempt: createAttempt(this.detectorVersion, reasonCode, context),
    };
  }
}

export function redactSecrets(
  content: unknown,
  options: SecretRedactorOptions = {},
  context: SecretRedactionContext = {},
): SecretRedactionResult {
  return new SecretRedactor(options).redact(content, context);
}

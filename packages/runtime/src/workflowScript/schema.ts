// Workflow agent() 结构化输出的最小 JSON Schema 校验（计划 §5.4）。
// 覆盖脚本场景需要的子集：type / properties / required / items / enum；
// 故意不实现完整 JSON Schema：超出子集的关键字按未知关键字忽略并记入 warnings。

export interface SchemaValidationResult {
  ok: boolean;
  error?: string;
}

const MAX_DEPTH = 20;

export function validateStructuredOutput(schema: unknown, value: unknown): SchemaValidationResult {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    return { ok: false, error: 'schema must be a JSON Schema object' };
  }
  return check(value, schema as Record<string, unknown>, '', 0);
}

function check(value: unknown, schema: Record<string, unknown>, path: string, depth: number): SchemaValidationResult {
  if (depth > MAX_DEPTH) {
    return { ok: false, error: `${pathLabel(path)}: schema nesting exceeds depth ${MAX_DEPTH}` };
  }

  const enumValues = schema.enum;
  if (Array.isArray(enumValues)) {
    const match = enumValues.some((candidate) => JSON.stringify(candidate) === JSON.stringify(value));
    if (!match) {
      return { ok: false, error: `${pathLabel(path)}: value does not match enum ${JSON.stringify(enumValues)}` };
    }
    return { ok: true };
  }

  const type = schema.type;
  if (type !== undefined) {
    const types = Array.isArray(type) ? type : [type];
    const matched = types.some((candidate) => typeMatches(candidate, value));
    if (!matched) {
      return { ok: false, error: `${pathLabel(path)}: expected type ${types.join('|')}, got ${actualType(value)}` };
    }
  }

  if (actualType(value) === 'object' && !Array.isArray(value)) {
    const required = Array.isArray(schema.required) ? (schema.required as unknown[]) : [];
    const record = value as Record<string, unknown>;
    for (const key of required) {
      if (typeof key === 'string' && !(key in record)) {
        return { ok: false, error: `${pathLabel(path)}: missing required property \`${key}\`` };
      }
    }
    const properties = schema.properties;
    if (properties && typeof properties === 'object' && !Array.isArray(properties)) {
      for (const [key, childSchema] of Object.entries(properties)) {
        if (key in record && childSchema && typeof childSchema === 'object') {
          const result = check(record[key], childSchema as Record<string, unknown>, `${path}.${key}`, depth + 1);
          if (!result.ok) return result;
        }
      }
    }
  }

  if (Array.isArray(value) && schema.items && typeof schema.items === 'object' && !Array.isArray(schema.items)) {
    for (let index = 0; index < value.length; index += 1) {
      const result = check(value[index], schema.items as Record<string, unknown>, `${path}[${index}]`, depth + 1);
      if (!result.ok) return result;
    }
  }

  return { ok: true };
}

function typeMatches(type: unknown, value: unknown): boolean {
  switch (type) {
    case 'string': return typeof value === 'string';
    case 'number': return typeof value === 'number' && Number.isFinite(value);
    case 'integer': return typeof value === 'number' && Number.isInteger(value);
    case 'boolean': return typeof value === 'boolean';
    case 'object': return typeof value === 'object' && value !== null && !Array.isArray(value);
    case 'array': return Array.isArray(value);
    case 'null': return value === null;
    default: return false;
  }
}

function actualType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function pathLabel(path: string): string {
  return path === '' ? 'root' : path;
}

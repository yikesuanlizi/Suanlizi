import { describe, expect, it } from 'vitest';
import { assignedModelContextTokens, DEFAULT_MODEL_CONTEXT_REFERENCES, modelContextReferenceFor, validateModelContextReferences } from './modelContextReferences.js';

describe('model context references', () => {
  it('ships editable examples without treating them as provider identity', () => {
    expect(DEFAULT_MODEL_CONTEXT_REFERENCES.some((entry) => entry.model === 'glm-5.3-flash')).toBe(true);
    expect(modelContextReferenceFor(DEFAULT_MODEL_CONTEXT_REFERENCES, ' GLM-5.3-FLASH ')).toMatchObject({ contextTokens: 202_752 });
  });

  it('validates a complete independent text list', () => {
    expect(validateModelContextReferences([{ model: ' custom-model ', contextTokens: 65_536 }])).toEqual([
      { model: 'custom-model', contextTokens: 65_536 },
    ]);
    expect(() => validateModelContextReferences([{ model: 'same', contextTokens: 1 }, { model: 'SAME', contextTokens: 2 }])).toThrow('Duplicate');
  });

  it('copies only the selected value and never mutates the reference list', () => {
    const references = [{ model: 'custom-model', contextTokens: 65_536 }];
    expect(assignedModelContextTokens({ model: 'custom-model', references })).toBe(65_536);
    expect(assignedModelContextTokens({ model: 'custom-model', configured: 131_072, references })).toBe(131_072);
    expect(assignedModelContextTokens({ model: 'custom-model', probe: { source: 'server', contextTokens: 32_768 }, references })).toBe(32_768);
    expect(assignedModelContextTokens({ model: 'custom-model', probe: { source: 'model', contextTokens: 16_384 }, references })).toBe(16_384);
    expect(assignedModelContextTokens({ model: 'missing-model', references })).toBeUndefined();
    expect(references).toEqual([{ model: 'custom-model', contextTokens: 65_536 }]);
  });
});

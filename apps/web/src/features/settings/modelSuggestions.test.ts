
import { describe, expect, it } from 'vitest';
import { mergeModelSuggestions } from './modelSuggestions.js';

describe('mergeModelSuggestions', () => {
  it('uses remote models without hardcoded examples when available', () => {
    expect(mergeModelSuggestions({
      presetModels: ['saved-model'],
      remoteModels: ['remote-b', 'remote-a', 'remote-b'],
      remoteReady: true,
    })).toEqual(['saved-model', 'remote-b', 'remote-a']);
  });

  it('falls back to known examples when the provider list is unavailable', () => {
    expect(mergeModelSuggestions({ presetModels: ['saved-model'], remoteReady: false }))
      .toContain('gpt-g-luna');
    expect(mergeModelSuggestions({ presetModels: [], remoteModels: [], remoteReady: true }))
      .toContain('glm-5.3-flash');
  });
});

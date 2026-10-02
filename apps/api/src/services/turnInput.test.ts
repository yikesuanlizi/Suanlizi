import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildUserInputFromTurnRequest } from './turnInput.js';

const tinyImage = 'data:image/png;base64,AQ==';

describe('buildUserInputFromTurnRequest', () => {
  it('rejects more than four image attachments before writing any files', async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'suanlizi-turn-input-'));
    await expect(buildUserInputFromTurnRequest({
      input: 'inspect these',
      images: Array.from({ length: 5 }, (_, index) => ({ name: `${index}.png`, dataUrl: tinyImage })),
    }, { threadId: 'thread', dataDir })).rejects.toThrow('At most 4 image attachments');
  });
});

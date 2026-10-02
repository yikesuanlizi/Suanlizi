import { describe, expect, it } from 'vitest';
import type { ThreadEvent } from '@suanlizi/protocol';
import { ThreadEventHistory } from './threadEventHistory.js';

function event(threadId: string, type: ThreadEvent['type'] = 'connected' as ThreadEvent['type']): ThreadEvent {
  return { type, threadId } as ThreadEvent;
}

describe('ThreadEventHistory', () => {
  it('assigns scoped increasing sequences and replays after a cursor', () => {
    const history = new ThreadEventHistory(3);
    history.append('tenant-a', 'thread-a', event('thread-a'));
    history.append('tenant-a', 'thread-a', event('thread-a', 'turn.started'));
    history.append('tenant-a', 'thread-b', event('thread-b'));

    const replay = history.replayAfter('tenant-a', 'thread-a', 1);
    expect(replay.events.map((entry) => entry.sequence)).toEqual([2]);
    expect(replay.latestSequence).toBe(2);
    expect(history.replayAfter('tenant-b', 'thread-a', 0).events).toHaveLength(0);
  });

  it('bounds history and reports a replay gap when the cursor is too old', () => {
    const history = new ThreadEventHistory(2);
    history.append('tenant-a', 'thread-a', event('thread-a'));
    history.append('tenant-a', 'thread-a', event('thread-a'));
    history.append('tenant-a', 'thread-a', event('thread-a'));

    const replay = history.replayAfter('tenant-a', 'thread-a', 0);
    expect(replay.events.map((entry) => entry.sequence)).toEqual([2, 3]);
    expect(replay.oldestSequence).toBe(2);
    expect(replay.truncated).toBe(true);
  });
});

export const TRANSCRIPT_FOLLOW_GAP_PX = 72;
export const TRANSCRIPT_FOLLOW_TOUCH_PX = 24;

export interface TranscriptFollowState {
  following: boolean;
  showReturnToBottom: boolean;
}

export function nextTranscriptFollowState(input: {
  following: boolean;
  distanceFromBottom: number;
  source: 'user' | 'content' | 'return-action';
}): TranscriptFollowState {
  if (input.source === 'return-action') return { following: true, showReturnToBottom: false };
  if (input.source === 'content') {
    // Streamed content grows the scroll height on its own. Never treat that as
    // the user scrolling away; the caller keeps the bottom pinned in follow mode.
    return input.following ? { following: true, showReturnToBottom: false } : {
      following: false,
      showReturnToBottom: input.distanceFromBottom > TRANSCRIPT_FOLLOW_GAP_PX + TRANSCRIPT_FOLLOW_TOUCH_PX,
    };
  }
  if (input.following) {
    // Treat upward movement as the only explicit stop-following gesture. Small
    // downward moves are ignored so streaming growth cannot unlock the anchor.
    return input.distanceFromBottom < -TRANSCRIPT_FOLLOW_TOUCH_PX
      ? { following: false, showReturnToBottom: false }
      : { following: true, showReturnToBottom: false };
  }
  if (input.distanceFromBottom <= TRANSCRIPT_FOLLOW_GAP_PX + TRANSCRIPT_FOLLOW_TOUCH_PX) {
    return { following: true, showReturnToBottom: false };
  }
  return { following: false, showReturnToBottom: true };
}

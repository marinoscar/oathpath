/**
 * The four states a learner can read from across the room — and the mapping
 * from the seven phases the driver actually has.
 *
 * Issue #356, epic #345. `ConversationPhase` has SEVEN members (#349 added
 * `preparing`), and every one of them used to render as the same grey sentence
 * in `body2 color="text.secondary"`. Seven sentences is the right vocabulary
 * for a live region and the wrong one for a shape: a learner glancing at a
 * phone from arm's length is not reading "Working out how that went." — they
 * are asking one question, "is it my turn?", and there are only ever four
 * answers to it.
 *
 * =============================================================================
 * THIS IS A NARROWING, NOT A REPLACEMENT
 * =============================================================================
 *
 * The precise phase sentence stays exactly where it was, in the surface's one
 * live region, and it is what assistive technology hears. This table is the
 * COARSE rendering beside it, and the two are two renderings of one fact —
 * the same relationship `CONVERSATION_PHASE_TEXT`'s own header states between
 * the spoken cue and the written line. Nothing here decides anything: no
 * transition, no timing, no grade. It decides how one picture looks.
 *
 * `preparing` maps to `thinking` rather than to a fifth state of its own.
 * "The application is busy and it is not your turn" is exactly what a learner
 * needs from the picture while the browser's permission dialogue is open, and
 * the sentence under it — "Opening your microphone." — is the half that says
 * *which* kind of busy. Splitting the picture as finely as the sentence would
 * put five things on screen that differ by a detail nobody can act on.
 *
 * `advancing` maps to `thinking` for the same reason, and `speakingQuestion`
 * and `speakingAnswer` collapse into one `speaking`: WHO is talking is the
 * question the picture answers, and both of those are the application.
 *
 * =============================================================================
 * COLOUR IS NEVER THE SIGNAL. IT IS THE THIRD SIGNAL.
 * =============================================================================
 *
 * Each state carries a `label` (a word), a `shape` (geometry), and only then a
 * `color` (a palette role). The first two are sufficient on their own — that
 * is the acceptance criterion, and it is asserted — because a learner with any
 * of the common colour vision deficiencies, a learner in direct sunlight, and
 * a learner whose phone is in a greyscale accessibility mode all get the same
 * screen. `color` is redundancy for everybody else, and it is a PALETTE ROLE
 * rather than a hex value for the reason `components/practice/outcome.ts`
 * already gives: a literal would render "correctly" in every jsdom test and be
 * unreadable in a real dark theme.
 *
 * `stroke` is the fourth, cheapest signal: the four shapes are also drawn with
 * four different stroke treatments, so two states remain distinguishable in a
 * screenshot scaled down past the point where geometry reads.
 */

import type { ConversationPhase } from '../../hooks/useConversationSession';

/** What the picture says, in the only four answers a learner needs. */
export type VoiceVisualState = 'idle' | 'listening' | 'thinking' | 'speaking';

/** The geometry drawn for one state. Four values, all different — that is the point. */
export type VoiceVisualShape = 'ring' | 'rings' | 'diamond' | 'triangle';

export interface VoiceVisualDisplay {
  /**
   * The word on screen, large.
   *
   * Deliberately not the phase sentence: this is the coarse answer, and the
   * precise one is in the live region under it.
   */
  label: string;
  /** The geometry. Distinct per state, and the signal that survives greyscale. */
  shape: VoiceVisualShape;
  /** How that geometry is stroked. A fourth, redundant signal. */
  stroke: 'dashed' | 'solid' | 'dotted' | 'filled';
  /**
   * A MUI palette role, NEVER a hex value and NEVER the only signal.
   *
   * `default` means "the theme's own text colour" — see `VoiceStateVisual`,
   * which is the one place these roles are resolved.
   */
  color: 'default' | 'success' | 'warning' | 'info';
}

export const VOICE_VISUAL_DISPLAY: Record<VoiceVisualState, VoiceVisualDisplay> = {
  // Reachable on this surface only in the moment between a stop and the
  // unmount that follows it. Included because the mapping is total: a phase
  // with no picture is a blank screen, which is worse than a paused one.
  idle: { label: 'Paused', shape: 'ring', stroke: 'dashed', color: 'default' },
  listening: { label: 'Listening', shape: 'rings', stroke: 'solid', color: 'success' },
  thinking: { label: 'Thinking', shape: 'diamond', stroke: 'dotted', color: 'warning' },
  speaking: { label: 'Speaking', shape: 'triangle', stroke: 'filled', color: 'info' },
};

/**
 * Seven phases in, four pictures out.
 *
 * A `switch` with no `default`, so adding an eighth phase is a COMPILE ERROR
 * here rather than a phase that silently renders as `idle` — the failure would
 * be a learner told the session is paused while it is listening to them.
 */
export function voiceVisualState(phase: ConversationPhase): VoiceVisualState {
  switch (phase) {
    case 'idle':
      return 'idle';
    case 'listening':
      return 'listening';
    case 'speakingQuestion':
    case 'speakingAnswer':
      return 'speaking';
    case 'preparing':
    case 'processing':
    case 'advancing':
      return 'thinking';
  }
}

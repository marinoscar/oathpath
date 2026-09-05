/**
 * Conversation cues — the table, and the six promises it makes.
 *
 * Issue #357, epic #345. Every one of these fails SILENTLY in the field, on a
 * phone in somebody's pocket, which is why they are asserted rather than
 * reviewed:
 *
 *   1. THE TABLE IS EXHAUSTIVE, IN BOTH DIRECTIONS. The whole reason cues are
 *      derived from the phase rather than placed at call sites is that an
 *      eighth phase must not be able to arrive with no cue decision — which is
 *      exactly what happened to `preparing` (#349), the phase whose missing
 *      cue is half of this issue. TypeScript enforces it; this file asserts it
 *      against the union AS WRITTEN IN THE HOOK, so a phase added there and
 *      not here fails even in a build that skipped the typecheck.
 *   2. SILENCE IS ALWAYS A DECISION. Every cell carries a `reason`, including
 *      — especially — the silent ones. A cell with no reason is an omission
 *      wearing a decision's clothes, and it is what the ungoverned call sites
 *      produced.
 *   3. A NORMAL END AND A FAILURE ARE DIFFERENT SOUNDS. A learner who missed
 *      the spoken sentence has to be able to tell "you finished" from "look at
 *      the screen when you can", because the remedies differ.
 *   4. THE PULSE IS BOUND TO `processing` AND TO NOTHING ELSE. It starts on
 *      the way in, stops on the way out, and no path that never pulsed can
 *      stop one — the `onsetTimeout` call that stopped a pulse which had never
 *      started is the thing this replaces.
 *   5. CUES OFF MEANS NO OSCILLATOR IS CONSTRUCTED AT ALL. Not an oscillator
 *      playing silence, and not a context built for nothing.
 *   6. NO AUDIO IS NOT AN ERROR, AND NOTHING LEAKS. Every transition must be a
 *      no-op without throwing when there is no `AudioContext` or it is
 *      suspended, and every node it does build must be disconnected once it
 *      has sounded — a half-hour session drives hundreds of these.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  CONVERSATION_EXIT_CUES,
  CONVERSATION_TRANSITION_CUES,
  applyConversationCue,
  resolveConversationCue,
  silenceProcessingCue,
  type ConversationCueName,
} from '../../lib/conversationCues';
import {
  areEarconsEnabled,
  closeSharedAudioContext,
  isProcessingPulseRunning,
  setEarconsEnabled,
  stopProcessingPulse,
} from '../../lib/earcons';
import type {
  ConversationPhase,
  ConversationStopReason,
} from '../../hooks/useConversationSession';

// ---------------------------------------------------------------------------
// Web Audio, faked at the seams the cue module reaches through `earcons.ts`.
// Deliberately its own copy rather than an import from `earcons.test.ts`:
// these two suites must be able to fail independently.
// ---------------------------------------------------------------------------

class FakeAudioParam {
  setValueAtTime = vi.fn(() => this);
  linearRampToValueAtTime = vi.fn(() => this);
}

class FakeOscillator {
  type: OscillatorType = 'sine';
  frequency = new FakeAudioParam();
  onended: (() => void) | null = null;
  connect = vi.fn();
  disconnect = vi.fn();
  start = vi.fn();
  stop = vi.fn();
}

class FakeGain {
  gain = new FakeAudioParam();
  connect = vi.fn();
  disconnect = vi.fn();
}

class FakeAudioContext {
  static instances: FakeAudioContext[] = [];

  currentTime = 0;
  state: AudioContextState = 'running';
  destination = {} as AudioDestinationNode;
  resume = vi.fn(() => {
    this.state = 'running';
    return Promise.resolve();
  });
  close = vi.fn(() => {
    this.state = 'closed';
    return Promise.resolve();
  });

  oscillators: FakeOscillator[] = [];
  gains: FakeGain[] = [];

  constructor() {
    FakeAudioContext.instances.push(this);
  }

  createOscillator(): OscillatorNode {
    const oscillator = new FakeOscillator();
    this.oscillators.push(oscillator);
    return oscillator as unknown as OscillatorNode;
  }

  createGain(): GainNode {
    const gain = new FakeGain();
    this.gains.push(gain);
    return gain as unknown as GainNode;
  }

  /** Let every scheduled tone reach its end, as the audio thread would. */
  finishAll(): void {
    this.oscillators.forEach((oscillator) => oscillator.onended?.());
  }
}

function installAudioContext(): void {
  Object.defineProperty(window, 'AudioContext', {
    value: FakeAudioContext,
    configurable: true,
    writable: true,
  });
}

function removeAudioContext(): void {
  Reflect.deleteProperty(window, 'AudioContext');
  Reflect.deleteProperty(window, 'webkitAudioContext');
}

/** Every oscillator any context built during this test. */
function allOscillators(): FakeOscillator[] {
  return FakeAudioContext.instances.flatMap((context) => context.oscillators);
}

// ---------------------------------------------------------------------------
// The phase and stop-reason unions, READ FROM THE HOOK'S OWN SOURCE.
//
// The table's keys are already type-checked against these unions, so this is a
// belt-and-braces cross-check — but it is the half that survives a build where
// nobody ran `tsc`, and it is the half that names the missing phase in the
// failure message instead of a `Record` type error four files away.
// ---------------------------------------------------------------------------

const hookSource = readFileSync(
  resolve(process.cwd(), 'src/hooks/useConversationSession.ts'),
  'utf8',
);

function unionMembers(name: string): string[] {
  const match = hookSource.match(
    new RegExp(`export type ${name} =([\\s\\S]*?);\\n`),
  );
  expect(match, `no \`export type ${name}\` found in the hook`).not.toBeNull();
  const body = match![1].replace(/\/\*[\s\S]*?\*\//g, '');
  const members = [...body.matchAll(/'([a-zA-Z_]+)'/g)].map((entry) => entry[1]);
  expect(members.length).toBeGreaterThan(1);
  return members;
}

const PHASES = unionMembers('ConversationPhase') as ConversationPhase[];
const STOP_REASONS = unionMembers(
  'ConversationStopReason',
) as ConversationStopReason[];

/** Every ordered pair, as `it.each` rows. */
const PAIRS = PHASES.flatMap((from) => PHASES.map((to) => ({ from, to })));

beforeEach(() => {
  FakeAudioContext.instances = [];
  closeSharedAudioContext();
  setEarconsEnabled(true);
  installAudioContext();
  vi.useFakeTimers();
});

afterEach(() => {
  stopProcessingPulse();
  closeSharedAudioContext();
  removeAudioContext();
  vi.useRealTimers();
});

describe('the cue table is exhaustive (claim 1)', () => {
  it('covers every phase the hook declares, as a source phase', () => {
    expect(Object.keys(CONVERSATION_TRANSITION_CUES).sort()).toEqual(
      [...PHASES].sort(),
    );
    // Seven today. Stated as the union's own length rather than as `7`, so the
    // eighth phase does not have to remember to come back and edit a literal.
    expect(PHASES).toContain('preparing');
  });

  it.each(PHASES)('covers every destination phase from %s', (from) => {
    expect(Object.keys(CONVERSATION_TRANSITION_CUES[from]).sort()).toEqual(
      [...PHASES].sort(),
    );
  });

  it('covers every stop reason the hook declares', () => {
    expect(Object.keys(CONVERSATION_EXIT_CUES).sort()).toEqual(
      [...STOP_REASONS].sort(),
    );
  });
});

describe('every transition is a decision, silence included (claim 2)', () => {
  it.each(PAIRS)('$from → $to carries a reason', ({ from, to }) => {
    const decision = CONVERSATION_TRANSITION_CUES[from][to];
    expect(decision.reason.trim().length).toBeGreaterThan(20);
  });

  it.each(STOP_REASONS)('the %s exit carries a reason', (reason) => {
    expect(CONVERSATION_EXIT_CUES[reason].reason.trim().length).toBeGreaterThan(
      20,
    );
  });

  it('names only cues that can actually be played', () => {
    const playable: ConversationCueName[] = [
      'start',
      'question',
      'listening',
      'captured',
      'advancing',
      'ended',
      'failed',
    ];
    for (const { from, to } of PAIRS) {
      const { cue } = CONVERSATION_TRANSITION_CUES[from][to];
      if (cue === null || cue === 'exit') continue;
      expect(playable).toContain(cue);
    }
    for (const reason of STOP_REASONS) {
      const { cue } = CONVERSATION_EXIT_CUES[reason];
      if (cue === null) continue;
      expect(playable).toContain(cue);
    }
  });
});

describe('the transitions a hands-free learner depends on', () => {
  it('cues the tap that starts a session', () => {
    // The gap this issue exists to close: `idle → preparing` happens BEFORE
    // `acquireStream()`, so a permission prompt or a slow device is a wait the
    // learner knows about. `useConversationSession.test.ts` asserts the
    // ordering against the real hook; this asserts the decision.
    expect(resolveConversationCue('idle', 'preparing')).toBe('start');
  });

  it('cues the top of a question from every phase that can reach it', () => {
    for (const from of PHASES) {
      expect(resolveConversationCue(from, 'speakingQuestion')).toBe('question');
    }
  });

  it('cues the otherwise silent advancing pause', () => {
    expect(resolveConversationCue('speakingAnswer', 'advancing')).toBe(
      'advancing',
    );
    expect(resolveConversationCue('processing', 'advancing')).toBe('advancing');
  });

  it('opens the microphone with the rising cue, including on a retry', () => {
    expect(resolveConversationCue('speakingQuestion', 'listening')).toBe(
      'listening',
    );
    // A nudge re-opening the microphone from `listening` itself, and from
    // `processing` after an empty transcript: both are a fresh turn.
    expect(resolveConversationCue('listening', 'listening')).toBe('listening');
    expect(resolveConversationCue('processing', 'listening')).toBe('listening');
  });

  it('says nothing over the verdict', () => {
    // The one silence worth defending: the accepted answer is read aloud the
    // instant this phase begins.
    expect(resolveConversationCue('processing', 'speakingAnswer')).toBeNull();
  });
});

describe('a normal end and a failure sound different (claim 3)', () => {
  it('gives the finished session the only "ended" cue', () => {
    expect(resolveConversationCue('advancing', 'idle', 'session_complete')).toBe(
      'ended',
    );
  });

  it.each([
    'capture_problem',
    'transcribe_unavailable',
    'grade_failed',
    'no_answer',
  ] as ConversationStopReason[])('gives %s the failure cue instead', (reason) => {
    const cue = resolveConversationCue('processing', 'idle', reason);
    expect(cue).toBe('failed');
    // The distinction is the whole point: a learner who missed the sentence
    // must not hear the same thing for "you finished" and "this broke".
    expect(cue).not.toBe(
      resolveConversationCue('advancing', 'idle', 'session_complete'),
    );
  });

  it('leaves both deliberate exits silent, exactly as they are unspoken', () => {
    expect(resolveConversationCue('listening', 'idle', 'learner')).toBeNull();
    expect(resolveConversationCue('listening', 'idle', 'typing')).toBeNull();
  });

  it('falls back to silence for an exit that names no reason', () => {
    // The safe direction: a future exit that forgets to say why must not tell
    // a learner their session failed when it did not.
    expect(resolveConversationCue('listening', 'idle')).toBeNull();
  });

  it.each(STOP_REASONS)(
    'never sounds for `idle → idle`, not even for %s',
    (reason) => {
      // A `finish()` reaching an already-idle machine (an unmount racing a
      // capture failure) must not make a session end a second time.
      expect(resolveConversationCue('idle', 'idle', reason)).toBeNull();
    },
  );
});

describe('the pulse belongs to `processing` (claim 4)', () => {
  it('starts on the way in and stops on the way out', () => {
    applyConversationCue('listening', 'processing');
    expect(isProcessingPulseRunning()).toBe(true);

    applyConversationCue('processing', 'speakingAnswer');
    expect(isProcessingPulseRunning()).toBe(false);
  });

  it.each(['idle', 'listening', 'advancing'] as ConversationPhase[])(
    'stops it on an exit from processing to %s',
    (to) => {
      applyConversationCue('listening', 'processing');
      applyConversationCue('processing', to, 'grade_failed');
      expect(isProcessingPulseRunning()).toBe(false);
    },
  );

  it('starts nothing for a transition that does not enter processing', () => {
    for (const { from, to } of PAIRS) {
      if (to === 'processing') continue;
      applyConversationCue(from, to, 'session_complete');
      expect(isProcessingPulseRunning()).toBe(false);
    }
  });

  it.each(PHASES.filter((phase) => phase !== 'processing'))(
    'reaches no pulse from %s, where none ever ran',
    (phase) => {
      // The `onsetTimeout` path is the real case: it arrives from `listening`,
      // where the pulse never started, and the old code stopped one anyway.
      // Asserted with a pulse deliberately RUNNING, because a guard that only
      // looks right when there is nothing to stop is not a guard — this proves
      // `silenceProcessingCue` does not reach the pulse from these phases,
      // rather than that stopping it happened to be harmless.
      applyConversationCue('listening', 'processing');
      expect(isProcessingPulseRunning()).toBe(true);

      silenceProcessingCue(phase);

      expect(isProcessingPulseRunning()).toBe(true);
    },
  );

  it('silences a pulse from inside processing, for the spoken nudge', () => {
    applyConversationCue('listening', 'processing');
    expect(isProcessingPulseRunning()).toBe(true);

    // A pulse beating under a spoken "I didn't catch that" is the nagging the
    // pulse's own descriptor warns about.
    silenceProcessingCue('processing');
    expect(isProcessingPulseRunning()).toBe(false);
  });
});

describe('cues off means no oscillator at all (claim 5)', () => {
  it('constructs nothing for any transition, or any exit', () => {
    setEarconsEnabled(false);
    expect(areEarconsEnabled()).toBe(false);

    for (const { from, to } of PAIRS) {
      for (const reason of STOP_REASONS) {
        applyConversationCue(from, to, reason);
      }
    }
    vi.advanceTimersByTime(10_000);

    // Not a silent oscillator, and not even a context: nothing was asked to
    // make a sound, so nothing was built to make one with.
    expect(FakeAudioContext.instances).toHaveLength(0);
    expect(allOscillators()).toHaveLength(0);
  });

  it('makes a sound again when the learner turns them back on', () => {
    setEarconsEnabled(false);
    applyConversationCue('idle', 'preparing');
    expect(allOscillators()).toHaveLength(0);

    setEarconsEnabled(true);
    applyConversationCue('idle', 'preparing');
    expect(allOscillators().length).toBeGreaterThan(0);
  });
});

describe('no audio is not an error, and nothing leaks (claim 6)', () => {
  it('no-ops every transition when there is no AudioContext at all', () => {
    closeSharedAudioContext();
    removeAudioContext();

    expect(() => {
      for (const { from, to } of PAIRS) {
        for (const reason of STOP_REASONS) {
          applyConversationCue(from, to, reason);
        }
      }
      silenceProcessingCue('processing');
      vi.advanceTimersByTime(5_000);
    }).not.toThrow();
  });

  it('no-ops every transition when the context is suspended', () => {
    // A context built before a user gesture starts suspended, and one whose
    // page was backgrounded can be suspended again. Both are inaudible, and
    // neither may throw on the path that was about to grade an answer.
    applyConversationCue('idle', 'preparing');
    const context = FakeAudioContext.instances[0];
    context.state = 'suspended';
    context.resume = vi.fn(() => Promise.reject(new Error('no gesture yet')));

    expect(() => {
      for (const { from, to } of PAIRS) {
        applyConversationCue(from, to, 'session_complete');
      }
    }).not.toThrow();
  });

  it('survives a half-implemented Web Audio that throws mid-cue', () => {
    applyConversationCue('idle', 'preparing');
    const context = FakeAudioContext.instances[0];
    vi.spyOn(context, 'createGain').mockImplementation(() => {
      throw new Error('not implemented in this webview');
    });

    expect(() => applyConversationCue('preparing', 'speakingQuestion')).not.toThrow();
  });

  it('disconnects every node it built, across a long session', () => {
    // Twenty questions' worth of the real loop, pulse included.
    for (let i = 0; i < 20; i += 1) {
      applyConversationCue('advancing', 'speakingQuestion');
      applyConversationCue('speakingQuestion', 'listening');
      applyConversationCue('listening', 'processing');
      vi.advanceTimersByTime(4_000);
      applyConversationCue('processing', 'speakingAnswer');
      applyConversationCue('speakingAnswer', 'advancing');
      FakeAudioContext.instances.forEach((context) => context.finishAll());
    }
    applyConversationCue('advancing', 'idle', 'session_complete');
    FakeAudioContext.instances.forEach((context) => context.finishAll());

    const built = allOscillators();
    expect(built.length).toBeGreaterThan(100);
    const live = built.filter(
      (oscillator) => oscillator.disconnect.mock.calls.length === 0,
    );
    expect(live).toHaveLength(0);
  });
});

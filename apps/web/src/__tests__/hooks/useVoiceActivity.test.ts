/**
 * `useVoiceActivity` — the state machine, driven by a synthetic level.
 *
 * Issue #309, epic #304 / E13. The suite is organised around the four claims
 * the hook makes that a hands-free loop cannot work without, and that nothing
 * else in the app would notice being broken:
 *
 *   1. THE BAR IS THE ROOM'S, NOT A CONSTANT. A louder room must produce a
 *      higher speech threshold. A regression here (an inverted ratio, a clamp
 *      the wrong way round) reaches a learner as "voice practice does not work
 *      outside" and never as a stack trace.
 *   2. A TIMEOUT IS NOT AN EMPTY RECORDING. Nobody speaking inside the onset
 *      window is its own named event, so the driver re-asks rather than
 *      transcribing and grading silence.
 *   3. A PAUSE IS NOT THE END OF A TURN. The hangover has to survive a dip in
 *      the middle of a sentence and end on a real silence.
 *   4. INTERRUPTING TAKES INTENT. Barge-in is dead during its arming delay and
 *      needs a strictly higher, longer-sustained level than ordinary onset —
 *      the mitigation for a phone speaker playing into its own microphone.
 *
 * =============================================================================
 * WHAT THIS SUITE DOES NOT TEST — AND CANNOT
 * =============================================================================
 *
 * Nothing acoustic. jsdom has no `AudioContext`, no microphone and no room, so
 * `createAnalyserLevelSource` is never exercised here beyond its "return null
 * rather than throw" contract, and no assertion below says anything about
 * whether these ratios and windows feel right against a real voice on a real
 * street. Spoken practice is verified by hand (`docs/specs/voice.md` §13 puts
 * the web voice components outside the API spec's tested contracts on
 * purpose). Read a green run as "the machine transitions correctly".
 */

import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  calibrateThresholds,
  createAnalyserLevelSource,
  useVoiceActivity,
  VOICE_ACTIVITY_BARGE_IN_ARMING_MS,
  VOICE_ACTIVITY_CALIBRATION_MS,
  VOICE_ACTIVITY_HANGOVER_MS,
  VOICE_ACTIVITY_MAX_DURATION_MS,
  VOICE_ACTIVITY_ONSET_TIMEOUT_MS,
  VOICE_ACTIVITY_POLL_INTERVAL_MS,
  type UseVoiceActivityOptions,
  type VoiceActivityEvent,
  type VoiceActivityLevelSource,
} from '../../hooks/useVoiceActivity';

// ---------------------------------------------------------------------------
// A room, faked at the one seam the hook exposes for it.
//
// `createLevelSource` is a real option with a real default, not a test hook —
// see the option's own doc comment. Everything below drives the machine by
// setting `room.level` and advancing the fake clock, which is the only way to
// test acoustic *logic* in an environment with no acoustics.
// ---------------------------------------------------------------------------

interface FakeRoom extends VoiceActivityLevelSource {
  level: number;
  reads: number;
  closes: number;
}

function makeRoom(initialLevel = 0): FakeRoom {
  const room: FakeRoom = {
    level: initialLevel,
    reads: 0,
    closes: 0,
    read: () => {
      room.reads += 1;
      return room.level;
    },
    close: () => {
      room.closes += 1;
    },
  };
  return room;
}

const FAKE_STREAM = {
  getTracks: () => [],
} as unknown as MediaStream;

interface Harness {
  events: VoiceActivityEvent[];
  room: FakeRoom;
}

function setup(
  room: FakeRoom,
  overrides: Partial<UseVoiceActivityOptions> = {},
): {
  harness: Harness;
  result: { current: ReturnType<typeof useVoiceActivity> };
  unmount: () => void;
} {
  const events: VoiceActivityEvent[] = [];
  const { result, unmount } = renderHook(() =>
    useVoiceActivity({
      stream: FAKE_STREAM,
      onEvent: (event) => events.push(event),
      createLevelSource: () => room,
      // Exercising the injectable clock rather than the implicit default: the
      // fake timers below move `Date.now` with them, so time in this suite is
      // pinned rather than slept through.
      now: () => Date.now(),
      ...overrides,
    }),
  );
  return { harness: { events, room }, result, unmount };
}

/** Advance the fake clock, letting every interval tick settle inside `act`. */
function advance(ms: number): void {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------

describe('calibrateThresholds', () => {
  it('raises the speech bar for a louder room, at every level', () => {
    const floors = [0, 0.01, 0.02, 0.05, 0.1, 0.2, 0.35, 0.5];
    const onsets = floors.map((floor) => calibrateThresholds(floor).onset);

    for (let i = 1; i < onsets.length; i += 1) {
      // Strictly, not merely "not lower": a plateau over the useful range
      // would mean the calibration stopped adapting where it matters most.
      expect(onsets[i]).toBeGreaterThan(onsets[i - 1]);
    }
  });

  it('keeps a bar above zero even in a silent room', () => {
    // A pure multiplier would put the bar at 0 here, and every faint hiss
    // would read as the learner speaking.
    expect(calibrateThresholds(0).onset).toBeGreaterThan(0);
  });

  it('puts barge-in strictly above onset for every possible floor', () => {
    // Including the far end, where BOTH values are capped by their ceilings —
    // the case a single shared ceiling would have collapsed into equality.
    for (const floor of [0, 0.01, 0.1, 0.3, 0.5, 0.75, 1, 5]) {
      const thresholds = calibrateThresholds(floor);
      expect(thresholds.bargeIn).toBeGreaterThan(thresholds.onset);
      // And staying in speech is easier than starting it — hysteresis.
      expect(thresholds.release).toBeLessThan(thresholds.onset);
    }
  });

  it('treats a nonsense floor as silence rather than propagating it', () => {
    expect(calibrateThresholds(Number.NaN).noiseFloor).toBe(0);
    expect(calibrateThresholds(-1).noiseFloor).toBe(0);
  });
});

describe('calibration through the hook', () => {
  it('measures the room on arming, and a loud room gets a higher bar', () => {
    const quiet = setup(makeRoom(0.01));
    act(() => quiet.result.current.arm('listening'));
    expect(quiet.result.current.state.status).toBe('calibrating');
    expect(quiet.result.current.state.thresholds).toBeNull();

    advance(VOICE_ACTIVITY_CALIBRATION_MS);
    const quietThresholds = quiet.result.current.state.thresholds;
    expect(quiet.result.current.state.status).toBe('listening');
    expect(quietThresholds?.noiseFloor).toBeCloseTo(0.01, 5);

    const loud = setup(makeRoom(0.25));
    act(() => loud.result.current.arm('listening'));
    advance(VOICE_ACTIVITY_CALIBRATION_MS);
    const loudThresholds = loud.result.current.state.thresholds;
    expect(loudThresholds?.noiseFloor).toBeCloseTo(0.25, 5);

    // THE CLAIM OF THE WHOLE FILE: the same voice needs a higher level to be
    // heard on a busy street than in a quiet room.
    expect(loudThresholds!.onset).toBeGreaterThan(quietThresholds!.onset);
    expect(quietThresholds!.onset).toBeCloseTo(calibrateThresholds(0.01).onset, 5);
    expect(loudThresholds!.onset).toBeCloseTo(calibrateThresholds(0.25).onset, 5);
  });

  it('takes the median, so one door slam does not become the room', () => {
    const room = makeRoom(0.01);
    const { result } = setup(room);
    act(() => result.current.arm('listening'));

    // One very loud sample in the middle of an otherwise quiet window.
    advance(VOICE_ACTIVITY_POLL_INTERVAL_MS * 4);
    room.level = 0.9;
    advance(VOICE_ACTIVITY_POLL_INTERVAL_MS);
    room.level = 0.01;
    advance(VOICE_ACTIVITY_CALIBRATION_MS);

    expect(result.current.state.thresholds?.noiseFloor).toBeCloseTo(0.01, 5);
  });

  it('fires nothing at all while it is still calibrating', () => {
    const room = makeRoom(0.9);
    const { harness, result } = setup(room);
    act(() => result.current.arm('listening'));

    advance(VOICE_ACTIVITY_CALIBRATION_MS - VOICE_ACTIVITY_POLL_INTERVAL_MS);
    expect(harness.events).toEqual([]);
    expect(result.current.state.status).toBe('calibrating');
  });
});

describe('onset', () => {
  it('reports speech starting once it is sustained', () => {
    const room = makeRoom(0.01);
    const { harness, result } = setup(room);

    act(() => result.current.arm('listening'));
    advance(VOICE_ACTIVITY_CALIBRATION_MS);
    expect(harness.events).toEqual([]);

    room.level = 0.5;
    advance(300);

    expect(harness.events.map((e) => e.type)).toEqual(['onset']);
    expect(result.current.state.status).toBe('speaking');
    // Not terminal — the turn is now running and the loop is still armed.
    expect(result.current.isArmed).toBe(true);
  });

  it('is not started by a single loud sample', () => {
    const room = makeRoom(0.01);
    const { harness, result } = setup(room);

    act(() => result.current.arm('listening'));
    advance(VOICE_ACTIVITY_CALIBRATION_MS);

    // A tap on the phone, a door: over the bar for one poll, gone the next.
    room.level = 0.8;
    advance(VOICE_ACTIVITY_POLL_INTERVAL_MS);
    room.level = 0.01;
    advance(1_000);

    expect(harness.events.map((e) => e.type)).not.toContain('onset');
    expect(result.current.state.status).toBe('listening');
  });

  it('reports a TIMEOUT, not an empty turn, when nobody speaks', () => {
    const room = makeRoom(0.01);
    const { harness, result } = setup(room);

    act(() => result.current.arm('listening'));
    advance(VOICE_ACTIVITY_ONSET_TIMEOUT_MS);

    expect(harness.events).toHaveLength(1);
    const event = harness.events[0];
    expect(event.type).toBe('onsetTimeout');
    if (event.type !== 'onsetTimeout') throw new Error('unreachable');
    expect(event.waitedMs).toBeGreaterThanOrEqual(VOICE_ACTIVITY_ONSET_TIMEOUT_MS);

    // Terminal: the hook disarms itself and releases the audio graph, so the
    // driver only has to decide what to say next.
    expect(result.current.state.status).toBe('idle');
    expect(result.current.isArmed).toBe(false);
    expect(harness.room.closes).toBe(1);
  });

  it('does not time out on somebody who started speaking in time', () => {
    const room = makeRoom(0.01);
    const { harness, result } = setup(room);

    act(() => result.current.arm('listening'));
    advance(VOICE_ACTIVITY_CALIBRATION_MS);
    room.level = 0.5;
    advance(VOICE_ACTIVITY_ONSET_TIMEOUT_MS);

    expect(harness.events.map((e) => e.type)).toEqual(['onset']);
    expect(result.current.state.status).toBe('speaking');
  });
});

describe('end of turn', () => {
  /** Arm, calibrate against a quiet room, and get past onset. */
  function speakUp(room: FakeRoom) {
    const harness = setup(room);
    act(() => harness.result.current.arm('listening'));
    advance(VOICE_ACTIVITY_CALIBRATION_MS);
    room.level = 0.5;
    advance(300);
    expect(harness.harness.events.map((e) => e.type)).toEqual(['onset']);
    return harness;
  }

  it('ends the turn after a full hangover of silence', () => {
    const room = makeRoom(0.01);
    const { harness, result } = speakUp(room);

    room.level = 0;
    advance(VOICE_ACTIVITY_HANGOVER_MS + VOICE_ACTIVITY_POLL_INTERVAL_MS * 2);

    const event = harness.events.at(-1)!;
    expect(event.type).toBe('endOfTurn');
    if (event.type !== 'endOfTurn') throw new Error('unreachable');
    expect(event.speechDurationMs).toBeGreaterThan(0);
    expect(event.speechStartedAt).toBeLessThan(event.at);
    expect(result.current.state.status).toBe('idle');
    expect(room.closes).toBe(1);
  });

  it('does NOT end the turn on a pause inside a sentence', () => {
    const room = makeRoom(0.01);
    const { harness, result } = speakUp(room);

    // A gap between two clauses — long, but short of the hangover.
    room.level = 0;
    advance(VOICE_ACTIVITY_HANGOVER_MS - 200);
    expect(harness.events.map((e) => e.type)).toEqual(['onset']);
    expect(result.current.state.status).toBe('speaking');

    // ...and the learner carries on. The clock has to restart, not resume.
    room.level = 0.5;
    advance(500);
    room.level = 0;
    advance(VOICE_ACTIVITY_HANGOVER_MS - 200);
    expect(harness.events.map((e) => e.type)).toEqual(['onset']);

    advance(400);
    expect(harness.events.map((e) => e.type)).toEqual(['onset', 'endOfTurn']);
  });

  it('treats a quiet syllable as still speaking (hysteresis)', () => {
    const room = makeRoom(0.01);
    const { harness } = speakUp(room);

    // Below the ONSET bar but above the RELEASE bar: a trailing consonant, not
    // a silence. Without hysteresis the hangover clock would be running here.
    const thresholds = calibrateThresholds(0.01);
    const betweenBars = (thresholds.release + thresholds.onset) / 2;
    expect(betweenBars).toBeLessThan(thresholds.onset);
    expect(betweenBars).toBeGreaterThan(thresholds.release);

    room.level = betweenBars;
    advance(VOICE_ACTIVITY_HANGOVER_MS * 2);
    expect(harness.events.map((e) => e.type)).toEqual(['onset']);
  });

  it('stops at the 120 s cap even if the learner never stops', () => {
    const room = makeRoom(0.01);
    const { harness, result } = speakUp(room);

    room.level = 0.5;
    advance(VOICE_ACTIVITY_MAX_DURATION_MS);

    const types = harness.events.map((e) => e.type);
    expect(types).toEqual(['onset', 'maxDuration']);
    const event = harness.events.at(-1)!;
    if (event.type !== 'maxDuration') throw new Error('unreachable');
    // Measured from arming, not from onset: the recording the loop is making
    // alongside this started when the hook was armed, and the server's own
    // 120 s cap is on that recording.
    expect(event.durationMs).toBeGreaterThanOrEqual(VOICE_ACTIVITY_MAX_DURATION_MS);
    expect(event.at - event.armedAt).toBe(event.durationMs);
    expect(result.current.state.status).toBe('idle');
  });
});

describe('barge-in', () => {
  const CALIBRATION_MS = 100;
  const SUSTAIN_MS = 100;
  const QUIET = 0.02;

  function watch(room: FakeRoom) {
    const harness = setup(room, {
      calibrationMs: CALIBRATION_MS,
      bargeInSustainMs: SUSTAIN_MS,
    });
    act(() => harness.result.current.arm('barge-in'));
    advance(CALIBRATION_MS);
    expect(harness.result.current.state.status).toBe('watching');
    return harness;
  }

  it('ignores everything during the arming delay', () => {
    const room = makeRoom(QUIET);
    const { harness, result } = watch(room);

    // Loud enough and sustained long enough to interrupt — and much earlier
    // than the arming delay, which is exactly the coach's own first syllable
    // arriving back through the phone's microphone.
    room.level = 0.9;
    advance(VOICE_ACTIVITY_BARGE_IN_ARMING_MS - CALIBRATION_MS - 50);
    expect(harness.events).toEqual([]);
    expect(result.current.state.status).toBe('watching');

    // Past the delay, the sustain clock starts fresh and then it fires.
    advance(SUSTAIN_MS + 100);
    expect(harness.events.map((e) => e.type)).toEqual(['bargeIn']);
    expect(result.current.state.status).toBe('idle');
    expect(room.closes).toBe(1);
  });

  it('needs a louder voice than ordinary onset would', () => {
    const room = makeRoom(QUIET);
    const { harness, result } = watch(room);

    const thresholds = result.current.state.thresholds!;
    const wouldStartATurn = (thresholds.onset + thresholds.bargeIn) / 2;
    expect(wouldStartATurn).toBeGreaterThan(thresholds.onset);
    expect(wouldStartATurn).toBeLessThan(thresholds.bargeIn);

    // A cough, a car horn, somebody talking nearby: over the bar that would
    // have started a turn, and held there for a long time. The coach keeps
    // talking, because interrupting is supposed to take intent.
    room.level = wouldStartATurn;
    advance(VOICE_ACTIVITY_BARGE_IN_ARMING_MS + SUSTAIN_MS * 10);
    expect(harness.events).toEqual([]);

    // The learner actually speaking up does interrupt.
    room.level = 0.9;
    advance(SUSTAIN_MS + 100);
    expect(harness.events.map((e) => e.type)).toEqual(['bargeIn']);
  });

  it('needs the loud stretch to be sustained, not a spike', () => {
    const room = makeRoom(QUIET);
    const { harness } = watch(room);

    advance(VOICE_ACTIVITY_BARGE_IN_ARMING_MS);
    room.level = 0.9;
    advance(VOICE_ACTIVITY_POLL_INTERVAL_MS);
    room.level = QUIET;
    advance(1_000);

    expect(harness.events).toEqual([]);
  });

  it('never reports an onset, a timeout or an end of turn while watching', () => {
    const room = makeRoom(QUIET);
    const { harness } = watch(room);

    // Nothing at all for well past the onset window: the coach is talking, so
    // "the learner has not started speaking" is not news and must not nudge.
    room.level = QUIET;
    advance(VOICE_ACTIVITY_ONSET_TIMEOUT_MS * 2);
    expect(harness.events).toEqual([]);
  });
});

describe('teardown', () => {
  it('closes the level source and stops the loop on unmount', () => {
    const room = makeRoom(0.01);
    const { result, unmount } = setup(room);

    act(() => result.current.arm('listening'));
    advance(VOICE_ACTIVITY_CALIBRATION_MS);
    const readsWhileArmed = room.reads;
    expect(readsWhileArmed).toBeGreaterThan(0);

    unmount();

    expect(room.closes).toBe(1);
    // No interval left behind — nothing to leak and nothing to keep reading a
    // graph whose stream the capture hook is about to stop.
    expect(vi.getTimerCount()).toBe(0);
    advance(5_000);
    expect(room.reads).toBe(readsWhileArmed);
  });

  it('closes the level source on an explicit disarm, and emits nothing', () => {
    const room = makeRoom(0.01);
    const { harness, result } = setup(room);

    act(() => result.current.arm('listening'));
    advance(VOICE_ACTIVITY_CALIBRATION_MS);
    act(() => result.current.disarm());

    expect(room.closes).toBe(1);
    expect(harness.events).toEqual([]);
    expect(result.current.state.status).toBe('idle');
    expect(result.current.isArmed).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('re-arming releases the previous source before opening another', () => {
    const room = makeRoom(0.01);
    const { result } = setup(room);

    act(() => result.current.arm('listening'));
    advance(VOICE_ACTIVITY_CALIBRATION_MS);
    act(() => result.current.arm('barge-in'));

    expect(room.closes).toBe(1);
    expect(result.current.state.status).toBe('calibrating');
    expect(result.current.state.mode).toBe('barge-in');
  });
});

describe('when it cannot listen at all', () => {
  it('is inert with no stream, rather than throwing', () => {
    const room = makeRoom(0.01);
    const { harness, result } = setup(room, { stream: null });

    act(() => result.current.arm('listening'));

    expect(result.current.state.status).toBe('unavailable');
    expect(result.current.isArmed).toBe(false);
    advance(10_000);
    expect(harness.events).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('is inert where the Web Audio API does not exist — jsdom, here', () => {
    // No `createLevelSource` override, so this takes the production default,
    // in an environment with no `AudioContext` at all. That is the whole
    // contract being checked: a no-op, not an exception in a learner's face.
    expect((window as { AudioContext?: unknown }).AudioContext).toBeUndefined();
    expect(createAnalyserLevelSource(FAKE_STREAM)).toBeNull();

    const events: VoiceActivityEvent[] = [];
    const { result } = renderHook(() =>
      useVoiceActivity({
        stream: FAKE_STREAM,
        onEvent: (event) => events.push(event),
      }),
    );

    act(() => result.current.arm('listening'));
    expect(result.current.state.status).toBe('unavailable');
    advance(10_000);
    expect(events).toEqual([]);
  });
});

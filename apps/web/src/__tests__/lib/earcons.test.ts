/**
 * Earcons — the four promises the module makes that are invisible when broken.
 *
 * Issue #310, epic #304 / E13. Each of these fails silently in exactly the
 * situation it matters, which is why they are asserted rather than reviewed:
 *
 *   1. NOTHING IS LOADED. The cues are synthesised, so there is no request to
 *      be slow, no cache to miss and no asset to 404. A future edit that
 *      "simplifies" a cue into an imported sound file would reintroduce
 *      first-play latency at the exact moment the cue matters most — a
 *      learner's first hands-free session — and nothing else would notice.
 *   2. NO AUDIO API IS NOT AN ERROR. jsdom, an older Safari, a locked context.
 *      A missing sound must never throw on the path that was about to grade
 *      somebody's answer.
 *   3. NODES ARE DISCONNECTED AFTER THEY SOUND. A half-hour session pulses
 *      well over a thousand times; nodes left attached to the destination live
 *      as long as the page does.
 *   4. THE SWITCH IS ONE SWITCH. `setEarconsEnabled(false)` silences the whole
 *      module, including a pulse already running — a learner who turned sounds
 *      off and still hears them is a bug nobody with sounds on can see.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  CAPTURED_EARCON,
  LISTENING_EARCON,
  PROCESSING_PULSE_EARCON,
  areEarconsEnabled,
  closeSharedAudioContext,
  getSharedAudioContext,
  isProcessingPulseRunning,
  playCapturedEarcon,
  playEarcon,
  playListeningEarcon,
  setEarconsEnabled,
  startProcessingPulse,
  startPulse,
  stopProcessingPulse,
} from '../../lib/earcons';

// ---------------------------------------------------------------------------
// Web Audio, faked at the handful of seams the module actually touches.
//
// `stop()` deliberately does NOT fire `onended`: a real oscillator ends when
// the audio thread reaches the scheduled time, not when it is scheduled. Tests
// call `finishAll()` to advance past that, so "disconnected after playing" is
// asserted against the real ordering rather than a convenient one.
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

/** The context the module built for itself, as our fake. */
function currentFake(): FakeAudioContext {
  const context = getSharedAudioContext();
  expect(context).not.toBeNull();
  return context as unknown as FakeAudioContext;
}

beforeEach(() => {
  FakeAudioContext.instances = [];
  closeSharedAudioContext();
  setEarconsEnabled(true);
  installAudioContext();
});

afterEach(() => {
  stopProcessingPulse();
  closeSharedAudioContext();
  removeAudioContext();
  vi.useRealTimers();
});

describe('earcons — the cue surface', () => {
  it('exposes each cue as a named export, and no call site builds a tone', () => {
    expect(typeof playListeningEarcon).toBe('function');
    expect(typeof playCapturedEarcon).toBe('function');
    expect(typeof startProcessingPulse).toBe('function');
    expect(typeof stopProcessingPulse).toBe('function');

    // The descriptors are data: a later swap to designed sounds changes these
    // and this file, and nothing at any call site.
    expect(LISTENING_EARCON.tones.length).toBeGreaterThan(1);
    expect(CAPTURED_EARCON.tones.length).toBeGreaterThan(1);
    expect(PROCESSING_PULSE_EARCON.intervalMs).toBeGreaterThan(0);
  });

  it('rises for "listening" and falls for "got it" — the direction is the message', () => {
    const listening = LISTENING_EARCON.tones.map((tone) => tone.frequency);
    const captured = CAPTURED_EARCON.tones.map((tone) => tone.frequency);

    expect(listening[listening.length - 1]).toBeGreaterThan(listening[0]);
    expect(captured[captured.length - 1]).toBeLessThan(captured[0]);
  });

  it('keeps the repeating pulse quieter than either edge cue', () => {
    // A cue that repeats a dozen times during a grader call at notification
    // volume stops being reassurance within about three ticks.
    const pulseGain = PROCESSING_PULSE_EARCON.pulse.tones[0].gain;
    expect(pulseGain).toBeLessThan(LISTENING_EARCON.tones[0].gain);
    expect(pulseGain).toBeLessThan(CAPTURED_EARCON.tones[0].gain);
  });
});

describe('earcons — nothing is loaded', () => {
  // Vitest runs with the web workspace as its root, so this resolves from
  // there. A moved file fails loudly here rather than quietly asserting
  // nothing, which is the only failure mode worth guarding against.
  const source = readFileSync(
    resolve(process.cwd(), 'src/lib/earcons.ts'),
    'utf8',
  );

  /**
   * Prose argues about fetches and audio files; code must not perform them.
   * Comments are stripped so the assertions below read the implementation and
   * not the header that explains why the implementation looks like this.
   */
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

  it('imports nothing at all — no module, and no asset', () => {
    expect(code).not.toMatch(/^\s*import\s/m);
    expect(code).not.toMatch(/\bimport\s*\(/);
    expect(code).not.toMatch(/\brequire\s*\(/);
  });

  it('makes no network request and constructs no media element', () => {
    expect(code).not.toMatch(/\bfetch\s*\(/);
    expect(code).not.toMatch(/XMLHttpRequest/);
    expect(code).not.toMatch(/new\s+Audio\s*\(/);
    expect(code).not.toMatch(/document\.createElement/);
    expect(code).not.toMatch(/\.(mp3|wav|ogg|m4a|aac|flac)\b/i);
  });

  it('synthesises every tone with an oscillator instead', () => {
    expect(code).toMatch(/createOscillator\s*\(/);
    expect(code).toMatch(/createGain\s*\(/);
  });

  it('makes no request at runtime either, when a cue actually plays', () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    playListeningEarcon();
    playCapturedEarcon();

    expect(fetchSpy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});

describe('earcons — no AudioContext is not an error', () => {
  beforeEach(() => {
    closeSharedAudioContext();
    removeAudioContext();
  });

  it('returns null from the shared accessor rather than throwing', () => {
    expect(getSharedAudioContext()).toBeNull();
  });

  it('no-ops every cue, without throwing', () => {
    expect(() => playListeningEarcon()).not.toThrow();
    expect(() => playCapturedEarcon()).not.toThrow();
    expect(() => playEarcon(LISTENING_EARCON)).not.toThrow();
    expect(() => {
      const pulse = startProcessingPulse();
      pulse.stop();
      stopProcessingPulse();
    }).not.toThrow();
  });

  it('no-ops when the constructor exists but refuses to build a context', () => {
    Object.defineProperty(window, 'AudioContext', {
      value: function ThrowingAudioContext() {
        throw new Error('autoplay policy');
      },
      configurable: true,
      writable: true,
    });

    expect(getSharedAudioContext()).toBeNull();
    expect(() => playListeningEarcon()).not.toThrow();
  });
});

describe('earcons — the shared context', () => {
  it('builds exactly one context and hands the same one to every caller', () => {
    playListeningEarcon();
    playCapturedEarcon();
    const shared = getSharedAudioContext();

    expect(FakeAudioContext.instances).toHaveLength(1);
    expect(shared).toBe(FakeAudioContext.instances[0]);
  });

  it('builds nothing at import time — only on first use', () => {
    // `beforeEach` closed the context and cleared the instance list; importing
    // the module happened long before that and must not have built one.
    expect(FakeAudioContext.instances).toHaveLength(0);
    playListeningEarcon();
    expect(FakeAudioContext.instances).toHaveLength(1);
  });

  it('resumes a suspended context defensively', () => {
    const context = currentFake();
    context.state = 'suspended';

    playListeningEarcon();

    expect(context.resume).toHaveBeenCalled();
  });

  it('replaces a closed context instead of playing into it', () => {
    const first = currentFake();
    first.state = 'closed';

    playListeningEarcon();

    expect(FakeAudioContext.instances).toHaveLength(2);
    expect(FakeAudioContext.instances[1].oscillators).toHaveLength(
      LISTENING_EARCON.tones.length,
    );
  });
});

describe('earcons — playing and cleaning up', () => {
  it('schedules one oscillator per tone, wired through a gain to the output', () => {
    playListeningEarcon();
    const context = currentFake();

    expect(context.oscillators).toHaveLength(LISTENING_EARCON.tones.length);
    context.oscillators.forEach((oscillator, index) => {
      expect(oscillator.start).toHaveBeenCalled();
      expect(oscillator.stop).toHaveBeenCalled();
      expect(oscillator.connect).toHaveBeenCalledWith(context.gains[index]);
    });
    context.gains.forEach((gain) => {
      expect(gain.connect).toHaveBeenCalledWith(context.destination);
    });
  });

  it('disconnects both nodes once a tone has finished sounding', () => {
    playListeningEarcon();
    const context = currentFake();

    // Still sounding: nothing may be torn down yet.
    context.oscillators.forEach((oscillator) => {
      expect(oscillator.disconnect).not.toHaveBeenCalled();
    });

    context.finishAll();

    context.oscillators.forEach((oscillator) => {
      expect(oscillator.disconnect).toHaveBeenCalled();
    });
    context.gains.forEach((gain) => {
      expect(gain.disconnect).toHaveBeenCalled();
    });
  });

  it('leaks nothing across a long run of cues', () => {
    for (let i = 0; i < 50; i += 1) {
      playCapturedEarcon();
      currentFake().finishAll();
    }

    const context = currentFake();
    const live = context.oscillators.filter(
      (oscillator) => oscillator.disconnect.mock.calls.length === 0,
    );
    expect(live).toHaveLength(0);
  });

  it('survives a half-implemented Web Audio that throws mid-cue', () => {
    const context = currentFake();
    vi.spyOn(context, 'createGain').mockImplementation(() => {
      throw new Error('not implemented in this webview');
    });

    expect(() => playListeningEarcon()).not.toThrow();
  });
});

describe('earcons — the processing pulse', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('sounds immediately and then repeats on its interval', () => {
    const handle = startProcessingPulse();
    const context = currentFake();
    const perTick = PROCESSING_PULSE_EARCON.pulse.tones.length;

    // Immediately, not after one interval: the silence it covers starts now.
    expect(context.oscillators).toHaveLength(perTick);

    vi.advanceTimersByTime(PROCESSING_PULSE_EARCON.intervalMs * 3);
    expect(context.oscillators).toHaveLength(perTick * 4);

    handle.stop();
    vi.advanceTimersByTime(PROCESSING_PULSE_EARCON.intervalMs * 5);
    expect(context.oscillators).toHaveLength(perTick * 4);
  });

  it('is stoppable by a cleanup path that never saw the handle', () => {
    startProcessingPulse();
    expect(isProcessingPulseRunning()).toBe(true);

    stopProcessingPulse();
    expect(isProcessingPulseRunning()).toBe(false);

    const context = currentFake();
    const before = context.oscillators.length;
    vi.advanceTimersByTime(PROCESSING_PULSE_EARCON.intervalMs * 4);
    expect(context.oscillators).toHaveLength(before);
  });

  it('does not layer a second pulse over a running one', () => {
    startProcessingPulse();
    startProcessingPulse();
    const context = currentFake();

    vi.advanceTimersByTime(PROCESSING_PULSE_EARCON.intervalMs * 2);

    const perTick = PROCESSING_PULSE_EARCON.pulse.tones.length;
    expect(context.oscillators).toHaveLength(perTick * 3);
  });

  it('is safe to stop twice', () => {
    const handle = startProcessingPulse();
    handle.stop();
    expect(() => handle.stop()).not.toThrow();
    expect(() => stopProcessingPulse()).not.toThrow();
  });
});

describe('earcons — the single switch', () => {
  it('plays nothing at all once disabled', () => {
    setEarconsEnabled(false);
    expect(areEarconsEnabled()).toBe(false);

    playListeningEarcon();
    playCapturedEarcon();
    playEarcon(CAPTURED_EARCON);
    startPulse(PROCESSING_PULSE_EARCON);

    // Not even a context: nothing was asked to make a sound.
    expect(FakeAudioContext.instances).toHaveLength(0);
  });

  it('silences a pulse that is already running', () => {
    vi.useFakeTimers();
    startProcessingPulse();
    const context = currentFake();
    const before = context.oscillators.length;

    setEarconsEnabled(false);
    vi.advanceTimersByTime(PROCESSING_PULSE_EARCON.intervalMs * 4);

    expect(context.oscillators).toHaveLength(before);
    expect(isProcessingPulseRunning()).toBe(false);
  });

  it('comes back when re-enabled', () => {
    setEarconsEnabled(false);
    playListeningEarcon();
    expect(FakeAudioContext.instances).toHaveLength(0);

    setEarconsEnabled(true);
    playListeningEarcon();
    expect(FakeAudioContext.instances).toHaveLength(1);
  });
});

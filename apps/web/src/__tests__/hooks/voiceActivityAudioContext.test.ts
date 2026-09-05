/**
 * ONE `AudioContext` FOR THE WHOLE PAGE — issue #347, epic #345.
 *
 * `lib/earcons.ts` states the rule at its own export: the voice-activity
 * detector must attach its `AnalyserNode` to THE SHARED CONTEXT, because two
 * contexts means two audio devices open, two suspend/resume lifecycles to keep
 * in step, and on some platforms the second `new AudioContext()` simply fails.
 * Until #347 `useVoiceActivity` built its own, `getSharedAudioContext` had no
 * caller outside `earcons.ts` at all, and nothing in the app resumed the
 * detector's context — a suspended one hands `getFloatTimeDomainData` a buffer
 * of zeros, which a detector reads as a room in which nobody ever spoke.
 *
 * This file drives the two modules TOGETHER, the way a hands-free session does:
 * a cue, then a turn's analyser, then a cue, then the next turn's analyser, for
 * several turns. `useVoiceActivity.test.ts` cannot cover it — the hook is armed
 * there with an injected level source, which is the seam that exists precisely
 * so the machine can be tested without any of this — and `earcons.test.ts`
 * cannot either, because it never touches the detector. The claim spans both,
 * so the test does.
 *
 * The companion source-reading assertions ("the context is borrowed, never
 * built") live in `useVoiceActivity.test.ts`: jsdom has no `AudioContext`, so a
 * second `new AudioContext()` in that file would fail exactly as the shared
 * getter returning null does, and no behavioural test could tell them apart.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  closeSharedAudioContext,
  playCapturedEarcon,
  playListeningEarcon,
  setEarconsEnabled,
  startProcessingPulse,
  stopProcessingPulse,
} from '../../lib/earcons';
import { createAnalyserLevelSource } from '../../hooks/useVoiceActivity';

// ---------------------------------------------------------------------------
// Web Audio, faked at the seams BOTH modules touch — the tone nodes earcons
// builds and the analyser graph the detector builds, on one class, because the
// whole point is that they are one context.
// ---------------------------------------------------------------------------

class FakeAudioParam {
  setValueAtTime = vi.fn(() => this);
  linearRampToValueAtTime = vi.fn(() => this);
}

class FakeNode {
  connect = vi.fn();
  disconnect = vi.fn();
}

class FakeOscillator extends FakeNode {
  type: OscillatorType = 'sine';
  frequency = new FakeAudioParam();
  onended: (() => void) | null = null;
  start = vi.fn();
  stop = vi.fn();
}

class FakeGain extends FakeNode {
  gain = new FakeAudioParam();
}

class FakeAnalyser extends FakeNode {
  fftSize = 2048;
  getFloatTimeDomainData = vi.fn((buffer: Float32Array) => {
    // A steady, quiet tone: enough that a read is a number rather than zero.
    for (let i = 0; i < buffer.length; i += 1) buffer[i] = 0.01;
  });
}

class FakeAudioContext {
  static instances: FakeAudioContext[] = [];

  currentTime = 0;
  state: AudioContextState = 'running';
  destination = {} as AudioDestinationNode;
  analysers: FakeAnalyser[] = [];
  sources: FakeNode[] = [];

  resume = vi.fn(() => {
    this.state = 'running';
    return Promise.resolve();
  });
  close = vi.fn(() => {
    this.state = 'closed';
    return Promise.resolve();
  });

  constructor() {
    FakeAudioContext.instances.push(this);
  }

  createOscillator(): OscillatorNode {
    return new FakeOscillator() as unknown as OscillatorNode;
  }

  createGain(): GainNode {
    return new FakeGain() as unknown as GainNode;
  }

  createAnalyser(): AnalyserNode {
    const analyser = new FakeAnalyser();
    this.analysers.push(analyser);
    return analyser as unknown as AnalyserNode;
  }

  createMediaStreamSource(): MediaStreamAudioSourceNode {
    const source = new FakeNode();
    this.sources.push(source);
    return source as unknown as MediaStreamAudioSourceNode;
  }
}

const STREAM = { getTracks: () => [] } as unknown as MediaStream;

function contexts(): FakeAudioContext[] {
  return FakeAudioContext.instances;
}

beforeEach(() => {
  FakeAudioContext.instances = [];
  closeSharedAudioContext();
  setEarconsEnabled(true);
  Object.defineProperty(window, 'AudioContext', {
    value: FakeAudioContext,
    configurable: true,
    writable: true,
  });
});

afterEach(() => {
  stopProcessingPulse();
  closeSharedAudioContext();
  Reflect.deleteProperty(window, 'AudioContext');
  Reflect.deleteProperty(window, 'webkitAudioContext');
  vi.useRealTimers();
});

describe('one AudioContext across a whole conversation session', () => {
  it('opens exactly one audio device, however many turns and cues there are', () => {
    // Five turns of the real sequence: the question's cue, the detector
    // listening, the captured cue, the processing pulse — then the next turn.
    for (let turn = 0; turn < 5; turn += 1) {
      playListeningEarcon();

      const level = createAnalyserLevelSource(STREAM);
      expect(level).not.toBeNull();
      expect(level!.read()).toBeCloseTo(0.01, 6);

      playCapturedEarcon();
      startProcessingPulse();
      stopProcessingPulse();

      // The turn ends and the detector disarms, which closes ITS source.
      level!.close?.();
    }

    expect(contexts()).toHaveLength(1);
  });

  it('closes no context on disarm — the earcons still need it', () => {
    const level = createAnalyserLevelSource(STREAM);
    expect(level).not.toBeNull();

    level!.close?.();

    // The nodes go; the device does not. A detector that closed the shared
    // context would silence every cue on the page and leave the next arm
    // building an analyser on a dead graph.
    const context = contexts()[0];
    expect(context.close).not.toHaveBeenCalled();
    expect(context.state).not.toBe('closed');
    expect(context.sources[0].disconnect).toHaveBeenCalled();
    expect(context.analysers[0].disconnect).toHaveBeenCalled();

    // And the next turn still works, on the same device.
    const next = createAnalyserLevelSource(STREAM);
    expect(next).not.toBeNull();
    expect(contexts()).toHaveLength(1);
  });

  it('RESUMES a suspended context rather than reading its silence', () => {
    // The failure this prevents: a context suspended by a backgrounded tab (or
    // built before any user gesture) fills the analyser buffer with zeros, and
    // a detector reading zeros concludes the learner never spoke — silently,
    // for the whole session.
    playListeningEarcon();
    const context = contexts()[0];
    context.state = 'suspended';

    createAnalyserLevelSource(STREAM);

    expect(context.resume).toHaveBeenCalled();
    expect(contexts()).toHaveLength(1);
  });

  it('is inert, not fatal, where the platform has no Web Audio at all', () => {
    Reflect.deleteProperty(window, 'AudioContext');

    // The jsdom case, and an old Safari, and a locked-down browser: the hook
    // reports `unavailable` and the loop falls back to a button.
    expect(createAnalyserLevelSource(STREAM)).toBeNull();
    expect(contexts()).toHaveLength(0);
  });
});

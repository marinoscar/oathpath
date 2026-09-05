/**
 * Earcons — the short tones that tell a learner who is not looking at the
 * screen what the app is doing.
 *
 * Issue #310, epic #304 / E13 ("Conversation mode"). Three cues, no assets, no
 * network, and a single switch that turns the whole module off.
 *
 * =============================================================================
 * SILENCE IS INDISTINGUISHABLE FROM A CRASH WHEN NOBODY IS WATCHING THE SCREEN
 * =============================================================================
 *
 * Conversation mode is for a learner walking with the phone in their hand,
 * in a pocket, or on a kitchen counter. The screen is not being read. That
 * removes every visual affordance the rest of this product leans on: no
 * spinner, no "Listening…" label, no disabled button — a person who cannot see
 * the screen has exactly one channel left, and it is this one.
 *
 * The gap this exists to fill is real and it is not short. Between "you stopped
 * speaking" and "here is the answer" sits a transcription round trip and, on a
 * deterministic miss, an AI grader call as well (`docs/specs/ai-evaluation.md`
 * — the two-rung ladder). Several seconds of nothing is the NORMAL case, not
 * the failure case. Hands-free, a normal several-second pause and a hung
 * session produce byte-for-byte the same experience: nothing happens. A learner
 * who cannot tell those apart takes the phone out and looks — which is the one
 * thing conversation mode exists to make unnecessary — or gives up on it.
 *
 * So: a rising two-tone when the microphone opens, a soft pulse for as long as
 * the answer is being worked on, and a falling two-tone when it lands. The
 * pulse is the load-bearing one. The other two mark edges; the pulse is what
 * says "still here, still working" during the span where saying nothing would
 * be read as being broken.
 *
 * =============================================================================
 * SYNTHESISED, NOT SHIPPED AS FILES — AND NOT AS A COMPROMISE
 * =============================================================================
 *
 * The obvious implementation is three small audio files and an `<audio>` tag
 * (or three `Audio` objects). This module deliberately does not do that, and
 * the reason is not bundle size — three sub-second tones are a few kilobytes.
 * It is that a file has to ARRIVE before it can play.
 *
 * A file is a network request that can be slow, can be cached or not cached,
 * can 404 behind a misconfigured proxy, and can be evicted from the HTTP cache
 * at any moment the browser feels like it. The first play of an uncached file
 * is exactly the moment the cue matters most — the learner has just started
 * their first hands-free session — and it is the one play guaranteed to be
 * late. A cue that arrives after the thing it was announcing is worse than no
 * cue: it teaches the learner the sound means nothing.
 *
 * `OscillatorNode` has nothing to load. There is no request to fail, no cache
 * to warm, no first-play latency to design around, no asset to add to the
 * build, and no offline story to write — a scheduled oscillator is as fast on
 * a cold, offline first run as on the thousandth. It beats a perfectly cached
 * file at that file's own goal, because the fastest possible fetch is the one
 * that does not happen. Preloading files would only be an attempt to reach the
 * position this starts from.
 *
 * The cost is that a sine tone is not a designed sound, and one day somebody
 * with an ear may want real ones. That is why every cue is a DESCRIPTOR
 * (frequency, duration, gain) that call sites never look inside, and why no
 * call site ever constructs an oscillator: swapping in designed audio later is
 * a change to this file's implementation and to nothing else. The call sites
 * say `playListeningEarcon()`, and will still say it afterwards.
 *
 * =============================================================================
 * ONE SWITCH, ONE CONTEXT, AND NOTHING HERE MAY EVER BREAK A SESSION
 * =============================================================================
 *
 * `setEarconsEnabled(false)` makes the entire module inert. One flag checked in
 * one place, rather than an `if (soundOn)` at every call site — a call site
 * that forgets the check is a learner who turned sounds off and still hears
 * them, and that bug is invisible to everybody whose sounds are on.
 *
 * Every cue is also a no-op when there is no `AudioContext` to play it through
 * — jsdom, an older Safari, a context the browser refuses to start before a
 * user gesture — and none of them throws, ever. An audio cue is a courtesy on
 * top of a practice session that works without it; a missing or hostile audio
 * API must degrade to silence, never to an exception on the path that was
 * about to grade somebody's answer. Same posture as
 * `docs/specs/voice.md` §1: voice is an addition, never a requirement.
 *
 * There is ONE `AudioContext` for the whole module, exposed through
 * {@link getSharedAudioContext} because the conversation-mode VAD hook needs
 * one too. Browsers cap how many a page may create and each one holds an audio
 * device open; a context per cue would exhaust that cap in a long session. It
 * is created lazily on first use, not at import: a context constructed before
 * any user gesture starts `suspended`, so building one at module load would
 * reliably produce a dead context on every page that merely imports this file
 * — hence construct-on-first-cue plus a defensive `resume()`.
 *
 * Finally, every node is disconnected once it has finished sounding, on the
 * oscillator's own `onended`. A conversation session can run for half an hour
 * and pulse every second or so; nodes left connected to the destination
 * accumulate for the life of the page.
 */

/**
 * One tone within a cue: what pitch, for how long, how loud, and how far into
 * the cue it starts. This is the whole vocabulary — a call site never sees it.
 */
export interface EarconTone {
  /** Pitch in hertz. */
  frequency: number;
  /** How long this tone sounds, in milliseconds. */
  durationMs: number;
  /** Peak gain, 0-1. These are cues under a voice, not alerts: keep them low. */
  gain: number;
  /** Offset from the start of the cue, in milliseconds. Defaults to 0. */
  atMs?: number;
}

/** A complete cue: one or more tones on a shared waveform. */
export interface EarconDescriptor {
  /** Stable identifier, for debugging and tests. Never shown to a learner. */
  name: string;
  /** Waveform. `sine` reads as a soft chime; `square` as a beep. */
  wave: OscillatorType;
  /** The tones, in any order — each carries its own `atMs`. */
  tones: readonly EarconTone[];
}

/** A cue that repeats on a timer until it is stopped. */
export interface EarconPulseDescriptor {
  /** Stable identifier, for debugging and tests. */
  name: string;
  /** The cue played on every tick. */
  pulse: EarconDescriptor;
  /** Gap between the START of one tick and the start of the next, in ms. */
  intervalMs: number;
}

/**
 * A running pulse. `stop()` is idempotent and safe to call from a cleanup path
 * that has no idea whether the pulse ever started.
 */
export interface EarconPulseHandle {
  stop: () => void;
}

/**
 * "I'm listening" — a rising two-tone, D5 then A5.
 *
 * RISING, and its partner falling, because the direction is the message. A
 * learner is not going to learn two arbitrary chimes apart; up-means-open and
 * down-means-closed is understood on first hearing and needs no explaining,
 * which matters for a cue whose whole job is to be understood while somebody
 * is doing something else.
 */
export const LISTENING_EARCON: EarconDescriptor = {
  name: 'listening',
  wave: 'sine',
  tones: [
    { frequency: 587.33, durationMs: 90, gain: 0.12 },
    { frequency: 880, durationMs: 130, gain: 0.12, atMs: 90 },
  ],
};

/** "Got it" — the same two tones, falling. See {@link LISTENING_EARCON}. */
export const CAPTURED_EARCON: EarconDescriptor = {
  name: 'captured',
  wave: 'sine',
  tones: [
    { frequency: 880, durationMs: 90, gain: 0.12 },
    { frequency: 587.33, durationMs: 130, gain: 0.12, atMs: 90 },
  ],
};

/**
 * "Working on it" — a soft, low, short pulse roughly once a second.
 *
 * Quieter and lower than either edge cue (a third of the gain, well below both
 * pitches) on purpose. This one repeats, possibly a dozen times while a grader
 * call runs, and a repeating sound at the volume of a notification stops being
 * reassurance and becomes nagging within about three ticks. It should sit under
 * the learner's own thinking, present enough to answer "is it still alive?" and
 * no more.
 */
export const PROCESSING_PULSE_EARCON: EarconPulseDescriptor = {
  name: 'processing',
  intervalMs: 1100,
  pulse: {
    name: 'processing-pulse',
    wave: 'sine',
    tones: [{ frequency: 392, durationMs: 70, gain: 0.045 }],
  },
};

/**
 * Ramp in and out of every tone rather than starting and stopping at full
 * gain. A gain step is a discontinuity in the waveform, and a discontinuity is
 * an audible click — on cheap phone speakers a click is most of what you hear.
 */
const ENVELOPE_SECONDS = 0.008;

/**
 * Schedule everything a few milliseconds ahead of `currentTime`.
 *
 * Scheduling at exactly `currentTime` is a race against the audio thread,
 * which may already have passed that instant by the time the parameters are
 * set; the audible result is a dropped or clipped first tone. This is the
 * standard Web Audio lead time, kept tiny so no cue feels late.
 */
const SCHEDULING_LEAD_SECONDS = 0.01;

/**
 * The one switch. Default on: conversation mode is the feature that needs
 * these, and a learner's own preference flips this from settings rather than
 * every call site guarding itself. See the file header.
 */
let enabled = true;

/** Turn every cue in this module into a no-op, or back on. */
export function setEarconsEnabled(next: boolean): void {
  if (!next) stopProcessingPulse();
  enabled = next;
}

/** Whether cues are currently audible. */
export function areEarconsEnabled(): boolean {
  return enabled;
}

/** The single shared context. Created on first use — see the file header. */
let sharedContext: AudioContext | null = null;

type AudioContextConstructor = new () => AudioContext;

/**
 * `AudioContext`, or Safari's prefixed spelling, or nothing at all (jsdom, an
 * old browser, a non-DOM runtime). "Nothing at all" is a supported outcome.
 */
function resolveAudioContextConstructor(): AudioContextConstructor | null {
  if (typeof window === 'undefined') return null;
  const scope = window as Partial<Window & typeof globalThis> & {
    webkitAudioContext?: AudioContextConstructor;
  };
  return scope.AudioContext ?? scope.webkitAudioContext ?? null;
}

/**
 * The `AudioContext` this module plays through, creating it on first call, or
 * `null` where the platform has none.
 *
 * EXPORTED because conversation mode's voice-activity detection needs an
 * `AnalyserNode` on a context, and it must be THIS context: two contexts means
 * two audio devices open, two suspend/resume lifecycles to keep in step, and
 * on some platforms the second `new AudioContext()` simply fails. Callers that
 * want to make a sound should not use this — they should use a cue.
 *
 * Returns `null` rather than throwing, and callers must handle `null`.
 */
export function getSharedAudioContext(): AudioContext | null {
  if (sharedContext && sharedContext.state !== 'closed') {
    resumeIfSuspended(sharedContext);
    return sharedContext;
  }

  const Ctor = resolveAudioContextConstructor();
  if (!Ctor) return null;

  try {
    sharedContext = new Ctor();
  } catch {
    // A browser that exposes the constructor can still refuse to build one
    // (an autoplay policy, an exhausted context limit). Silence is the answer.
    sharedContext = null;
    return null;
  }

  resumeIfSuspended(sharedContext);
  return sharedContext;
}

/**
 * Close and forget the shared context.
 *
 * For teardown and for tests, which need each case to start from a context
 * they installed themselves. Anything still holding the old context — the VAD
 * analyser, say — must re-read it from {@link getSharedAudioContext}.
 */
export function closeSharedAudioContext(): void {
  const context = sharedContext;
  sharedContext = null;
  stopProcessingPulse();
  if (!context) return;
  try {
    void Promise.resolve(context.close()).catch(() => undefined);
  } catch {
    // Already closing, or a stub with no `close`. Nothing to do or to report.
  }
}

/**
 * A context built before a user gesture starts `suspended`, and one that has
 * been backgrounded can be suspended again later, so this runs on every access
 * rather than once at creation. `resume()` on an already-running context is a
 * no-op, and its rejection (no gesture yet) is expected — that is the case
 * where the cue is simply inaudible, which is not an error anybody can act on.
 */
function resumeIfSuspended(context: AudioContext): void {
  try {
    if (context.state !== 'suspended') return;
    void Promise.resolve(context.resume()).catch(() => undefined);
  } catch {
    // A stub or an exotic implementation without `resume`. Silence, again.
  }
}

/**
 * Build, schedule and tear down the nodes for one tone.
 *
 * The teardown is the part worth reading: `onended` disconnects BOTH nodes, so
 * a session that plays a thousand pulses holds at most the handful currently
 * sounding. Scheduling `stop()` is what guarantees `onended` fires at all.
 */
function scheduleTone(
  context: AudioContext,
  wave: OscillatorType,
  tone: EarconTone,
  cueStartSeconds: number,
): void {
  const startAt = cueStartSeconds + (tone.atMs ?? 0) / 1000;
  const endAt = startAt + tone.durationMs / 1000;

  const oscillator = context.createOscillator();
  const gain = context.createGain();

  oscillator.type = wave;
  oscillator.frequency.setValueAtTime(tone.frequency, startAt);

  // Silence -> peak -> silence, with the ramps inside the tone's own duration
  // so a cue never runs longer than its descriptor says it does.
  const peakAt = Math.min(startAt + ENVELOPE_SECONDS, endAt);
  const fadeFrom = Math.max(endAt - ENVELOPE_SECONDS, peakAt);
  gain.gain.setValueAtTime(0, startAt);
  gain.gain.linearRampToValueAtTime(tone.gain, peakAt);
  gain.gain.setValueAtTime(tone.gain, fadeFrom);
  gain.gain.linearRampToValueAtTime(0, endAt);

  oscillator.connect(gain);
  gain.connect(context.destination);

  oscillator.onended = () => {
    try {
      oscillator.disconnect();
      gain.disconnect();
    } catch {
      // Disconnecting twice throws in some implementations. Harmless.
    }
  };

  oscillator.start(startAt);
  oscillator.stop(endAt);
}

/**
 * Play one cue. The single place an oscillator is ever constructed.
 *
 * Silent and harmless when cues are disabled or the platform has no audio.
 * NEVER THROWS — see the file header.
 */
export function playEarcon(descriptor: EarconDescriptor): void {
  if (!enabled) return;
  const context = getSharedAudioContext();
  if (!context) return;

  try {
    const cueStart = context.currentTime + SCHEDULING_LEAD_SECONDS;
    for (const tone of descriptor.tones) {
      scheduleTone(context, descriptor.wave, tone, cueStart);
    }
  } catch {
    // A half-implemented Web Audio (some embedded webviews) can throw from any
    // of the calls above. A missing sound must never take a session with it.
  }
}

/** The microphone is open and the learner may speak. Rising two-tone. */
export function playListeningEarcon(): void {
  playEarcon(LISTENING_EARCON);
}

/** The answer has been captured. Falling two-tone. */
export function playCapturedEarcon(): void {
  playEarcon(CAPTURED_EARCON);
}

/**
 * Start repeating a pulse cue, returning the handle that stops it.
 *
 * The first tick sounds immediately rather than after one interval: the point
 * is to cover the silence that starts NOW, and a cue that waits a second
 * before saying "still working" leaves exactly the gap it was added to fill.
 */
export function startPulse(
  descriptor: EarconPulseDescriptor,
): EarconPulseHandle {
  if (!enabled) return { stop: () => undefined };

  playEarcon(descriptor.pulse);
  const timer = setInterval(
    () => playEarcon(descriptor.pulse),
    descriptor.intervalMs,
  );

  let stopped = false;
  return {
    stop: () => {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
    },
  };
}

/**
 * The processing pulse, at most one at a time.
 *
 * Module-level rather than caller-held state because the caller is a state
 * machine with several exits — a verdict, an error, a learner leaving the
 * screen — and every one of them must silence it. Starting twice returns the
 * running pulse instead of layering a second one over it: two pulses beating
 * against each other is unmistakably a bug to anybody listening.
 */
let processingPulse: EarconPulseHandle | null = null;

/** Begin the "working on it" pulse. Idempotent. */
export function startProcessingPulse(): EarconPulseHandle {
  if (processingPulse) return processingPulse;
  const handle = startPulse(PROCESSING_PULSE_EARCON);
  processingPulse = handle;
  return {
    stop: () => {
      handle.stop();
      if (processingPulse === handle) processingPulse = null;
    },
  };
}

/**
 * End the "working on it" pulse. Safe to call when none is running — the
 * unconditional call on every exit path is the point.
 */
export function stopProcessingPulse(): void {
  const handle = processingPulse;
  processingPulse = null;
  handle?.stop();
}

/** Whether the processing pulse is currently running. */
export function isProcessingPulseRunning(): boolean {
  return processingPulse !== null;
}

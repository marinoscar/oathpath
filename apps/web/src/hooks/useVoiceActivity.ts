/**
 * Voice-activity detection: when did the learner start talking, and when did
 * they stop?
 *
 * Issue #309, epic #304 / E13 "Conversation mode". A hands-free loop has no
 * button to release. Every turn it runs, it has to answer three questions by
 * itself — has speech STARTED, has speech FINISHED, and has the learner
 * INTERRUPTED the coach mid-sentence — and it has to answer them from nothing
 * but a level meter. This hook is those three answers and nothing else: it
 * owns no microphone, no recorder, no transcript and no UI. It is handed a
 * `MediaStream` somebody else acquired, and it emits events.
 *
 * =============================================================================
 * IT NEVER CALLS `getUserMedia`. THE STREAM IS ALWAYS SOMEBODY ELSE'S.
 * =============================================================================
 *
 * `useAudioCapture` is the hook that acquires, holds and — critically — STOPS
 * the microphone, and its own header explains why that last part is a trust
 * question rather than resource hygiene: while a track is live the operating
 * system shows a recording light, and a learner who can see that light after
 * being told we stopped listening has been told otherwise by their own
 * computer. A second hook that could also open a microphone would be a second
 * place that can leave that light on, and the two would have no way to agree
 * about who was allowed to close it. So this hook takes a stream and gives it
 * back untouched: it attaches an `AnalyserNode` (which observes without
 * consuming) and, on teardown, disconnects its own nodes — never a track, and
 * (since issue #347) never a context either.
 *
 * =============================================================================
 * THERE IS EXACTLY ONE `AudioContext` ON THE PAGE, AND THIS FILE DOES NOT OWN IT
 * =============================================================================
 *
 * The analyser hangs off {@link getSharedAudioContext} — `lib/earcons.ts`'s
 * context, resumed on every access there — and NOT off a `new AudioContext()`
 * of this file's own. `earcons.ts` states the rule at the export itself: two
 * contexts means two audio devices open, two suspend/resume lifecycles to keep
 * in step, and on some platforms the second `new AudioContext()` simply fails.
 * A suspended context hands `getFloatTimeDomainData` a buffer of zeros, which
 * this detector reads as a perfectly silent room — the learner speaks and
 * nothing happens, with nothing on screen to say why.
 *
 * The corollary is a rule about teardown: THIS FILE NEVER CLOSES THE CONTEXT.
 * It borrowed it, the earcons still need it, and closing it would silence every
 * cue on the page. `close()` on the level source disconnects the two nodes this
 * file created and stops there.
 *
 * A consequence worth stating: if the caller stops the stream mid-turn, the
 * analyser reads silence, the hangover clock runs out, and the turn ends with
 * an ordinary `endOfTurn`. That is the correct degradation, and it is why
 * there is no stream-change effect here — a torn-down stream resolves itself.
 *
 * =============================================================================
 * THE THRESHOLD IS CALIBRATED, NEVER A CONSTANT. THIS IS THE WHOLE DESIGN.
 * =============================================================================
 *
 * A fixed dB cutoff is a bet that every learner practises in the same room.
 * The learner this epic is actually for is on a bus, on a lunch break, on a
 * windy pavement outside a job — and the entire point of hands-free practice
 * is that it works in those places, because those are the only places some
 * people have. A cutoff tuned in a quiet office fires continuously on a busy
 * street (every turn ends instantly, "recording" nothing but traffic); a
 * cutoff tuned for the street never fires in a quiet room (the learner speaks
 * and is not heard). There is no third number that works for both, so there is
 * no number at all: on every arm we listen to the room for
 * {@link VOICE_ACTIVITY_CALIBRATION_MS} first, take the MEDIAN of what we heard
 * (a median, not a mean, so one door slam does not become the room), and set
 * the speech bar RELATIVE to that floor.
 *
 * A louder room therefore produces a higher bar, always and monotonically —
 * {@link calibrateThresholds} is a pure function precisely so that is a
 * property a test can assert rather than a claim a comment can make.
 *
 * =============================================================================
 * AND THE BAR IS *ONLY* THE ROOM'S — NO ABSOLUTE TERM — issue #347, epic #345
 * =============================================================================
 *
 * Until #347 the onset bar was `floor * 1.8 + 0.045`, and that `+ 0.045` was an
 * ABSOLUTE RMS term the calibration could not move. In a quiet room
 * (floor ~ 0.002) it put the bar at ~0.0486 RMS — about -26 dBFS — no matter
 * how far away the microphone was. A phone held at 20 cm clears -26 dBFS
 * easily. A laptop's far-field array at 50-80 cm delivers ordinary speech at
 * roughly -35 to -45 dBFS and never clears it, so on a laptop: `loudSince`
 * reset on every sub-threshold sample, onset fired only on the loudest
 * syllable, the eight-second window expired into `onsetTimeout`, a mid-sentence
 * dip ended the turn, and barge-in at ~0.128 (~-18 dBFS) was unreachable.
 * ONE CONSTANT PRODUCED ALL OF IT, and it was the one constant that made this
 * a platform difference rather than a general weakness.
 *
 * So every bar here is now a MULTIPLE of the measured floor and nothing else.
 * The only absolute number left is {@link VOICE_ACTIVITY_ONSET_MINIMUM}, which
 * is not headroom: it exists so that a floor of exactly zero (a muted track, a
 * suspended context handing back a buffer of zeros, a synthetic silence in a
 * test) cannot produce a bar of exactly zero — where every sample, silence
 * included, is "speech". It sits ~17 dB BELOW the quietest far-field speech
 * this change is for, so it is never the thing a learner has to clear.
 *
 * =============================================================================
 * BARGE-IN COSTS MORE THAN ONSET, ON PURPOSE
 * =============================================================================
 *
 * Interrupting the coach uses a SECOND, STRICTLY HIGHER threshold — also
 * purely relative, for the reason the section above gives; barge-in had its own
 * absolute headroom term until #347 and it made interrupting unreachable on
 * exactly the devices onset was already failing on. It requires
 * speech to be sustained roughly three times as long
 * ({@link VOICE_ACTIVITY_BARGE_IN_SUSTAIN_MS} against
 * {@link VOICE_ACTIVITY_ONSET_SUSTAIN_MS}), and is not armed at all for the
 * first {@link VOICE_ACTIVITY_BARGE_IN_ARMING_MS} of playback.
 *
 * All three exist for one situation: a phone held at arm's length outdoors,
 * playing the coach's voice through its own speaker, into its own microphone.
 * The app's own voice is the loudest thing in the room, and it is arriving on
 * the same input we are watching. If barge-in used the onset bar, the coach
 * would interrupt itself on its first syllable, every single turn. The arming
 * delay covers exactly that first syllable; calibrating INSIDE that delay
 * means the floor we measure is the playback bleed itself, so the bar the
 * learner has to clear automatically rises with how loud the phone is; and the
 * longer sustain means a cough, a car horn or a door does not stop the coach
 * mid-explanation. Interrupting should take intent. Missing an interruption
 * costs a learner one repeated sentence; a barge-in that fires on traffic
 * makes the coach unusable outdoors, which is the entire feature.
 *
 * =============================================================================
 * A THROTTLED POLL IS REPORTED, NOT PAPERED OVER — issue #347
 * =============================================================================
 *
 * {@link VOICE_ACTIVITY_POLL_INTERVAL_MS} asks for 25 ms. Chrome clamps
 * `setInterval` in a hidden or occluded tab to roughly ONE SECOND, and a
 * learner practising at a desk with another window in front of the browser is
 * the ordinary case, not an exotic one. At 1 Hz the calibration median is taken
 * from a single sample and onset needs two loud readings a second apart —
 * the machine still works, in the sense that every transition still fires, but
 * it is no longer the detector its constants describe.
 *
 * So each tick measures the gap since the last one and, when a gap reaches
 * {@link VOICE_ACTIVITY_THROTTLE_RATIO} times the interval that was asked for,
 * the arm is marked throttled: {@link VoiceActivityState.poll} says so while it
 * is armed, and {@link UseVoiceActivityReturn.getPollHealth} says so afterwards,
 * carrying the worst gap actually observed. NOTHING IS FAKED — no interpolated
 * samples, no scaled sustain windows, no pretending a 1 Hz poll is a 40 Hz one.
 *
 * It is deliberately NOT a sixth {@link VoiceActivityEvent}. Every member of
 * that union is a TURN OUTCOME that disarms the hook as it fires, and a driver
 * switches over it exhaustively; a throttled clock is neither an outcome nor a
 * reason to end a turn, and making it one would force every driver to handle
 * "the tab is behind another window" as though the learner had stopped talking.
 *
 * =============================================================================
 * WHAT THIS FILE DOES NOT CLAIM
 * =============================================================================
 *
 * Everything below is STATE LOGIC over a stream of numbers, and that is all
 * that is tested. Whether these particular ratios and windows feel right
 * against a real microphone, a real voice, a real room and a real phone
 * speaker is NOT tested here and cannot be: jsdom has no `AudioContext`, no
 * microphone and no acoustics. `docs/specs/voice.md` §13 puts the web voice
 * components outside the API spec's tested contracts deliberately, and spoken
 * practice is verified by hand. Read a green suite here as "the machine
 * transitions correctly", never as "this works on a windy street" — the
 * numbers are starting points chosen to be tuned, which is the other reason
 * every one of them is a named export rather than a literal buried in a
 * comparison.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { getSharedAudioContext } from '../lib/earcons';

// ---------------------------------------------------------------------------
// Tunables. EVERY ONE OF THEM IS EXPORTED AND NAMED.
//
// The house model is `ASR_CONFIDENCE_THRESHOLD`
// (`apps/web/src/components/voice/confidence.ts`): one number, one name, one
// documented reason, read from every place that needs it. The reasoning there
// applies with more force here, because these values are field-tuned. A `0.7`
// typed inline into a comparison is a value nobody can find, nobody can
// override in a test, and nobody can adjust after the first real-world report
// without reading the whole state machine to be sure they found all of them.
// ---------------------------------------------------------------------------

/**
 * How often the level is sampled. 25 ms is 40 Hz — far finer than the shortest
 * window we measure ({@link VOICE_ACTIVITY_ONSET_SUSTAIN_MS}) and far coarser
 * than anything that costs battery.
 *
 * A `setInterval`, deliberately, and NOT `requestAnimationFrame`: rAF is
 * throttled to roughly 1 Hz in a background tab and suspended OUTRIGHT in a
 * hidden one. A learner practising hands-free is very likely to have the
 * screen off or the tab behind something, and a detector that stops sampling
 * exactly then would hear the whole answer as one uninterrupted silence.
 *
 * `setInterval` is throttled too, though — to about 1 Hz rather than to zero —
 * which is why this is an interval a tick MEASURES ITSELF AGAINST rather than
 * an interval anything downstream is entitled to assume. See
 * {@link VOICE_ACTIVITY_THROTTLE_RATIO}.
 */
export const VOICE_ACTIVITY_POLL_INTERVAL_MS = 25;

/**
 * A gap of this many poll intervals means the timer is being throttled.
 *
 * 4x (100 ms at the default interval) is well past ordinary jitter — a busy
 * main thread, a long render, a garbage collection — and well under the ~1 Hz
 * (40x) a hidden tab is clamped to, so it separates "the machine was briefly
 * busy" from "this clock is no longer the clock we asked for" without needing
 * to name either number twice.
 */
export const VOICE_ACTIVITY_THROTTLE_RATIO = 4;

/** How long the ambient floor is sampled on each arm, before anything can fire. */
export const VOICE_ACTIVITY_CALIBRATION_MS = 300;

/**
 * The onset bar is this multiple of the measured floor. THE WHOLE BAR — since
 * issue #347 there is nothing added to it (see {@link VOICE_ACTIVITY_ONSET_MINIMUM}
 * for the one exception, which is a clamp rather than a term).
 *
 * 1.8x is about +5.1 dB over the room, which is where a speaking voice sits
 * relative to the ambient floor of the room it is spoken in, near or far.
 * Because it is a RATIO, the same number works at 20 cm on a phone and at 80 cm
 * on a laptop: both measure their own floor first, and speech is the same
 * distance above it in both. The de-glitching that stops a single loud sample
 * being a voice is {@link VOICE_ACTIVITY_ONSET_SUSTAIN_MS}, not this.
 */
export const VOICE_ACTIVITY_ONSET_FLOOR_MULTIPLIER = 1.8;

/**
 * THE ONLY ABSOLUTE LEVEL LEFT IN THIS FILE, AND IT IS NOT HEADROOM.
 *
 * `0.0008` RMS is about -62 dBFS. It exists for exactly one degenerate case: a
 * measured floor of (or very near) ZERO — a muted track, a suspended context
 * returning a buffer of zeros, a synthetic silence — where a pure multiplier
 * would put the onset bar at 0 and EVERY sample, silence included, would be
 * over it. Onset would fire instantly and permanently on nothing at all.
 *
 * It is deliberately ~17 dB below the -45 dBFS (0.0056 RMS) bottom of the
 * far-field speech range issue #347 is about, and ~26 dB below -35 dBFS: a
 * laptop's array microphone at 50-80 cm never has to clear THIS number, it has
 * to clear `floor * {@link VOICE_ACTIVITY_ONSET_FLOOR_MULTIPLIER}`. Raising it
 * towards speech levels would re-introduce the absolute term #347 removed, one
 * decibel at a time — so it is a guard against arithmetic, not against noise,
 * and it should never be tuned as though it were the latter.
 */
export const VOICE_ACTIVITY_ONSET_MINIMUM = 0.0008;

/**
 * The onset bar never goes above this, however loud the room is.
 *
 * Also what keeps {@link VOICE_ACTIVITY_BARGE_IN_THRESHOLD_CEILING} strictly
 * above it in the worst case — see {@link calibrateThresholds}.
 */
export const VOICE_ACTIVITY_ONSET_THRESHOLD_CEILING = 0.75;

/**
 * Hysteresis: staying in speech only requires this fraction of the onset bar.
 *
 * A voice does not hold a constant level — it dips between words and decays
 * through the bar at the end of every phrase. With a single symmetric
 * threshold the hangover clock restarts on each syllable AND starts on each
 * trough, so the measured "silence" is whatever the last consonant happened to
 * do. A lower bar for continuing than for starting is the standard fix and it
 * makes end-of-turn depend on the pause, not the phonetics.
 */
export const VOICE_ACTIVITY_RELEASE_RATIO = 0.7;

/**
 * Speech must stay above the onset bar this long before onset is reported.
 *
 * This is the de-glitching, and it is why there is no exponential smoothing on
 * the level itself: a single loud sample cannot start a turn, so smoothing
 * would only add lag to a decision that is already deliberately delayed.
 */
export const VOICE_ACTIVITY_ONSET_SUSTAIN_MS = 120;

/**
 * How long we wait for the learner to start, before reporting
 * {@link VoiceActivityEvent} `onsetTimeout`.
 *
 * Measured from `arm()`, calibration included — from the learner's side the
 * app started listening when it started listening. Eight seconds is long
 * enough to think about a question and short enough that a learner who
 * genuinely did not hear it is not left in silence.
 */
export const VOICE_ACTIVITY_ONSET_TIMEOUT_MS = 8_000;

/**
 * Continuous sub-release audio after onset that ends the turn.
 *
 * 1.5 s is above the longest pause inside an ordinary sentence and below the
 * point where a learner starts wondering whether the app noticed them.
 */
export const VOICE_ACTIVITY_HANGOVER_MS = 1_500;

/**
 * The hard cap on a single listening turn.
 *
 * NOT an independent decision: it mirrors `useAudioCapture`'s own
 * `DEFAULT_MAX_DURATION_MS`, which in turn mirrors the 120-second server cap
 * that `POST /api/ai/speech/transcribe` enforces before dispatch. Whatever
 * this hook decides, the recording the loop is making alongside it is
 * worthless past that line — so the two must not drift, and this is the one
 * constant here whose value is inherited rather than chosen.
 *
 * Measured from `arm()`, not from onset, because in a hands-free loop the
 * recorder starts when the hook is armed: the cap has to cover the whole
 * armed span, or a turn could spend eight seconds in silence and then two
 * minutes in speech and still be rejected server-side.
 */
export const VOICE_ACTIVITY_MAX_DURATION_MS = 120_000;

/**
 * Barge-in is dead for this long after `arm('barge-in')` — long enough to
 * cover the coach's own first syllable reaching the microphone. See the file
 * header.
 */
export const VOICE_ACTIVITY_BARGE_IN_ARMING_MS = 500;

/**
 * The barge-in bar is this multiple of the (already capped) onset bar, and
 * nothing else is added to it.
 *
 * `> 1` is what makes "barge-in is always stricter than onset" arithmetic
 * rather than intent, at every floor: onset is itself never zero (see
 * {@link VOICE_ACTIVITY_ONSET_MINIMUM}), so `onset * 1.6 > onset` holds
 * everywhere, and the two ceilings are ordered so the capped case holds too.
 * The absolute headroom this used to carry (`+ 0.05`) put the bar at ~0.128 in
 * a quiet room — about -18 dBFS — which no far-field microphone reaches, so
 * interrupting the coach on a laptop was not merely hard, it was impossible.
 */
export const VOICE_ACTIVITY_BARGE_IN_MULTIPLIER = 1.6;

/**
 * The barge-in bar never goes above this. Strictly above
 * {@link VOICE_ACTIVITY_ONSET_THRESHOLD_CEILING}, which is what makes
 * "barge-in is always stricter than onset" hold even when both are capped.
 */
export const VOICE_ACTIVITY_BARGE_IN_THRESHOLD_CEILING = 0.95;

/**
 * Sustained speech required to interrupt — roughly three times
 * {@link VOICE_ACTIVITY_ONSET_SUSTAIN_MS}. A cough clears the bar; it does not
 * clear the bar for a third of a second.
 */
export const VOICE_ACTIVITY_BARGE_IN_SUSTAIN_MS = 350;

/**
 * `AnalyserNode.fftSize`, which also fixes the time-domain window we take the
 * RMS over: 2048 samples is ~43 ms at 48 kHz, so each reading is already an
 * average over a syllable-sized slice rather than an instant.
 */
export const VOICE_ACTIVITY_FFT_SIZE = 2048;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * What the hook is armed FOR. Two jobs, two shapes, one hook — because they
 * share the calibration, the poll loop and the teardown, and a second hook
 * would be a second `AudioContext` on the same stream.
 *
 * `listening` waits for the learner to speak and tells you when they stop.
 * `barge-in` watches, while the coach is talking, for the learner cutting in.
 */
export type VoiceActivityMode = 'listening' | 'barge-in';

/**
 * Where the detector is.
 *
 * `unavailable` is its own state and not a failure: jsdom has no
 * `AudioContext`, an old browser may have none, and a caller that armed with
 * no stream yet is an ordinary race, not a bug. In every one of those cases
 * the hook is an inert no-op that emits nothing, and the loop driving it can
 * fall back to a button.
 */
export type VoiceActivityStatus =
  /** Not armed. The resting state, and where every terminal event leaves us. */
  | 'idle'
  /** No `AudioContext`, or nothing to listen to. Inert, never throws. */
  | 'unavailable'
  /** Sampling the ambient floor. Nothing can fire yet. */
  | 'calibrating'
  /** Armed for `listening`, waiting for the learner to start. */
  | 'listening'
  /** Onset seen; the hangover clock is what ends this. */
  | 'speaking'
  /** Armed for `barge-in`, watching the coach's own playback go by. */
  | 'watching';

/** The calibrated bars for one arm. All levels are RMS in 0..1. */
export interface VoiceActivityThresholds {
  /** The median ambient level measured during calibration. */
  noiseFloor: number;
  /** Cross this, sustained, to start a turn. */
  onset: number;
  /** Stay above this to keep it going. Below {@link onset} — hysteresis. */
  release: number;
  /** Cross this, sustained longer, to interrupt. Always above {@link onset}. */
  bargeIn: number;
}

/**
 * The five things that can happen. A discriminated union rather than five
 * optional callbacks so a driver can `switch` exhaustively — a sixth outcome
 * must then break every driver's compile rather than be silently unhandled by
 * the one that forgot to pass a prop.
 *
 * ALL FIVE ARE TERMINAL EXCEPT `onset`: the hook disarms itself as it emits
 * them, so a driver never has to remember to. `onset` is the one mid-turn
 * signal, and is what a UI uses to say "we can hear you".
 */
export type VoiceActivityEvent =
  /** Speech started. Not terminal — the turn is now running. */
  | { type: 'onset'; at: number }
  /**
   * Nobody spoke inside the onset window. THIS IS NOT AN EMPTY RECORDING, and
   * the distinction is the reason this event exists at all: a driver that
   * received a zero-length turn would send silence to be transcribed and grade
   * the result. Receiving a named timeout instead, it can re-ask the question
   * and listen again.
   */
  | { type: 'onsetTimeout'; at: number; waitedMs: number }
  /** The learner spoke and has now stopped for a full hangover. Terminal. */
  | {
      type: 'endOfTurn';
      at: number;
      speechStartedAt: number;
      speechDurationMs: number;
    }
  /** The learner talked over the coach, loudly and for long enough. Terminal. */
  | { type: 'bargeIn'; at: number; level: number }
  /** The turn hit {@link VOICE_ACTIVITY_MAX_DURATION_MS}. Terminal. */
  | { type: 'maxDuration'; at: number; armedAt: number; durationMs: number };

/**
 * Where the numbers come from.
 *
 * The seam exists so tests can drive the machine with a synthetic level
 * instead of an acoustic one — but it is a real option with a real default
 * ({@link createAnalyserLevelSource}), NOT a test flag: production takes the
 * same path with the same lifetime rules, and nothing here branches on an
 * environment. A caller with its own metering (a realtime transport that
 * already exposes an output level, say) can pass one for the same reason a
 * test can.
 */
export interface VoiceActivityLevelSource {
  /**
   * The current level, 0..1. Called once per {@link
   * VOICE_ACTIVITY_POLL_INTERVAL_MS}. Must be cheap; must not throw (one that
   * does is read as silence rather than crashing a learner's session).
   */
  read: () => number;
  /** Release whatever the source owns. The hook always calls this on teardown. */
  close?: () => void;
}

export interface UseVoiceActivityOptions {
  /**
   * The microphone stream to observe. NOT acquired here and NOT stopped here —
   * see the file header. `null` is ordinary: arming without one lands in
   * `unavailable` and emits nothing.
   */
  stream: MediaStream | null;
  /** Called for each {@link VoiceActivityEvent}. Read from a ref — safe to
   *  pass a fresh closure every render. */
  onEvent?: (event: VoiceActivityEvent) => void;
  /**
   * Build the level source for a stream. Defaults to
   * {@link createAnalyserLevelSource}. Returning `null` means "cannot listen
   * here", which the hook renders as `unavailable`.
   */
  createLevelSource?: (stream: MediaStream) => VoiceActivityLevelSource | null;
  /** The clock. Defaults to `Date.now`. Injectable for the same reason the
   *  backend injects `Clock`: so a test pins an instant instead of sleeping. */
  now?: () => number;

  /** Overrides for the tunables above. Each defaults to its exported constant. */
  pollIntervalMs?: number;
  calibrationMs?: number;
  onsetSustainMs?: number;
  onsetTimeoutMs?: number;
  hangoverMs?: number;
  maxDurationMs?: number;
  bargeInArmingMs?: number;
  bargeInSustainMs?: number;
}

/**
 * How the poll loop is ACTUALLY running, as opposed to how it was asked to.
 *
 * See "A THROTTLED POLL IS REPORTED" in the file header. A consumer renders
 * `throttled` (or logs it, or falls back to a button); it must never be used to
 * silently rescale a window, because a coarse clock is a fact about the
 * environment and not a parameter of the detector.
 */
export interface VoiceActivityPollHealth {
  /**
   * True once any gap between two polls reached
   * {@link VOICE_ACTIVITY_THROTTLE_RATIO} times {@link intendedIntervalMs}.
   *
   * Latching, not instantaneous: it stays true for the rest of the arm. A turn
   * that was sampled at 1 Hz for part of its life was measured with a coarse
   * clock throughout, and a flag that flickered back to `false` the moment the
   * tab came forward would describe the last 25 ms rather than the turn.
   */
  throttled: boolean;
  /**
   * The longest gap between two consecutive polls this arm, in ms.
   *
   * LIVE ON {@link UseVoiceActivityReturn.getPollHealth}, and a SNAPSHOT on
   * {@link VoiceActivityState.poll} — the state copy is written when the
   * throttle flag latches and at each phase change, because re-rendering every
   * consumer forty times a second to update a diagnostic number would cost more
   * than the number is worth. Read the state copy for "is this arm throttled";
   * read the getter for the current worst gap.
   */
  worstIntervalMs: number;
  /** What was asked for — the option, or {@link VOICE_ACTIVITY_POLL_INTERVAL_MS}. */
  intendedIntervalMs: number;
}

export interface VoiceActivityState {
  status: VoiceActivityStatus;
  /** What we were armed for, or `null` when idle/unavailable. */
  mode: VoiceActivityMode | null;
  /** The bars this arm calibrated, or `null` before calibration finishes. */
  thresholds: VoiceActivityThresholds | null;
  /** Whether the clock underneath all of the above is the one we asked for. */
  poll: VoiceActivityPollHealth;
}

export interface UseVoiceActivityReturn {
  state: VoiceActivityState;
  /**
   * True whenever a poll loop is running.
   *
   * Derived from {@link state}, not from the timer handle: a ref does not
   * re-render, so a consumer reading the handle would render a stale answer
   * for exactly as long as nothing else changed — which, in an idle
   * conversation loop, is the whole time.
   */
  isArmed: boolean;
  /** Start (or restart) detection. Idempotent per mode only in the sense that
   *  a second call re-arms from scratch, recalibrating. */
  arm: (mode: VoiceActivityMode) => void;
  /** Stop detection and release the audio graph. Safe at any time, emits
   *  nothing — a caller-initiated stop is not an event. */
  disarm: () => void;
  /**
   * The poll loop's health, live and surviving teardown.
   *
   * `state.poll` goes back to nominal when a terminal event disarms the hook,
   * because `state` describes the CURRENT arm and there isn't one. This getter
   * keeps the last arm's answer, so a driver handling an `onsetTimeout` can ask
   * why it did not hear anything and get a truthful answer.
   */
  getPollHealth: () => VoiceActivityPollHealth;
  /**
   * The most recent level reading, 0..1.
   *
   * A getter over a ref rather than React state on purpose: the level changes
   * forty times a second, and putting it in state would re-render every
   * consumer of this hook forty times a second to move a meter. A caller that
   * wants a meter reads this from its own animation frame.
   */
  getLevel: () => number;
}

// ---------------------------------------------------------------------------
// Calibration
// ---------------------------------------------------------------------------

/**
 * Turn a measured ambient floor into the three bars for this arm.
 *
 * Pure, exported, and separate from the hook so the two properties that matter
 * are directly testable rather than inferred from state transitions:
 *
 *   1. MONOTONIC — a louder room yields a higher onset bar. This is the whole
 *      argument of the file header, and a regression in it (an inverted ratio,
 *      a clamp in the wrong direction) would show up in the field as "voice
 *      practice does not work outside", never as a stack trace.
 *   2. `release < onset < bargeIn`, ALWAYS. Provable, not merely intended.
 *      `onset` is clamped into `[MINIMUM, CEILING]` and `MINIMUM > 0`, so
 *      `onset > 0` everywhere; `release = onset * 0.7 < onset`; and
 *      `bargeIn = onset * 1.6 > onset` for every positive onset. Where both
 *      are capped, the barge-in ceiling (0.95) is strictly above the onset
 *      ceiling (0.75), so the capped case is ordered too. NO TERM IS ADDED TO
 *      ANY OF THE THREE — see the "ONLY THE ROOM'S" section of the header.
 */
export function calibrateThresholds(noiseFloor: number): VoiceActivityThresholds {
  const floor = Number.isFinite(noiseFloor) ? Math.max(0, noiseFloor) : 0;

  // Purely relative, then clamped. The `Math.max` is the degenerate-floor
  // guard described on the constant; it is NOT headroom, and for every floor
  // at or above ~0.00045 it does nothing at all.
  const onset = Math.min(
    Math.max(
      floor * VOICE_ACTIVITY_ONSET_FLOOR_MULTIPLIER,
      VOICE_ACTIVITY_ONSET_MINIMUM,
    ),
    VOICE_ACTIVITY_ONSET_THRESHOLD_CEILING,
  );

  const bargeIn = Math.min(
    onset * VOICE_ACTIVITY_BARGE_IN_MULTIPLIER,
    VOICE_ACTIVITY_BARGE_IN_THRESHOLD_CEILING,
  );

  return {
    noiseFloor: floor,
    onset,
    release: onset * VOICE_ACTIVITY_RELEASE_RATIO,
    bargeIn,
  };
}

/**
 * The middle reading, not the average one.
 *
 * A mean is dragged by exactly the events calibration must ignore — a door, a
 * bus pulling away, the learner clearing their throat in the first 300 ms. Any
 * one of those would raise the bar for the whole turn and the learner would
 * simply not be heard, with nothing on screen to say why.
 */
function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

/**
 * The real level source: an `AnalyserNode` tapping the stream, read as RMS.
 *
 * ON THE SHARED CONTEXT, NEVER A NEW ONE — issue #347. `getSharedAudioContext`
 * is `lib/earcons.ts`'s single context, and that module's own export comment is
 * the rule this obeys: two contexts means two audio devices open, two
 * suspend/resume lifecycles to keep in step, and on some platforms the second
 * `new AudioContext()` simply fails. It also resumes a suspended context on
 * every access, which matters more here than it does for a cue: a suspended
 * context fills `getFloatTimeDomainData`'s buffer with zeros, and a detector
 * reading zeros concludes the learner never spoke.
 *
 * Returns `null` — never throws — wherever the Web Audio API is missing or
 * refuses the stream. jsdom is the case every test run hits (there is no
 * `AudioContext` there at all, so the shared getter itself returns `null`), but
 * a locked-down browser and a stream whose tracks have already ended land in
 * the same place, and all three mean the same thing to a caller: this hook
 * cannot listen, fall back to a button.
 *
 * The analyser is deliberately NOT connected to `context.destination`.
 * Connecting it would route the microphone to the speakers, which on a phone
 * held at arm's length is a feedback loop and, on any device, is the app
 * playing a learner's own voice back at them unasked.
 */
export function createAnalyserLevelSource(
  stream: MediaStream,
): VoiceActivityLevelSource | null {
  const context = getSharedAudioContext();
  if (!context) return null;

  let analyser: AnalyserNode;
  let source: MediaStreamAudioSourceNode;
  try {
    source = context.createMediaStreamSource(stream);
    analyser = context.createAnalyser();
    analyser.fftSize = VOICE_ACTIVITY_FFT_SIZE;
    source.connect(analyser);
  } catch {
    return null;
  }

  const buffer = new Float32Array(analyser.fftSize);

  return {
    read() {
      analyser.getFloatTimeDomainData(buffer);
      let sumOfSquares = 0;
      for (let i = 0; i < buffer.length; i += 1) {
        sumOfSquares += buffer[i] * buffer[i];
      }
      return Math.sqrt(sumOfSquares / buffer.length);
    },
    close() {
      try {
        source.disconnect();
        analyser.disconnect();
      } catch {
        // Already disconnected. Nothing to do and nobody to tell.
      }
      // AND THAT IS ALL. The context is `earcons.ts`'s, shared with every cue
      // on the page and with the next arm of this same hook; closing it here
      // would silence the earcons and leave the next `arm()` building an
      // analyser on a dead context. Whoever created it closes it —
      // `closeSharedAudioContext()` — and that is never this file.
    },
  };
}

// ---------------------------------------------------------------------------
// The hook
// ---------------------------------------------------------------------------

/** The mutable per-arm bookkeeping. A ref, not state: it changes 40x a second. */
interface VoiceActivityMachine {
  mode: VoiceActivityMode;
  phase: 'calibrating' | 'listening' | 'speaking' | 'watching';
  armedAt: number;
  samples: number[];
  thresholds: VoiceActivityThresholds | null;
  /** When the level first crossed the relevant bar, or `null` below it. */
  loudSince: number | null;
  speechStartedAt: number;
  lastLoudAt: number;
  /** When the previous poll ran; seeded with `armedAt` — see `arm`. */
  lastTickAt: number | null;
  /** The worst gap seen this arm, and whether it crossed the throttle line. */
  poll: VoiceActivityPollHealth;
}

function nominalPollHealth(intendedIntervalMs: number): VoiceActivityPollHealth {
  return { throttled: false, worstIntervalMs: 0, intendedIntervalMs };
}

const IDLE_STATE: VoiceActivityState = {
  status: 'idle',
  mode: null,
  thresholds: null,
  poll: nominalPollHealth(VOICE_ACTIVITY_POLL_INTERVAL_MS),
};

export function useVoiceActivity(
  options: UseVoiceActivityOptions,
): UseVoiceActivityReturn {
  const [state, setState] = useState<VoiceActivityState>(IDLE_STATE);

  // Everything the loop reads lives in a ref, refreshed on every render, so
  // `arm`/`disarm`/the tick are stable for the whole life of the component and
  // a caller passing a fresh `onEvent` closure each render cannot restart a
  // turn in progress.
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const machineRef = useRef<VoiceActivityMachine | null>(null);
  const sourceRef = useRef<VoiceActivityLevelSource | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const levelRef = useRef(0);
  /**
   * The last arm's poll health, deliberately NOT cleared by `teardown`.
   *
   * A driver asks this question exactly when the turn has just ended badly —
   * "nobody spoke" — which is after the terminal event has already disarmed
   * the hook. Resetting it on teardown would make the answer unavailable at the
   * only moment anybody wants it. `arm()` clears it; nothing else does.
   */
  const pollHealthRef = useRef<VoiceActivityPollHealth>(
    nominalPollHealth(VOICE_ACTIVITY_POLL_INTERVAL_MS),
  );

  /** Stop the loop and release the audio graph. NEVER touches React state. */
  const teardown = useCallback(() => {
    if (timerRef.current !== null) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    const source = sourceRef.current;
    sourceRef.current = null;
    source?.close?.();
    machineRef.current = null;
    levelRef.current = 0;
  }, []);

  const disarm = useCallback(() => {
    teardown();
    setState((current) => (current.status === 'idle' ? current : IDLE_STATE));
  }, [teardown]);

  /**
   * One poll. The entire state machine is here, in the order the questions are
   * actually asked, so the transitions can be read top to bottom.
   */
  const tick = useCallback(() => {
    const machine = machineRef.current;
    const source = sourceRef.current;
    if (!machine || !source) return;

    const opts = optionsRef.current;
    const now = (opts.now ?? Date.now)();

    // ---- Is this still the clock we asked for? ----------------------------
    // Measured before anything is decided FROM it, and reported rather than
    // compensated for. See the file header.
    const previousTickAt = machine.lastTickAt;
    machine.lastTickAt = now;
    if (previousTickAt !== null) {
      const sincePreviousTick = now - previousTickAt;
      if (sincePreviousTick > machine.poll.worstIntervalMs) {
        machine.poll = { ...machine.poll, worstIntervalMs: sincePreviousTick };
      }
      const throttledNow =
        sincePreviousTick >=
        machine.poll.intendedIntervalMs * VOICE_ACTIVITY_THROTTLE_RATIO;
      if (throttledNow && !machine.poll.throttled) {
        machine.poll = { ...machine.poll, throttled: true };
        pollHealthRef.current = machine.poll;
        // Published once, on the transition, rather than on every late tick: a
        // latched flag has nothing to say a second time, and a `setState` per
        // poll would re-render every consumer forty times a second.
        setState((current) =>
          current.poll.throttled ? current : { ...current, poll: machine.poll },
        );
      } else {
        pollHealthRef.current = machine.poll;
      }
    }

    let level: number;
    try {
      level = source.read();
    } catch {
      // A source that cannot be read is silence, not a crash. In practice this
      // is a context the browser suspended under us; the turn then ends
      // through the ordinary hangover or timeout path rather than throwing
      // inside an interval where nothing could catch it.
      level = 0;
    }
    if (!Number.isFinite(level)) level = 0;
    levelRef.current = level;

    const elapsed = now - machine.armedAt;

    const emit = (event: VoiceActivityEvent) => {
      opts.onEvent?.(event);
    };
    /** Every terminal event disarms as it fires. See {@link VoiceActivityEvent}. */
    const finish = (event: VoiceActivityEvent) => {
      teardown();
      setState(IDLE_STATE);
      emit(event);
    };

    // ---- Calibration ------------------------------------------------------
    if (machine.phase === 'calibrating') {
      machine.samples.push(level);
      const calibrationMs = opts.calibrationMs ?? VOICE_ACTIVITY_CALIBRATION_MS;
      if (elapsed < calibrationMs) return;

      const thresholds = calibrateThresholds(median(machine.samples));
      machine.thresholds = thresholds;
      machine.samples = [];
      machine.phase = machine.mode === 'listening' ? 'listening' : 'watching';
      setState({
        status: machine.phase === 'listening' ? 'listening' : 'watching',
        mode: machine.mode,
        thresholds,
        poll: machine.poll,
      });
      return;
    }

    const thresholds = machine.thresholds;
    if (!thresholds) return;

    // ---- Barge-in ---------------------------------------------------------
    if (machine.mode === 'barge-in') {
      // Nothing at all before the arming delay, however loud it gets: that
      // window belongs to the coach's own first syllable. See the file header.
      if (elapsed < (opts.bargeInArmingMs ?? VOICE_ACTIVITY_BARGE_IN_ARMING_MS)) {
        machine.loudSince = null;
        return;
      }
      if (level < thresholds.bargeIn) {
        machine.loudSince = null;
        return;
      }
      if (machine.loudSince === null) machine.loudSince = now;
      const sustain = opts.bargeInSustainMs ?? VOICE_ACTIVITY_BARGE_IN_SUSTAIN_MS;
      if (now - machine.loudSince >= sustain) {
        finish({ type: 'bargeIn', at: now, level });
      }
      return;
    }

    // ---- The hard cap -----------------------------------------------------
    // Checked before anything else in `listening` mode so it cannot be starved
    // by a learner who never stops talking. In practice it can only be reached
    // while `speaking`, because the onset window closes long before it.
    const maxDurationMs = opts.maxDurationMs ?? VOICE_ACTIVITY_MAX_DURATION_MS;
    if (elapsed >= maxDurationMs) {
      finish({
        type: 'maxDuration',
        at: now,
        armedAt: machine.armedAt,
        durationMs: elapsed,
      });
      return;
    }

    // ---- Waiting for the learner to start ---------------------------------
    if (machine.phase === 'listening') {
      if (level >= thresholds.onset) {
        if (machine.loudSince === null) machine.loudSince = now;
        const sustain = opts.onsetSustainMs ?? VOICE_ACTIVITY_ONSET_SUSTAIN_MS;
        if (now - machine.loudSince >= sustain) {
          // Dated from the FIRST crossing, not from the moment the sustain was
          // satisfied: the learner started speaking when they started, and a
          // turn whose recording is trimmed to the later instant loses its own
          // first syllable.
          machine.speechStartedAt = machine.loudSince;
          machine.lastLoudAt = now;
          machine.phase = 'speaking';
          setState({
            status: 'speaking',
            mode: machine.mode,
            thresholds,
            poll: machine.poll,
          });
          emit({ type: 'onset', at: now });
        }
        return;
      }

      machine.loudSince = null;
      const timeoutMs = opts.onsetTimeoutMs ?? VOICE_ACTIVITY_ONSET_TIMEOUT_MS;
      if (elapsed >= timeoutMs) {
        finish({ type: 'onsetTimeout', at: now, waitedMs: elapsed });
      }
      return;
    }

    // ---- Speaking: the hangover clock -------------------------------------
    // Compared against `release`, not `onset` — see VOICE_ACTIVITY_RELEASE_RATIO.
    if (level >= thresholds.release) {
      machine.lastLoudAt = now;
      return;
    }
    if (now - machine.lastLoudAt >= (opts.hangoverMs ?? VOICE_ACTIVITY_HANGOVER_MS)) {
      finish({
        type: 'endOfTurn',
        at: now,
        speechStartedAt: machine.speechStartedAt,
        speechDurationMs: machine.lastLoudAt - machine.speechStartedAt,
      });
    }
  }, [teardown]);

  const arm = useCallback(
    (mode: VoiceActivityMode) => {
      teardown();

      const opts = optionsRef.current;
      const stream = opts.stream;
      if (!stream) {
        setState({ ...IDLE_STATE, status: 'unavailable' });
        return;
      }

      const create = opts.createLevelSource ?? createAnalyserLevelSource;
      const source = create(stream);
      if (!source) {
        // jsdom, an old browser, or a stream we cannot tap. Inert, not fatal.
        setState({ ...IDLE_STATE, status: 'unavailable' });
        return;
      }

      const intendedIntervalMs =
        opts.pollIntervalMs ?? VOICE_ACTIVITY_POLL_INTERVAL_MS;
      const poll = nominalPollHealth(intendedIntervalMs);

      sourceRef.current = source;
      machineRef.current = {
        mode,
        phase: 'calibrating',
        armedAt: (opts.now ?? Date.now)(),
        samples: [],
        thresholds: null,
        loudSince: null,
        speechStartedAt: 0,
        lastLoudAt: 0,
        // Seeded with `armedAt`, not `null`: the FIRST poll of an arm is as
        // able to be late as any other, and an arm whose first tick lands a
        // second after it was scheduled is throttled from the start. Leaving
        // it null would make the very case this detects — a tab that was
        // already in the background when the turn began — the one case it
        // cannot see.
        lastTickAt: (opts.now ?? Date.now)(),
        poll,
      };
      levelRef.current = 0;
      pollHealthRef.current = poll;
      setState({ status: 'calibrating', mode, thresholds: null, poll });

      timerRef.current = setInterval(tick, intendedIntervalMs);
    },
    [teardown, tick],
  );

  // Unmount stops the loop and closes the `AudioContext`. An interval left
  // running would keep reading a graph whose stream the capture hook has
  // already stopped, and an un-closed context is a real, audible resource on
  // mobile Safari — browsers cap how many a page may hold.
  useEffect(() => teardown, [teardown]);

  const getLevel = useCallback(() => levelRef.current, []);
  const getPollHealth = useCallback(() => pollHealthRef.current, []);

  return {
    state,
    isArmed: state.status !== 'idle' && state.status !== 'unavailable',
    arm,
    disarm,
    getLevel,
    getPollHealth,
  };
}

export default useVoiceActivity;

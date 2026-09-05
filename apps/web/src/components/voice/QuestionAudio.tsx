/**
 * "Read this question aloud."
 *
 * Issue #99, epic #58 / E9.
 *
 * =============================================================================
 * THE BROWSER'S OWN VOICE IS THE DEFAULT. THAT IS DECISION 1, NOT A FALLBACK.
 * =============================================================================
 *
 * `docs/specs/voice.md` §2: hearing a question read aloud must work on day one
 * of every deployment — no model bound, no key, no admin action, no per-call
 * cost — so it is `window.speechSynthesis`, which every evergreen browser
 * implements locally, that speaks by default.
 *
 * `POST /api/ai/speech/synthesize` (the `speak` role) is an OPTIONAL PREMIUM
 * UPGRADE layered on top, reached only when an admin has bound the role AND
 * this learner has asked for it. Inverting that preference — trying the paid
 * route first and dropping to the browser when it fails — would make a fresh
 * install's ordinary state look like a failure recovery, and would spend a
 * learner's own key on something their browser does for nothing.
 *
 * =============================================================================
 * `speak` UNBOUND IS NOT A DEGRADED STATE, SO NOTHING EXPLAINS ITSELF
 * =============================================================================
 *
 * There is no `AiNotReady` in this file, and there must not be. §2 is explicit:
 * an unbound `speak` is simply the state of every fresh install, the learner
 * hears the question either way, and nothing is missing. Rendering "your
 * administrator has not finished setting this up" over a control that is
 * working perfectly would tell somebody the product is broken while it reads
 * their question to them.
 *
 * =============================================================================
 * NO SPEECH SYNTHESIS AT ALL: THE CONTROL IS ABSENT, NOTHING ERRORS
 * =============================================================================
 *
 * A browser with neither `speechSynthesis` nor an opted-in premium voice gets
 * no button — not a disabled one, and certainly not an error. The question text
 * is on the page regardless (this component never renders it, and never
 * replaces it), so the reading experience is unchanged; a broken-looking
 * control would be the only thing lost.
 *
 * `browserSpeechAvailable()` is exported so a caller for whom that is NOT true
 * — the writing screen (#147), where the sentence is dictated and never shown,
 * so a silent button means there is nothing to practise on — can ask the same
 * question this component asks itself and render its own honest absence. It is
 * one function rather than a duplicated pair of `typeof` checks precisely so
 * the two can never disagree about what "this browser can speak" means.
 *
 * =============================================================================
 * THE COPY IS OVERRIDABLE. THE BEHAVIOUR IS NOT.
 * =============================================================================
 *
 * `copy` exists because "Read the question aloud" and "The text is above" are
 * true on a civics screen and FALSE on the writing screen, where there is no
 * question and the text is deliberately nowhere on the page (issue #147,
 * `docs/specs/english-test.md` §4) — a shared component whose wording asserts
 * something untrue about its host is worse than two components. It overrides
 * strings and nothing else: the browser-first preference, the premium upgrade
 * path, the `onPlayed`-only-when-audio-starts rule and the absent-not-disabled
 * control are the same on every caller, which is the reason this is one
 * component with a copy prop rather than a second player.
 *
 * =============================================================================
 * ONE VOICE AT A TIME, ACROSS EVERY MOUNTED INSTANCE
 * =============================================================================
 *
 * Since #287 a practice screen mounts this component TWICE — once for the
 * question, once for the accepted answer in the result region — and the two are
 * on screen together. Starting either one therefore has to silence the other,
 * and the per-instance `stop()` alone could not promise that: it cancels
 * `window.speechSynthesis` (which is global, so browser-voice against
 * browser-voice happened to be safe) but it only pauses ITS OWN `<audio>`
 * element, so on a deployment with `speak` bound, two premium clips could talk
 * over each other with nothing in either instance able to notice.
 *
 * `ACTIVE_PLAYERS` closes that: every mounted instance registers its own
 * `stop`, and `play()` runs the others before it starts. It lives HERE, in the
 * one component, rather than as coordination bolted onto each host — a host
 * cannot observe a click on a button it does not own, and the invariant is a
 * property of "this is the app's audio player", not of any one screen.
 *
 * =============================================================================
 * `onPlayed` IS THE START. `onFinished` IS THE END — AND ONLY A GENUINE ONE.
 * =============================================================================
 *
 * Issue #311, epic #304 / E13. A "read the question, THEN listen" loop needs
 * the moment playback stops, and until #311 the end of audio was handled
 * privately in three places (`utterance.onend`, the element's `onended`, and
 * the one callback its failures shared) with nothing a caller could hang on.
 *
 * `onFinished` fires EXACTLY ONCE per play, from either path, and NEVER for a
 * cancel. That second half is the load-bearing one: `stop()` — this instance's,
 * another instance's through `ACTIVE_PLAYERS`, or the caller's through the ref
 * below — cancels `window.speechSynthesis`, which reports the utterance it
 * interrupted through `onerror`. A barge-in is the learner taking the turn, and
 * a loop that treated it as a completion would advance over the person who just
 * interrupted it. Nothing new enforces this: `stop()` bumps `requestRef`, and
 * every callback here already returns early when its own request is no longer
 * the current one, so a cancelled play is structurally unable to report an end.
 *
 * `reason` separates "the clip ran out" from "nothing more is going to play":
 *
 *   - A premium clip that errors MID-playback fires `failed`. The browser
 *     fall-through in `play()` is unreachable by then (its `playBlob` already
 *     resolved `true`), so a driver waiting for an end that will never arrive
 *     would hang forever.
 *   - A premium clip that fails BEFORE it starts fires NOTHING, because the
 *     browser voice is about to speak the same sentence and report its own end.
 *     One play, one `onFinished`.
 *
 * `stop()` is exposed on a ref (`QuestionAudioHandle`) for the same feature.
 * `ACTIVE_PLAYERS` is one player silencing another; this is the CALLER cutting
 * playback off — a driver that has heard the learner start speaking — which no
 * amount of coordination between players can observe.
 */

import StopIcon from '@mui/icons-material/Stop';
import VolumeUpIcon from '@mui/icons-material/VolumeUp';
import { Box, Button, Typography } from '@mui/material';
import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type Ref,
} from 'react';

import { useOptionalAiStatus } from '../../contexts/AiStatusContext';
import { synthesizeSpeech } from '../../services/api';

/** Which voice actually spoke. See {@link QuestionAudioProps.onPlayed}. */
export type QuestionAudioSource = 'browser' | 'premium';

/**
 * Why playback stopped. See {@link QuestionAudioProps.onFinished}.
 *
 * There is deliberately no `'cancelled'` member: a cancel does not fire
 * `onFinished` at all (see the file header), so a caller that switched on a
 * third value here would be writing a branch that can never run — and one that
 * looks, to the next reader, like the guarantee runs the other way.
 */
export type QuestionAudioFinishReason = 'ended' | 'failed';

/** What `onFinished` is handed. */
export interface QuestionAudioFinished {
  /**
   * `'ended'` — the audio ran to its own natural end.
   * `'failed'` — playback is over and nothing further will speak this text.
   *
   * Both mean "stop waiting". They are distinguished because a driver that
   * wants to say something about a failure (or count one) cannot recover the
   * difference afterwards, and conflating them is how a silent failure becomes
   * indistinguishable from a question the learner actually heard.
   */
  reason: QuestionAudioFinishReason;
  /**
   * Which voice was speaking, or trying to.
   *
   * `null` only on the one case where neither could: `reason: 'failed'` with no
   * source is the same state the live region's `unavailable` copy describes.
   */
  source: QuestionAudioSource | null;
}

/** The imperative surface a driver gets from a `ref`. */
export interface QuestionAudioHandle {
  /**
   * Silence playback immediately, on whichever path is speaking.
   *
   * IDEMPOTENT, and it never fires `onFinished` — this is the caller's own
   * barge-in, and the caller does not need to be told about the silence it just
   * asked for. Safe to call when nothing is playing.
   */
  stop: () => void;
}

/**
 * Every string this component can put on screen.
 *
 * All five default to the civics-question wording this component was written
 * for, so an existing caller passes nothing and reads exactly as before.
 */
export interface QuestionAudioCopy {
  /** The button, at rest. */
  play: string;
  /** The button, while audio is playing. */
  stop: string;
  /** The button, while a premium synthesis request is in flight. */
  preparing: string;
  /** The live region, while audio is playing. */
  speaking: string;
  /**
   * The live region, when NEITHER voice could speak.
   *
   * The default's second sentence ("The text is above") is a statement about
   * the HOST page, which is why this is overridable at all: on the writing
   * screen the text is not above, and saying so would be both false and a
   * pointer at the one thing that screen must never show.
   */
  unavailable: string;
}

/**
 * The browser-voice playback rate when the caller passes none.
 *
 * The value this component hard-coded before #288, kept as the default so a
 * caller that knows nothing about preferences sounds exactly as it did. It
 * MIRRORS `DEFAULT_VOICE_SPEECH_RATE` (`hooks/useVoicePrefs.ts`, itself
 * mirroring the API's constant) rather than importing it, so this component
 * stays free of any dependency on the settings layer — it takes props, and the
 * host page is what knows where a preference is stored.
 */
export const DEFAULT_SPEECH_RATE = 0.95;

const DEFAULT_COPY: QuestionAudioCopy = {
  play: 'Read the question aloud',
  stop: 'Stop reading',
  preparing: 'Preparing the voice…',
  speaking: 'Reading the question aloud.',
  unavailable: 'The question could not be read aloud. The text is above.',
};

/**
 * Can this browser speak on its own — no binding, no key, no network?
 *
 * THE ONE DEFINITION, used by this component to decide whether to render a
 * button at all and by the writing screen to decide whether it can run its
 * exercise at all. Both `speechSynthesis` and `SpeechSynthesisUtterance` are
 * checked because a browser (or a jsdom test environment) can have one without
 * the other, and `speak()` on a half-implemented API throws rather than
 * degrading.
 */
/**
 * Every mounted instance's `stop`, so starting one can silence the rest.
 *
 * Module-level and deliberately not a context: there is exactly one pair of
 * speakers, an instance rendered outside any provider must still yield to one
 * rendered inside it, and a `Set` of stable callbacks is the whole mechanism.
 * See the file header for what it prevents.
 */
const ACTIVE_PLAYERS = new Set<() => void>();

/** Silence every OTHER instance. Idempotent, and a no-op when this is the only one. */
function stopOtherPlayers(self: () => void): void {
  for (const other of ACTIVE_PLAYERS) {
    if (other !== self) other();
  }
}

export function browserSpeechAvailable(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.speechSynthesis !== 'undefined' &&
    typeof window.SpeechSynthesisUtterance === 'function'
  );
}

export interface QuestionAudioProps {
  /** The question, exactly as it is rendered on screen. */
  text: string;

  /**
   * The learner asked for the premium, provider-hosted voice.
   *
   * Defaults to FALSE, which is the whole point: the browser voice is the
   * default (§2). The upgrade is taken only when this is true AND the `speak`
   * role is bound on this deployment.
   *
   * Stored as `user_settings.voice.preferPremiumVoice` since #288 (epic #280),
   * read through `useVoicePrefs` and passed in by the host page. It stays a
   * PROP rather than being read here, so this component keeps working on a
   * caller that has no opinion (the default is still `false`) and so the two
   * practice screens that disagree about the rule — `/practice/writing` uses
   * premium only when the browser has NO voice at all — can each state their
   * own.
   */
  premiumVoice?: boolean;

  /**
   * The PROVIDER's voice id (e.g. `alloy`), or omitted to let it choose.
   *
   * `user_settings.voice.preferredVoice` (#288). Applies to the PREMIUM path
   * only: it is sent as the synthesis request's `voice` field. The browser's
   * `speechSynthesis` has its own, unrelated voice list keyed by BCP-47 name,
   * and picking a browser voice from a provider's id would be a coincidence
   * rather than a match — so an id that means nothing to `speechSynthesis` is
   * simply not applied there.
   */
  voice?: string;

  /**
   * Playback speed as a multiplier of normal, e.g. `0.95`.
   *
   * `user_settings.voice.speechRate` (#288). Applies to the BROWSER path only,
   * which is where the hard-coded `0.95` this replaces lived: `utterance.rate`
   * is a client-side playback parameter, and the provider's synthesis endpoint
   * has no speed control this application uses today. That gap is named
   * deliberately in `docs/specs/voice-hands-free.md` §5 rather than papered
   * over with a rate this component silently ignores on one of its two paths.
   */
  rate?: number;

  /**
   * The question was ACTUALLY SPOKEN — fired when audio starts, not when a
   * button is pressed.
   *
   * This is what lets a caller record `prompt_mode = 'heard'` rather than
   * `'read'` on the attempt it eventually writes (a sibling issue's job; this
   * component only surfaces the fact). It is deliberately not "the learner
   * clicked play": a click that produced no sound — a synthesis request that
   * failed, an autoplay block — is a question that was read, not heard, and
   * recording it as heard would put a claim in the evidence table that never
   * happened.
   */
  onPlayed?: (source: QuestionAudioSource) => void;

  /**
   * Playback is OVER — exactly once per play, and never for a cancel.
   *
   * Issue #311, epic #304 / E13: the completion half of `onPlayed`, and what a
   * "read the question, then listen" loop advances on. The three rules it is
   * worth restating at the call site are in the file header: once per play (a
   * premium attempt that falls through to the browser voice reports one end,
   * not two), never for a `stop()` or a barge-in, and `reason: 'failed'` rather
   * than silence when a premium clip dies mid-playback, so a driver cannot wait
   * forever on an end that is not coming.
   *
   * OPTIONAL, and every caller that predates #311 passes nothing: a component
   * with no listener behaves exactly as it did.
   */
  onFinished?: (event: QuestionAudioFinished) => void;

  /**
   * A handle for cutting playback off from OUTSIDE this component.
   *
   * {@link QuestionAudioHandle}. `ACTIVE_PLAYERS` already covers one player
   * starting while another speaks; this covers the case it cannot see — a
   * driver that decides, for a reason living entirely in the host (the learner
   * started talking, the turn moved on), that this must stop now.
   */
  ref?: Ref<QuestionAudioHandle>;

  /**
   * Speak as soon as this mounts (and again whenever `text` changes), with no
   * click.
   *
   * FALSE BY DEFAULT, and a caller should only set it from a stored preference
   * the learner turned on — `user_settings.voice.readQuestionsAloud` /
   * `readAnswersAloud` (#288). Audio that starts by itself is intrusive when
   * nobody asked for it, so there is no "on by default" reading of this prop.
   *
   * A BLOCKED AUTOPLAY IS NOT AN ERROR. Browsers refuse sound until the
   * document has had a user gesture, and `playBlob` already returns `false`
   * rather than throwing in that case, so the ordinary fall-through applies and
   * nothing is shown. The host is what knows whether a gesture has happened —
   * it passes `false` until one has — because this component sees only its own
   * button, which by definition was not pressed.
   */
  autoPlay?: boolean;

  /** Passed through to the button. */
  size?: 'small' | 'medium' | 'large';

  /**
   * Override any of the five strings. See {@link QuestionAudioCopy}.
   *
   * Partial and merged over the defaults, so a caller that only needs a
   * different button label does not have to restate the other four and cannot
   * drift from them when they change.
   */
  copy?: Partial<QuestionAudioCopy>;
}

export function QuestionAudio({
  text,
  premiumVoice = false,
  voice,
  rate = DEFAULT_SPEECH_RATE,
  onPlayed,
  onFinished,
  ref,
  autoPlay = false,
  size = 'small',
  copy,
}: QuestionAudioProps) {
  const words = { ...DEFAULT_COPY, ...copy };
  // Pulled out as a PRIMITIVE because it is read inside two `useCallback`s and
  // `words` is a fresh object on every render — a dependency array holding the
  // object would rebuild both callbacks every time, which is exactly the
  // needless-invalidation this component's `requestRef` guard is compensating
  // for elsewhere. A string compares by value and does not.
  const unavailableMessage = words.unavailable;
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [isPreparing, setIsPreparing] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  /**
   * Which play request is current.
   *
   * A learner pressing the button twice, or moving to the next question while a
   * synthesis request is in flight, must not end up with the previous
   * question's audio talking over the current one. Every async continuation
   * checks this before touching state or starting playback.
   */
  const requestRef = useRef(0);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const objectUrlRef = useRef<string | null>(null);

  /**
   * The latest `onFinished`, without making it a callback dependency.
   *
   * The same device — and the same reason — as `playRef` below: a host that
   * passes an inline arrow would otherwise rebuild `speakWithBrowser` and
   * `play` on every render of the page above, and this component's whole
   * autoplay guard is built on those identities being stable.
   */
  const onFinishedRef = useRef(onFinished);
  onFinishedRef.current = onFinished;

  /**
   * The request number already reported as finished, so one play reports once.
   *
   * A single number rather than a boolean: `requestRef` is monotonic, so
   * "already reported" is a comparison and there is no flag anybody has to
   * remember to reset when the next play starts.
   */
  const reportedRef = useRef(0);

  /**
   * Report the end of ONE play — at most once, and never for a superseded one.
   *
   * The `requestRef` check is what makes a cancel silent: `stop()` bumps the
   * counter before `speechSynthesis.cancel()` reaches the utterance it is
   * interrupting, so the `onerror` that arrives belongs to a request that is no
   * longer current and nothing is reported. See the file header.
   */
  const finish = useCallback((request: number, event: QuestionAudioFinished) => {
    if (request !== requestRef.current) return;
    if (reportedRef.current === request) return;
    reportedRef.current = request;
    onFinishedRef.current?.(event);
  }, []);

  // POINT-OF-USE, SO THE NON-THROWING ACCESSOR. This control lives inside
  // practice and interview screens whose reason to exist has nothing to do with
  // AI; `useAiStatus` would blank the whole tree if one of them ever rendered
  // without the provider above it. `null` here means "we do not know whether
  // `speak` is bound", which resolves to the browser voice — the right answer
  // for an unknown, and the one that always works.
  const aiStatus = useOptionalAiStatus();
  const speakBound =
    !!aiStatus?.status && !aiStatus.status.unboundRoles.includes('speak');
  const usePremium = premiumVoice && speakBound;

  const supportsBrowserSpeech = browserSpeechAvailable();

  const revokeObjectUrl = useCallback(() => {
    const url = objectUrlRef.current;
    objectUrlRef.current = null;
    if (url && typeof URL.revokeObjectURL === 'function') URL.revokeObjectURL(url);
  }, []);

  /** Silence whatever is playing and let go of its bytes. Idempotent. */
  const stop = useCallback(() => {
    requestRef.current += 1;

    if (typeof window !== 'undefined' && window.speechSynthesis) {
      window.speechSynthesis.cancel();
    }

    const audio = audioRef.current;
    audioRef.current = null;
    if (audio) {
      audio.pause();
      // Detach the source before the URL is revoked, so the element is not left
      // holding a handle to bytes we have just released.
      audio.removeAttribute('src');
    }
    revokeObjectUrl();

    setIsSpeaking(false);
    setIsPreparing(false);
  }, [revokeObjectUrl]);

  // THE CALLER'S OWN BARGE-IN (#311). `stop` is already idempotent and already
  // the callback `ACTIVE_PLAYERS` holds, so the handle is that exact function
  // rather than a second way to stop that could drift from it. React 19 takes
  // `ref` as an ordinary prop, so there is no `forwardRef` here — and no
  // precedent in this codebase to follow either way.
  useImperativeHandle(ref, () => ({ stop }), [stop]);

  // Leaving the screen, or moving to a different question, silences the voice.
  // A question still being read aloud over the next one is disorienting, and on
  // the premium path it is also audio nobody is listening to.
  useEffect(() => stop, [stop, text]);

  // Join the "one voice at a time" set for as long as this instance is mounted.
  // See the file header: this is what makes a SECOND mount — the accepted
  // answer's player, #287 — unable to talk over the first.
  useEffect(() => {
    ACTIVE_PLAYERS.add(stop);
    return () => {
      ACTIVE_PLAYERS.delete(stop);
    };
  }, [stop]);

  const speakWithBrowser = useCallback(
    (request: number): boolean => {
      if (!supportsBrowserSpeech) return false;

      const utterance = new window.SpeechSynthesisUtterance(text);
      // A civics question read at conversational speed is hard to follow for
      // somebody studying in a second language, which is most of the people
      // this product is for. `0.95` is therefore still the DEFAULT (see
      // `DEFAULT_SPEECH_RATE`); since #288 a learner who wants it slower or
      // faster can say so on `/settings/voice`, and this is where their answer
      // lands.
      utterance.rate = rate;

      utterance.onstart = () => {
        if (request !== requestRef.current) return;
        setIsSpeaking(true);
        // ACTUALLY SPOKEN. See `onPlayed`.
        onPlayed?.('browser');
      };
      utterance.onend = () => {
        if (request !== requestRef.current) return;
        setIsSpeaking(false);
        // THE GENUINE END of the browser path. See `onFinished`.
        finish(request, { reason: 'ended', source: 'browser' });
      };
      utterance.onerror = (event) => {
        if (request !== requestRef.current) return;
        setIsSpeaking(false);
        // `cancel()` reports the utterance it interrupted as an error. That is
        // this component stopping itself, not a failure to report to anybody —
        // and emphatically not a completion: `onFinished` stays silent, so a
        // loop the learner barged in on does not advance over them. (The
        // `requestRef` guard above has already returned for a `stop()`-driven
        // cancel; this covers an engine that reports one without our asking.)
        const reason = (event as SpeechSynthesisErrorEvent).error;
        if (reason === 'canceled' || reason === 'interrupted') return;
        setMessage(unavailableMessage);
        // A real synthesis failure. Nothing else is going to speak this text,
        // so a driver is told to stop waiting rather than left hanging.
        finish(request, { reason: 'failed', source: 'browser' });
      };

      window.speechSynthesis.speak(utterance);
      return true;
    },
    [finish, onPlayed, rate, supportsBrowserSpeech, text, unavailableMessage],
  );

  const play = useCallback(async () => {
    setMessage(null);
    // EVERY OTHER MOUNTED PLAYER FIRST, then this one's own leftovers. The
    // order matters: `speakWithBrowser` below hands an utterance to the same
    // global engine every other instance's `stop()` cancels, so cancelling
    // after starting would silence the thing we are starting.
    stopOtherPlayers(stop);
    stop();
    const request = (requestRef.current += 1);

    if (usePremium) {
      setIsPreparing(true);
      try {
        // `voice` is the learner's stored preference, or absent — in which
        // case the provider chooses, and the request omits the key entirely
        // rather than sending an empty one (see `synthesizeSpeech`).
        const result = await synthesizeSpeech(text, { voice });
        if (request !== requestRef.current) return;

        // BRANCHED ON, NOT CAUGHT (issue #277). `unavailable` and `failed` are
        // ordinary HTTP 200 answers carrying a cause, so the fall-through to
        // the browser voice below is now reached BY DECISION. It used to be
        // reached because a JSON envelope was handed to an `<audio>` element
        // and the resulting play error landed in the `catch` — the right
        // outcome for the wrong reason, one refactor away from silence.
        //
        // NEITHER OUTCOME IS SHOWN TO ANYBODY, and that is unchanged. A
        // `speak`-unbound deployment answers "not available" and a provider can
        // simply fail; the browser voice below reads the same question, so from
        // the learner's side nothing went wrong — and a warning about a premium
        // upgrade they may not know exists would be noise about a feature that
        // is working. `docs/specs/voice.md` §2.
        if (result.status === 'ok') {
          const played = await playBlob(result.audio, {
            onStart: () => {
              if (request !== requestRef.current) return;
              setIsSpeaking(true);
              onPlayed?.('premium');
            },
            onEnded: () => {
              if (request !== requestRef.current) return;
              setIsSpeaking(false);
              revokeObjectUrl();
              // THE GENUINE END of the premium path.
              finish(request, { reason: 'ended', source: 'premium' });
            },
            onError: (started) => {
              if (request !== requestRef.current) return;
              setIsSpeaking(false);
              revokeObjectUrl();
              // THE SPLIT #311 EXISTS FOR — see `playBlob`. A clip that had
              // already STARTED is the end of this play: `playBlob` resolved
              // `true`, so the browser fall-through below is unreachable and
              // silence here would hang a driver forever on an end that is not
              // coming. A clip that never started is NOT reported: the browser
              // voice is about to speak the same sentence and report its own
              // end, and one play must fire `onFinished` once.
              if (started) finish(request, { reason: 'failed', source: 'premium' });
            },
            audioRef,
            objectUrlRef,
          });

          if (played) return;
        }
      } catch {
        // Kept for what this always really caught: a transport failure
        // (`ApiError`, a dropped connection) or a `playBlob` that could not
        // start. Same silence, for the same reason as above — the browser voice
        // is next, and it reads the same question.
      } finally {
        if (request === requestRef.current) setIsPreparing(false);
      }
    }

    if (speakWithBrowser(request)) return;

    // Neither voice is available. Said plainly, once, in a live region — and
    // the question text is still on the page, which is the actual content.
    setMessage(unavailableMessage);
    // `source: null` — nothing spoke, so naming a voice would be a claim about
    // audio that never existed. Reported all the same, because a driver waiting
    // on a play that could not happen is the one failure mode with no symptom.
    finish(request, { reason: 'failed', source: null });
  }, [
    finish,
    onPlayed,
    revokeObjectUrl,
    speakWithBrowser,
    stop,
    text,
    unavailableMessage,
    usePremium,
    voice,
  ]);

  /**
   * The latest `play`, without making it an effect dependency.
   *
   * `play` is rebuilt whenever any of its eight inputs changes — the AI status
   * landing, a preference resolving — and an autoplay effect that depended on
   * it would re-speak the same sentence on each of those, which is the one
   * thing unrequested audio must never do.
   */
  const playRef = useRef(play);
  playRef.current = play;

  // AUTOPLAY: ONCE PER `text`, NEVER ON A RE-RENDER. Runs after the `stop`
  // effect above (declared earlier, so its cleanup has already silenced the
  // previous sentence), and no-ops silently when the browser refuses sound for
  // want of a gesture — see the `autoPlay` prop.
  useEffect(() => {
    if (!autoPlay) return;
    void playRef.current();
  }, [autoPlay, text]);

  // The control is ABSENT rather than disabled when nothing could speak. See
  // the file header.
  if (!supportsBrowserSpeech && !usePremium) return null;

  return (
    <Box
      sx={{
        display: 'flex',
        // Wraps rather than overflowing at 360px, where the button and its
        // status line do not fit on one row.
        flexWrap: 'wrap',
        alignItems: 'center',
        gap: 1,
      }}
    >
      <Button
        size={size}
        variant="text"
        startIcon={isSpeaking ? <StopIcon /> : <VolumeUpIcon />}
        onClick={isSpeaking ? stop : play}
        disabled={isPreparing}
        // The button's own text IS its accessible name — no `aria-label`
        // duplicating it, and no icon-only control whose name a screen reader
        // has to guess at.
      >
        {isSpeaking ? words.stop : isPreparing ? words.preparing : words.play}
      </Button>

      {/* Always mounted, empty when idle: a live region inserted at the same
          moment as its text is frequently never announced at all. */}
      <Box role="status" aria-live="polite">
        {isSpeaking && (
          <Typography variant="body2" color="text.secondary">
            {words.speaking}
          </Typography>
        )}
        {!isSpeaking && message && (
          <Typography variant="body2" color="text.secondary">
            {message}
          </Typography>
        )}
      </Box>
    </Box>
  );
}

/**
 * Play synthesized bytes, returning whether they actually started.
 *
 * `false` (or a throw) sends the caller to the browser voice, which is why
 * `play()`'s rejection — an autoplay policy blocking sound the learner did in
 * fact ask for, most often — is not an error state: something else can speak.
 *
 * THE OBJECT URL IS THE SERVER'S SYNTHESIS OF A PUBLIC QUESTION, NOT ANYBODY'S
 * VOICE. `docs/specs/voice.md` §4 forbids retaining the LEARNER'S recording;
 * this is the opposite direction. It is still revoked the moment playback ends
 * or is stopped, because a blob URL nobody revokes pins its bytes for the
 * lifetime of the document.
 *
 * SUCCESS AND FAILURE ARE TWO CALLBACKS, NOT ONE (#311). Until E13 this
 * function aliased them — `audio.onerror = ctx.onEnd` — which was harmless
 * while the only job either had was to drop the state and the bytes, and is
 * not harmless now that a caller advances a conversation on the difference: a
 * clip that died halfway through would have reported itself as a question the
 * learner heard to the end. `onError` also carries WHETHER PLAYBACK HAD
 * STARTED, which is the one fact only this function holds — its caller sees a
 * `false` return for "never started" but nothing at all for a mid-clip death,
 * because by then the promise it awaited has long resolved.
 */
async function playBlob(
  blob: Blob,
  ctx: {
    onStart: () => void;
    /** The element reached the end of the clip. A genuine completion. */
    onEnded: () => void;
    /**
     * The element failed. `started` is true when sound had already begun,
     * which is what tells the caller whether its browser-voice fall-through is
     * still ahead of it (`false`) or already out of reach (`true`).
     */
    onError: (started: boolean) => void;
    audioRef: { current: HTMLAudioElement | null };
    objectUrlRef: { current: string | null };
  },
): Promise<boolean> {
  if (
    typeof URL === 'undefined' ||
    typeof URL.createObjectURL !== 'function' ||
    typeof Audio === 'undefined'
  ) {
    return false;
  }

  const url = URL.createObjectURL(blob);
  ctx.objectUrlRef.current = url;

  // Tracked HERE because the element does not report it: `onerror` is the same
  // event whether sound had begun or not, and the difference is what the caller
  // needs. See this function's header.
  let started = false;

  const audio = new Audio(url);
  ctx.audioRef.current = audio;
  audio.onplay = () => {
    started = true;
    ctx.onStart();
  };
  audio.onended = ctx.onEnded;
  audio.onerror = () => ctx.onError(started);

  try {
    await audio.play();
    return true;
  } catch {
    // NEVER STARTED — an autoplay policy, most often. The caller falls through
    // to the browser voice, so this is a cleanup call, not the end of anything.
    ctx.onError(started);
    return false;
  }
}

export default QuestionAudio;

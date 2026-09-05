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
 */

import StopIcon from '@mui/icons-material/Stop';
import VolumeUpIcon from '@mui/icons-material/VolumeUp';
import { Box, Button, Typography } from '@mui/material';
import { useCallback, useEffect, useRef, useState } from 'react';

import { useOptionalAiStatus } from '../../contexts/AiStatusContext';
import { synthesizeSpeech } from '../../services/api';

/** Which voice actually spoke. See {@link QuestionAudioProps.onPlayed}. */
export type QuestionAudioSource = 'browser' | 'premium';

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
   * Where the opt-in is stored is a later issue's business — this component
   * takes it as a prop so that the preference and the player can ship
   * independently.
   */
  premiumVoice?: boolean;

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
  onPlayed,
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

  // Leaving the screen, or moving to a different question, silences the voice.
  // A question still being read aloud over the next one is disorienting, and on
  // the premium path it is also audio nobody is listening to.
  useEffect(() => stop, [stop, text]);

  const speakWithBrowser = useCallback(
    (request: number): boolean => {
      if (!supportsBrowserSpeech) return false;

      const utterance = new window.SpeechSynthesisUtterance(text);
      // A civics question read at conversational speed is hard to follow for
      // somebody studying in a second language, which is most of the people
      // this product is for.
      utterance.rate = 0.95;

      utterance.onstart = () => {
        if (request !== requestRef.current) return;
        setIsSpeaking(true);
        // ACTUALLY SPOKEN. See `onPlayed`.
        onPlayed?.('browser');
      };
      utterance.onend = () => {
        if (request !== requestRef.current) return;
        setIsSpeaking(false);
      };
      utterance.onerror = (event) => {
        if (request !== requestRef.current) return;
        setIsSpeaking(false);
        // `cancel()` reports the utterance it interrupted as an error. That is
        // this component stopping itself, not a failure to report to anybody.
        const reason = (event as SpeechSynthesisErrorEvent).error;
        if (reason === 'canceled' || reason === 'interrupted') return;
        setMessage(unavailableMessage);
      };

      window.speechSynthesis.speak(utterance);
      return true;
    },
    [onPlayed, supportsBrowserSpeech, text, unavailableMessage],
  );

  const play = useCallback(async () => {
    setMessage(null);
    stop();
    const request = (requestRef.current += 1);

    if (usePremium) {
      setIsPreparing(true);
      try {
        const result = await synthesizeSpeech(text);
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
            onEnd: () => {
              if (request !== requestRef.current) return;
              setIsSpeaking(false);
              revokeObjectUrl();
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
  }, [
    onPlayed,
    revokeObjectUrl,
    speakWithBrowser,
    stop,
    text,
    unavailableMessage,
    usePremium,
  ]);

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
 */
async function playBlob(
  blob: Blob,
  ctx: {
    onStart: () => void;
    onEnd: () => void;
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

  const audio = new Audio(url);
  ctx.audioRef.current = audio;
  audio.onplay = ctx.onStart;
  audio.onended = ctx.onEnd;
  audio.onerror = ctx.onEnd;

  try {
    await audio.play();
    return true;
  } catch {
    ctx.onEnd();
    return false;
  }
}

export default QuestionAudio;

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
 */

import StopIcon from '@mui/icons-material/Stop';
import VolumeUpIcon from '@mui/icons-material/VolumeUp';
import { Box, Button, Typography } from '@mui/material';
import { useCallback, useEffect, useRef, useState } from 'react';

import { useOptionalAiStatus } from '../../contexts/AiStatusContext';
import { synthesizeSpeech } from '../../services/api';

/** Which voice actually spoke. See {@link QuestionAudioProps.onPlayed}. */
export type QuestionAudioSource = 'browser' | 'premium';

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
}

export function QuestionAudio({
  text,
  premiumVoice = false,
  onPlayed,
  size = 'small',
}: QuestionAudioProps) {
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

  const supportsBrowserSpeech =
    typeof window !== 'undefined' &&
    typeof window.speechSynthesis !== 'undefined' &&
    typeof window.SpeechSynthesisUtterance === 'function';

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
        setMessage('The question could not be read aloud. The text is above.');
      };

      window.speechSynthesis.speak(utterance);
      return true;
    },
    [onPlayed, supportsBrowserSpeech, text],
  );

  const play = useCallback(async () => {
    setMessage(null);
    stop();
    const request = (requestRef.current += 1);

    if (usePremium) {
      setIsPreparing(true);
      try {
        const blob = await synthesizeSpeech(text);
        if (request !== requestRef.current) return;

        const played = await playBlob(blob, {
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
      } catch {
        // A `speak`-unbound deployment answers "not available" and a provider
        // can simply fail. NEITHER IS SHOWN TO ANYBODY: the browser voice below
        // reads the same question, so from the learner's side nothing went
        // wrong — and a warning about a premium upgrade they may not know
        // exists would be noise about a feature that is working.
      } finally {
        if (request === requestRef.current) setIsPreparing(false);
      }
    }

    if (speakWithBrowser(request)) return;

    // Neither voice is available. Said plainly, once, in a live region — and
    // the question text is still on the page, which is the actual content.
    setMessage('The question could not be read aloud. The text is above.');
  }, [
    onPlayed,
    revokeObjectUrl,
    speakWithBrowser,
    stop,
    text,
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
        {isSpeaking
          ? 'Stop reading'
          : isPreparing
            ? 'Preparing the voice…'
            : 'Read the question aloud'}
      </Button>

      {/* Always mounted, empty when idle: a live region inserted at the same
          moment as its text is frequently never announced at all. */}
      <Box role="status" aria-live="polite">
        {isSpeaking && (
          <Typography variant="body2" color="text.secondary">
            Reading the question aloud.
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

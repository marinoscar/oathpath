/**
 * The six `user_settings.voice` controls, and the voice picker.
 *
 * Issue #288, epic #280. Rendered by `pages/VoiceSettingsPage.tsx` inside the
 * shared `UserSettingsSection` chrome — the same split
 * `UserNotificationsPage` / `NotificationSettings` already use, so the settings
 * fetch, the loading spinner, the fetch-error alert and the save snackbars have
 * exactly one copy in this codebase and this file has none of them.
 *
 * =============================================================================
 * ABSENT MEANS THE BUILT-IN DEFAULT. NOTHING IS WRITTEN ON RENDER.
 * =============================================================================
 *
 * The same contract `StudyReminderSettings` keeps, for the same reason, held
 * here by the same three properties:
 *
 *   A. THERE IS NO LOCAL COPY OF THE NAMESPACE. Every control derives its value
 *      from the stored namespace (normally `undefined`) resolved through
 *      `resolveVoicePreferences`. A defaulted local object is the thing that
 *      gets serialised on the first save and materialises all six keys.
 *   B. MOUNTING WRITES NOTHING. No effect, no save-on-render, no Save button
 *      batching a full document. A learner who opens this page and reads it has
 *      stored no opinion, and a later release that changes a default still
 *      reaches them.
 *   C. MOVING A CONTROL BACK TO THE DEFAULT SENDS A NULL-DELETE (see
 *      `writeFor`), never the default value.
 *
 * =============================================================================
 * AN UNBOUND `speak` IS NOT A WARNING, AND MUST NEVER BE RENDERED AS ONE
 * =============================================================================
 *
 * `docs/specs/voice.md` §2 and `voice-hands-free.md` §6: an unbound `speak`
 * role is the state of EVERY fresh install. The browser's own
 * `speechSynthesis` reads every question and every sentence, at whatever
 * `speechRate` the learner set, so nothing is missing and nothing has failed.
 * The premium section therefore says one plain sentence and stops — no
 * `severity="warning"`, no `<Alert>`, and above all no `AiNotReady`, whose own
 * header names telling somebody the product is broken while it works as the
 * exact failure to avoid. `AiNotReady` answers a different question
 * (`systemReady === false`, the TEXT roles), and it is not this one.
 *
 * THE ONE HONEST EXCEPTION IS `no_user_key`. That is the single cause a learner
 * can actually do something about, so it — and only it — gets copy that says
 * so and a link to `/settings/ai`. It is still not an error: everything on this
 * page keeps working, because the browser voice never needed a key.
 *
 * =============================================================================
 * PREVIEW COSTS ONE SYNTHESIS CALL ON THE LEARNER'S OWN KEY
 * =============================================================================
 *
 * So it fires on an EXPLICIT PRESS and on nothing else. Not on focus, not on
 * hover, not on arrowing through the radio group, and not on choosing a voice:
 * a picker that synthesizes as you scroll is a picker that bills you for
 * scrolling. Selecting a voice saves the preference and makes no audio at all.
 * `previewRef` additionally makes a double-press a no-op rather than a second
 * charge.
 */

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Link as RouterLink } from 'react-router-dom';
import {
  Box,
  Button,
  Card,
  CardContent,
  Divider,
  FormControl,
  FormControlLabel,
  FormLabel,
  Link,
  Radio,
  RadioGroup,
  Slider,
  Switch,
  Typography,
} from '@mui/material';
import VolumeUpIcon from '@mui/icons-material/VolumeUp';

import { synthesizeSpeech } from '../../services/api';
import {
  DEFAULT_VOICE_AUTO_SUBMIT_SPOKEN,
  DEFAULT_VOICE_PREFER_PREMIUM,
  DEFAULT_VOICE_READ_ANSWERS_ALOUD,
  DEFAULT_VOICE_READ_QUESTIONS_ALOUD,
  DEFAULT_VOICE_SPEECH_RATE,
  VOICE_SPEECH_RATE_MAX,
  VOICE_SPEECH_RATE_MIN,
  resolveVoicePreferences,
} from '../../hooks/useVoicePrefs';
import type {
  SpeechVoice,
  VoiceSettings as VoiceSettingsValue,
  VoiceSettingsPatch,
} from '../../types';

/**
 * What a preview says.
 *
 * A REAL CIVICS QUESTION (number 13 on the 2008 test), not "the quick brown
 * fox". A learner choosing a voice is choosing the voice that will read them
 * hundreds of these, so the sample should be the thing they will actually
 * hear — its cadence, its proper nouns, its question intonation — rather than
 * a pangram that demonstrates none of it.
 */
export const VOICE_PREVIEW_SENTENCE =
  'Who is in charge of the executive branch?';

/** The value the radio group uses for "no stored preference". */
const PROVIDER_DEFAULT = '__provider_default__';

/** Slider stops. Coarse on purpose — a rate is a feel, not a measurement. */
const RATE_MARKS = [
  { value: 0.5, label: 'Slower' },
  { value: 0.75, label: '' },
  { value: 1, label: 'Normal' },
  { value: 1.25, label: '' },
  { value: 1.5, label: '' },
  { value: 2, label: 'Faster' },
];

/**
 * What to send for a value the learner just chose: the value, or `null`.
 *
 * `null` is the DELETE. Writing today's default back because the learner
 * happened to land on it pins them to it forever, invisibly, including after a
 * later release moves it — see rule C in the file header.
 */
export function writeFor<T>(next: T, builtInDefault: T): T | null {
  return next === builtInDefault ? null : next;
}

/** What the preview is currently saying, if anything. */
type PreviewState =
  | { kind: 'idle' }
  | { kind: 'preparing'; voiceId: string }
  | { kind: 'playing'; voiceId: string; label: string }
  | { kind: 'message'; text: string; needsKey?: boolean };

export interface VoiceSettingsProps {
  /**
   * THE RAW STORED NAMESPACE, `undefined` for every account that has never
   * touched it — which is the normal case. Deliberately not defaulted by the
   * caller: see rule A in the file header.
   */
  voice: VoiceSettingsValue | undefined;

  /** The premium voices this deployment can offer. Empty is ordinary. */
  voices: SpeechVoice[];

  /**
   * Has an administrator bound a model to the `speak` role?
   *
   * `false` on every fresh install. It changes the COPY of the premium section
   * and nothing else — see the file header on why it is never a warning.
   */
  speakBound: boolean;

  /**
   * Does this learner have their own AI key stored?
   *
   * `null` when unknown (the status has not loaded, or there is no
   * `AiStatusProvider` above). Unknown says nothing, which is the right
   * treatment: a "you have no key" line that flashes on every load of a
   * correctly configured account is not merely noisy, it is false.
   */
  userKeyConfigured: boolean | null;

  /** True while a PATCH is in flight. Every control goes inert. */
  isSaving?: boolean;

  /** Emits the ONE field that changed, already reduced to its write form. */
  onChange: (patch: VoiceSettingsPatch) => void;
}

export function VoiceSettings({
  voice,
  voices,
  speakBound,
  userKeyConfigured,
  isSaving = false,
  onChange,
}: VoiceSettingsProps) {
  // `useId` rather than literal ids, so a second instance of this section could
  // never point every `aria-describedby` at the first one's copy.
  const idPrefix = useId();
  const autoSubmitHelpId = `${idPrefix}-auto-submit-help`;
  const readQuestionsHelpId = `${idPrefix}-read-questions-help`;
  const readAnswersHelpId = `${idPrefix}-read-answers-help`;
  const premiumHelpId = `${idPrefix}-premium-help`;
  const voiceLabelId = `${idPrefix}-voice-label`;
  const voiceHelpId = `${idPrefix}-voice-help`;
  const rateLabelId = `${idPrefix}-rate-label`;
  const rateHelpId = `${idPrefix}-rate-help`;

  const resolved = resolveVoicePreferences(voice);

  const [preview, setPreview] = useState<PreviewState>({ kind: 'idle' });

  /**
   * A synthesis request is IN FLIGHT, so a second press is a no-op rather than
   * a second charge on the learner's key.
   *
   * A ref as well as the disabled attribute below, because the two guard
   * different things: `disabled` stops the pointer, and this stops everything
   * else — a double-fire from a fast keyboard repeat, a click that lands in the
   * same tick as the render that disables the button. It covers the REQUEST
   * only; once bytes are playing, pressing another Preview is a legitimate
   * "no, that one" and stops the first.
   */
  const previewRef = useRef(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const objectUrlRef = useRef<string | null>(null);

  const releaseAudio = useCallback(() => {
    const audio = audioRef.current;
    audioRef.current = null;
    if (audio) {
      audio.pause();
      audio.removeAttribute('src');
    }
    const url = objectUrlRef.current;
    objectUrlRef.current = null;
    if (url && typeof URL.revokeObjectURL === 'function') {
      URL.revokeObjectURL(url);
    }
    previewRef.current = false;
  }, []);

  // Leaving the page silences the sample and lets go of its bytes. A blob URL
  // nobody revokes pins them for the lifetime of the document.
  useEffect(() => releaseAudio, [releaseAudio]);

  /**
   * Speak the sample in one specific voice. **Called from a click handler and
   * from nowhere else** — see the file header.
   */
  const previewVoice = useCallback(
    async (voiceId: string, label: string) => {
      if (previewRef.current) return;
      releaseAudio();
      previewRef.current = true;
      setPreview({ kind: 'preparing', voiceId });

      let result;
      try {
        result = await synthesizeSpeech(VOICE_PREVIEW_SENTENCE, {
          // Omitted entirely for the provider-default row, never sent empty.
          voice: voiceId === PROVIDER_DEFAULT ? undefined : voiceId,
        });
      } catch {
        // A genuine transport failure (a 401, a dropped connection) is the only
        // thing that reaches here: `synthesizeSpeech` never rejects for an AI
        // reason. Said plainly, and nothing about the page stops working.
        previewRef.current = false;
        setPreview({
          kind: 'message',
          text: "We couldn't play that sample just now. Everything else on this page still works.",
        });
        return;
      } finally {
        // The REQUEST is over either way. Whether it produced audio is the
        // next question, and it does not gate the other Preview buttons.
        previewRef.current = false;
      }

      // SWITCHED ON, NEVER ASSUMED (issue #277). `unavailable` and `failed` are
      // ordinary HTTP 200 answers, and a client that reads `result.audio`
      // without checking gets a `TypeError` on a learner's screen — which is
      // the shipped bug that lesson comes from.
      if (result.status === 'unavailable') {
        setPreview(
          result.cause === 'no_user_key'
            ? {
                kind: 'message',
                needsKey: true,
                text: 'Previews use your own AI key, and there is no key saved on your account yet.',
              }
            : {
                kind: 'message',
                text: 'The high-quality voice is not available here, so there is nothing to preview. Your browser still reads everything aloud.',
              },
        );
        return;
      }

      if (result.status === 'failed') {
        setPreview({
          kind: 'message',
          text: `We couldn't play the ${label} sample just now. Your browser still reads everything aloud.`,
        });
        return;
      }

      const played = playSample(result.audio, {
        audioRef,
        objectUrlRef,
        onEnd: () => {
          releaseAudio();
          setPreview({ kind: 'idle' });
        },
      });

      if (played) {
        setPreview({ kind: 'playing', voiceId, label });
        return;
      }

      setPreview({
        kind: 'message',
        text: `We couldn't play the ${label} sample just now. Your browser still reads everything aloud.`,
      });
    },
    [releaseAudio],
  );

  const previewStatusText =
    preview.kind === 'preparing'
      ? 'Preparing the sample…'
      : preview.kind === 'playing'
        ? `Playing a sample in the ${preview.label} voice.`
        : preview.kind === 'message'
          ? preview.text
          : '';

  return (
    <>
      {/* ===================================================================
          ANSWERING OUT LOUD
          =================================================================== */}
      <Card>
        <CardContent>
          <Typography variant="h6" component="h2" gutterBottom>
            Answering out loud
          </Typography>

          <FormControlLabel
            disabled={isSaving}
            label="Submit my spoken answer straight away"
            control={
              <Switch
                checked={resolved.autoSubmitSpoken}
                onChange={(_event, next) =>
                  onChange({
                    autoSubmitSpoken: writeFor(
                      next,
                      DEFAULT_VOICE_AUTO_SUBMIT_SPOKEN,
                    ),
                  })
                }
                // `slotProps.input`, never `<Switch aria-describedby>`: MUI
                // forwards unknown props to the ROOT span, leaving the element
                // that actually carries `role="switch"` undescribed.
                slotProps={{ input: { 'aria-describedby': autoSubmitHelpId } }}
              />
            }
          />
          <Typography
            id={autoSubmitHelpId}
            variant="body2"
            color="text.secondary"
            sx={{ maxWidth: '62ch' }}
          >
            When this is on, we grade your answer the moment you finish
            speaking. Turn it off if you would rather read what we heard, fix
            anything that came out wrong, and send it yourself.
          </Typography>
        </CardContent>
      </Card>

      {/* ===================================================================
          READING ALOUD
          =================================================================== */}
      <Card>
        <CardContent>
          <Typography variant="h6" component="h2" gutterBottom>
            Reading aloud
          </Typography>

          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <Box>
              <FormControlLabel
                disabled={isSaving}
                label="Read questions to me automatically"
                control={
                  <Switch
                    checked={resolved.readQuestionsAloud}
                    onChange={(_event, next) =>
                      onChange({
                        readQuestionsAloud: writeFor(
                          next,
                          DEFAULT_VOICE_READ_QUESTIONS_ALOUD,
                        ),
                      })
                    }
                    slotProps={{
                      input: { 'aria-describedby': readQuestionsHelpId },
                    }}
                  />
                }
              />
              <Typography
                id={readQuestionsHelpId}
                variant="body2"
                color="text.secondary"
                sx={{ maxWidth: '62ch' }}
              >
                Each question starts playing as soon as it appears, so you can
                practise listening the way the interview will sound. With this
                off, questions stay silent until you press play.
              </Typography>
            </Box>

            <Box>
              <FormControlLabel
                disabled={isSaving}
                label="Read the answer to me automatically"
                control={
                  <Switch
                    checked={resolved.readAnswersAloud}
                    onChange={(_event, next) =>
                      onChange({
                        readAnswersAloud: writeFor(
                          next,
                          DEFAULT_VOICE_READ_ANSWERS_ALOUD,
                        ),
                      })
                    }
                    slotProps={{
                      input: { 'aria-describedby': readAnswersHelpId },
                    }}
                  />
                }
              />
              <Typography
                id={readAnswersHelpId}
                variant="body2"
                color="text.secondary"
                sx={{ maxWidth: '62ch' }}
              >
                Once an answer is revealed, you hear it as well as read it —
                useful for getting the pronunciation of names and places. With
                this off, the answer is shown quietly.
              </Typography>
            </Box>
          </Box>

          <Divider sx={{ my: 3 }} />

          {/* -----------------------------------------------------------------
              Speaking speed. BROWSER PATH ONLY, and it says so.
              ----------------------------------------------------------------- */}
          <Typography
            id={rateLabelId}
            component="h3"
            variant="subtitle1"
            gutterBottom
          >
            Speaking speed
          </Typography>
          <Typography
            id={rateHelpId}
            variant="body2"
            color="text.secondary"
            sx={{ mb: 1, maxWidth: '62ch' }}
          >
            How quickly your browser reads things to you. Slower is easier to
            follow while a phrase is still new; there is no prize for
            understanding it fast.
          </Typography>
          <Box sx={{ px: 1, maxWidth: 420 }}>
            <Slider
              value={resolved.speechRate}
              min={VOICE_SPEECH_RATE_MIN}
              max={VOICE_SPEECH_RATE_MAX}
              step={0.05}
              marks={RATE_MARKS}
              disabled={isSaving}
              valueLabelDisplay="auto"
              valueLabelFormat={(value: number) => `${value.toFixed(2)}x`}
              // A slider is not a `<label>`-able control, so its accessible
              // name is the heading above it, referenced — the same outcome a
              // real label gives, without inventing a second visible one.
              aria-labelledby={rateLabelId}
              aria-describedby={rateHelpId}
              aria-valuetext={`${resolved.speechRate.toFixed(2)} times normal speed`}
              // `onChangeCommitted`, not `onChange`: a PATCH per pixel of drag
              // would be dozens of writes for one decision.
              onChangeCommitted={(_event, next) => {
                const value = Array.isArray(next) ? next[0] : next;
                onChange({
                  speechRate: writeFor(
                    Number(value.toFixed(2)),
                    DEFAULT_VOICE_SPEECH_RATE,
                  ),
                });
              }}
            />
          </Box>
        </CardContent>
      </Card>

      {/* ===================================================================
          THE HIGH-QUALITY VOICE
          =================================================================== */}
      <Card>
        <CardContent>
          <Typography variant="h6" component="h2" gutterBottom>
            The high-quality voice
          </Typography>

          <FormControlLabel
            disabled={isSaving}
            label="Use the high-quality voice when it is available"
            control={
              <Switch
                checked={resolved.preferPremiumVoice}
                onChange={(_event, next) =>
                  onChange({
                    preferPremiumVoice: writeFor(
                      next,
                      DEFAULT_VOICE_PREFER_PREMIUM,
                    ),
                  })
                }
                slotProps={{ input: { 'aria-describedby': premiumHelpId } }}
              />
            }
          />
          <Typography
            id={premiumHelpId}
            variant="body2"
            color="text.secondary"
            sx={{ maxWidth: '62ch' }}
          >
            Your browser can already read everything aloud for free. When a
            high-quality voice is set up, this asks for that one instead — it
            sounds closer to a person speaking, and it runs on your own AI key.
          </Typography>

          {/* PLAIN TEXT, NOT AN ALERT AND NOT `AiNotReady`. See the file
              header: an unbound `speak` is the ordinary state of a fresh
              install, everything on this page keeps working, and saying
              otherwise would tell a learner the product is broken while it
              reads their questions to them. */}
          {!speakBound && (
            <Typography
              variant="body2"
              color="text.secondary"
              sx={{ mt: 2, maxWidth: '62ch' }}
            >
              No high-quality voice is set up on this deployment, so there is
              nothing to choose between here. Everything above still applies to
              your browser&apos;s own voice, which reads every question and
              sentence.
            </Typography>
          )}

          {/* THE ONE HONEST "you can fix this". `no_user_key` is the single
              cause that is the learner's own to resolve, so it is the single
              one that gets a remedy and a link. Still not an error: the browser
              voice never needed a key. */}
          {speakBound && userKeyConfigured === false && (
            <Typography
              variant="body2"
              color="text.secondary"
              sx={{ mt: 2, maxWidth: '62ch' }}
            >
              The high-quality voice runs on your own AI key, and there is no
              key saved on your account yet. You can{' '}
              <Link component={RouterLink} to="/settings/ai">
                add a key
              </Link>{' '}
              whenever you like — until then your browser reads everything
              aloud, as it does now.
            </Typography>
          )}

          {speakBound && voices.length > 0 && (
            <Box sx={{ mt: 3 }}>
              <FormControl>
                <FormLabel id={voiceLabelId} component="legend">
                  Voice
                </FormLabel>
                <Typography
                  id={voiceHelpId}
                  variant="body2"
                  color="text.secondary"
                  sx={{ mb: 1, maxWidth: '62ch' }}
                >
                  Pick whichever one is easiest for you to follow. Press Preview
                  to hear a real question read in that voice — that is the only
                  thing here that uses your key, and only when you press it.
                </Typography>

                <RadioGroup
                  aria-labelledby={voiceLabelId}
                  aria-describedby={voiceHelpId}
                  value={resolved.preferredVoice ?? PROVIDER_DEFAULT}
                  // SELECTING A VOICE MAKES NO AUDIO. See the file header.
                  onChange={(_event, next) =>
                    onChange({
                      preferredVoice:
                        next === PROVIDER_DEFAULT ? null : next,
                    })
                  }
                >
                  {[
                    {
                      id: PROVIDER_DEFAULT,
                      // 'Standard', not 'Standard voice' — the Preview
                      // control's accessible name is built as
                      // `Preview the ${label} voice`, and the longer label
                      // makes that read "the Standard voice voice".
                      label: 'Standard',
                      description:
                        'Whichever voice this deployment uses by default.',
                    },
                    ...voices,
                  ].map((option) => (
                    <Box
                      key={option.id}
                      sx={{
                        display: 'flex',
                        flexDirection: { xs: 'column', sm: 'row' },
                        alignItems: { xs: 'flex-start', sm: 'center' },
                        gap: { xs: 0.5, sm: 2 },
                        py: 0.5,
                      }}
                    >
                      <FormControlLabel
                        value={option.id}
                        disabled={isSaving}
                        control={<Radio />}
                        label={
                          <Box>
                            <Typography variant="body1" component="span">
                              {option.label}
                            </Typography>
                            {option.description && (
                              <Typography
                                variant="body2"
                                color="text.secondary"
                              >
                                {option.description}
                              </Typography>
                            )}
                          </Box>
                        }
                        sx={{ mr: 0, flexGrow: 1 }}
                      />
                      <Button
                        size="small"
                        variant="text"
                        startIcon={<VolumeUpIcon />}
                        // ONLY `onClick`. No `onFocus`, no `onMouseEnter`, no
                        // key handler — each of those would spend the learner's
                        // key on a gesture that is not a request for audio.
                        onClick={() => {
                          void previewVoice(option.id, option.label);
                        }}
                        // Inert only while a REQUEST is in flight — that is
                        // the window a second press would spend the key twice
                        // in. Once audio is playing, pressing another Preview
                        // is a legitimate "no, that one" and stops the first.
                        disabled={isSaving || preview.kind === 'preparing'}
                        // The accessible name NAMES THE VOICE. "Preview" alone
                        // is six identical buttons to anyone listening to the
                        // page rather than looking at it. The visible word is
                        // contained in the accessible name, so a speech-input
                        // user saying "Preview" still matches.
                        aria-label={`Preview the ${option.label} voice`}
                      >
                        Preview
                      </Button>
                    </Box>
                  ))}
                </RadioGroup>
              </FormControl>

              {/* Always mounted, empty when idle: a live region inserted at the
                  same moment as its text is frequently never announced at all. */}
              <Box role="status" aria-live="polite" sx={{ mt: 1 }}>
                {previewStatusText && (
                  <Typography
                    variant="body2"
                    color="text.secondary"
                    sx={{ maxWidth: '62ch' }}
                  >
                    {previewStatusText}{' '}
                    {preview.kind === 'message' && preview.needsKey && (
                      <Link component={RouterLink} to="/settings/ai">
                        Add a key
                      </Link>
                    )}
                  </Typography>
                )}
              </Box>
            </Box>
          )}
        </CardContent>
      </Card>
    </>
  );
}

/**
 * Play synthesized bytes, returning whether playback was started.
 *
 * Deliberately NOT awaited by the caller. `HTMLAudioElement.play()` resolves
 * when playback BEGINS, which in jsdom (and behind an autoplay policy) may be
 * never — so this reports "the element accepted the source and we asked it to
 * play", and the `onStart`/`onEnd` callbacks report what actually happened.
 * `false` means there was nothing here that could play at all.
 */
function playSample(
  blob: Blob,
  ctx: {
    audioRef: { current: HTMLAudioElement | null };
    objectUrlRef: { current: string | null };
    onEnd: () => void;
  },
): boolean {
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
  audio.onended = ctx.onEnd;
  audio.onerror = ctx.onEnd;

  try {
    // The rejection is handled rather than dropped: an autoplay policy blocking
    // sound the learner explicitly asked for is not an error state, it just
    // means no sample is coming.
    void Promise.resolve(audio.play()).catch(() => ctx.onEnd());
  } catch {
    ctx.onEnd();
    return false;
  }

  return true;
}

export default VoiceSettings;

/**
 * The eight `user_settings.voice` controls, and the voice picker.
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
 *
 * =============================================================================
 * THE AUDIO ELEMENT IS UNLOCKED INSIDE THE PRESS, BEFORE THE FIRST `await`
 * =============================================================================
 *
 * Issue #383, and the reason `beginPreview` exists as a separate function from
 * `requestPreview`. A mobile browser only plays audio through an element that
 * was itself started during a user gesture. `synthesizeSpeech` is a network
 * round trip, so an element constructed AFTER that `await` is an element the
 * press never touched: Android Chrome and iOS Safari reject its `play()`, and
 * they reject it silently — from the learner's side, Preview simply does
 * nothing at all.
 *
 * So the click handler is SYNCHRONOUS, and everything that has to happen
 * inside the activation window happens in it, in this order:
 *
 *   1. ONE `HTMLAudioElement`, acquired into `audioRef` and kept for the life
 *      of this component — never one per press. An element only has to be
 *      unlocked once; a fresh element per preview is a fresh lock every time.
 *   2. IT IS PRIMED: a data-URI of silence is assigned and played, then paused.
 *      That is no request, no synthesis call and no audible sound (the
 *      one-call-per-press rule above is not negotiable), and it leaves the
 *      element user-activated — so the `src` swap that happens later, in the
 *      continuation, plays with no gesture of its own.
 *   3. Only then is the async half started, with `void requestPreview(...)`.
 *
 * A LATER EDIT THAT MOVES THE PRIMING OR THE PLAYBACK BACK AFTER AN `await`
 * REINTRODUCES #383 EXACTLY — and does so invisibly on a desktop browser,
 * where playback after any gesture in the page is permitted and the whole
 * thing looks like it works.
 *
 * `releaseSample` is named for the same reason: it releases a SAMPLE — pause,
 * drop the `src`, revoke the blob URL — and never the element, because the
 * element is what carries the activation. Discarding the element is an
 * unmount-only act.
 *
 * SINCE #389 ALL THREE CALLS LIVE IN `lib/audioUnlock.ts`, not at the bottom of
 * this file: `CoachSettings` and `QuestionAudio` had the identical
 * after-the-await shape, and a subtle ordering rule stated in one of the three
 * places it governs is a rule the other two are free to undo. That module's
 * header is now where the full argument lives; what stays here is the part
 * specific to a preview that spends a key.
 *
 * =============================================================================
 * BLOCKED PLAYBACK IS NAMED. IT IS NEVER RETURNED TO `idle` IN SILENCE
 * =============================================================================
 *
 * Also #383. A rejected `play()` used to run the same `onEnd` a finished
 * sample runs, which set the state back to `idle` — so "your phone would not
 * play this" and "you have just heard it" looked identical on screen. Blocked
 * playback is the ONE outcome a learner most needs named, because it is the
 * one they can act on: unmute the phone, press Preview again.
 *
 * So `playAudioSample` takes three separate callbacks and they mean three
 * separate things — `onEnded` (the sample finished, go back to `idle`),
 * `onBlocked` (the `play()` promise rejected), and `onError` (the element
 * itself failed on the bytes). Collapsing any of them back into a shared
 * handler restores the silence this fixed.
 *
 * IT IS STILL NOT AN ERROR, and the copy must never say the product is
 * broken — see the `speak` section above. The browser's own voice is reading
 * every question either way; what failed is one optional sample.
 *
 * =============================================================================
 * THE STATUS BELONGS TO ONE VOICE, AND SO DOES THE BUSY TREATMENT
 * =============================================================================
 *
 * Also #383. Both halves of this used to be page-wide:
 *
 *   - The status was one box AFTER the whole radio group. On a phone that is
 *     several screens below the button that was just pressed, so feedback for a
 *     press arrived somewhere the learner was not looking. It is now rendered
 *     IN THE ROW of the voice it concerns, under that voice's own button.
 *   - `preview.kind === 'preparing'` disabled ALL of the Preview buttons, which
 *     is feedback pointing at no particular voice. `preparing` has always
 *     carried its `voiceId`; only that one goes inert (and shows a spinner)
 *     now. The others stay pressable, because pressing another one is a
 *     legitimate "no, that one" — and `previewRef` is what actually stops a
 *     second charge, not the disabled attribute.
 *
 * THERE IS STILL EXACTLY ONE `role="status"` REGION, IT IS ALWAYS MOUNTED, AND
 * IT NEVER MOVES. That is not decoration: a live region inserted into the DOM
 * at the same moment as its text is frequently never announced at all, and a
 * region that moves between parents is inserted afresh every time it moves. So
 * the announcement and the visible copy are deliberately separated —
 *
 *   - the live region holds the sentence, visually hidden, at a fixed place;
 *   - the row holds the visible sentence, `aria-hidden`, so the same words are
 *     not read twice;
 *   - the "Add a key" link lives in the row and is NOT hidden, because a
 *     remedy has to be reachable;
 *   - and if the current preview names a voice that is no longer in the
 *     catalog, the live region renders the sentence VISIBLY instead, so a
 *     message with no row to live in is still on screen.
 *
 * ELEVEN LIVE REGIONS AND ZERO LIVE REGIONS ARE BOTH WRONG. If a later edit
 * needs the text somewhere else, move the visible copy, never the region.
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
import visuallyHidden from '@mui/utils/visuallyHidden';

import {
  acquireAndPrimeAudio,
  playAudioSample,
  releaseAudioSample,
} from '../../lib/audioUnlock';
import { synthesizeSpeech } from '../../services/api';
import {
  DEFAULT_VOICE_AUTO_SUBMIT_SPOKEN,
  DEFAULT_VOICE_CONVERSATION_MODE,
  DEFAULT_VOICE_PREFER_PREMIUM,
  DEFAULT_VOICE_READ_ANSWERS_ALOUD,
  DEFAULT_VOICE_READ_QUESTIONS_ALOUD,
  DEFAULT_VOICE_SOUND_CUES,
  DEFAULT_VOICE_SPEECH_RATE,
  VOICE_SPEECH_RATE_MAX,
  VOICE_SPEECH_RATE_MIN,
  resolveVoicePreferences,
  writeFor,
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

/**
 * What a blocked `play()` says.
 *
 * EXPORTED SO A TEST CAN PIN IT (#383). It names the one thing that actually
 * happened and the one thing the learner can do about it, and it stops — no
 * "something went wrong", no alert, and no suggestion that the page is
 * broken, because it is not: the browser's own voice reads every question
 * regardless, which is the sentence that closes it.
 */
export const PLAYBACK_BLOCKED_MESSAGE =
  'Your browser blocked the sample from playing. Check that your phone is not ' +
  'muted, then press Preview again. Everything is still read aloud by your ' +
  "browser's own voice.";

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
 * The null-delete reducer every control on this page uses — see rule C in the
 * file header for what it prevents.
 *
 * DEFINED IN `hooks/useVoicePrefs.ts`, beside the `DEFAULT_VOICE_*` constants
 * it is always called with, since #313 gave the practice screen a second
 * surface that writes a voice preference. Re-exported here unchanged, so this
 * file is still where a reader of the settings page finds it.
 */
export { writeFor };

/** What the preview is currently saying, if anything. */
type PreviewState =
  | { kind: 'idle' }
  | { kind: 'preparing'; voiceId: string }
  | { kind: 'playing'; voiceId: string; label: string }
  | { kind: 'message'; text: string; voiceId?: string; needsKey?: boolean };

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

/**
 * The `voice.conversationMode` switch's label.
 *
 * EXPORTED SO A TEST CAN PIN IT AGAINST WHAT IT ACTUALLY DOES (#350, epic
 * #345). #313 shipped this switch promising to "start practice sessions
 * hands-free" while it started nothing — it seeded a mode and left the loop
 * behind a second, separate tap — and nothing in the suite could notice,
 * because the label lived in this file and the behaviour lived two screens
 * away with no shared symbol between them. This constant is that symbol:
 * `PracticeOneTapHandsFree.test.tsx` imports it, reads the promise out of the
 * string, and then proves the flow keeps it. Rewording the label without
 * changing the flow now fails a test rather than quietly becoming a lie again.
 */
export const CONVERSATION_MODE_LABEL = 'Start practice sessions hands-free';

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
  const conversationHelpId = `${idPrefix}-conversation-help`;
  const soundCuesHelpId = `${idPrefix}-sound-cues-help`;
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

  /**
   * THE ONE audio element, unlocked once and reused by every preview.
   *
   * Not one per press — see the file header (#383). An element that was played
   * inside a user gesture stays user-activated, so swapping its `src` later
   * plays without a second gesture, which is the entire fix.
   */
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const objectUrlRef = useRef<string | null>(null);

  /**
   * Let go of the SAMPLE — the playback and the bytes — and of nothing else.
   *
   * Deliberately not the old `releaseAudio`, which nulled `audioRef`: the
   * element carries the user activation from the press that unlocked it, and a
   * replacement would carry none. Discarding it is an unmount-only act, below.
   */
  const releaseSample = useCallback(() => {
    releaseAudioSample({ audioRef, objectUrlRef });
  }, []);

  // Leaving the page silences the sample, lets go of its bytes, and is the ONE
  // place the element itself is discarded. A blob URL nobody revokes pins those
  // bytes for the lifetime of the document.
  useEffect(
    () => () => {
      releaseSample();
      audioRef.current = null;
      previewRef.current = false;
    },
    [releaseSample],
  );

  /**
   * The ASYNC half of a preview: one synthesis call, then the bytes.
   *
   * **Never wired to an event handler.** `beginPreview` below is the click
   * handler, and it runs the gesture-time half first — see the file header on
   * why that order is load-bearing rather than stylistic.
   */
  const requestPreview = useCallback(
    async (voiceId: string, label: string) => {
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
          voiceId,
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
                voiceId,
                needsKey: true,
                text: 'Previews use your own AI key, and there is no key saved on your account yet.',
              }
            : {
                kind: 'message',
                voiceId,
                text: 'The high-quality voice is not available here, so there is nothing to preview. Your browser still reads everything aloud.',
              },
        );
        return;
      }

      if (result.status === 'failed') {
        setPreview({
          kind: 'message',
          voiceId,
          text: `We couldn't play the ${label} sample just now. Your browser still reads everything aloud.`,
        });
        return;
      }

      const { attached: played } = playAudioSample(result.audio, {
        audioRef,
        objectUrlRef,
        // Finished. Nothing to say — the learner just heard it.
        onEnded: () => {
          releaseSample();
          setPreview({ kind: 'idle' });
        },
        // BLOCKED, which is a different thing from finished and says so. The
        // remedy is the learner's own and it is one sentence long.
        onBlocked: () => {
          releaseSample();
          setPreview({
            kind: 'message',
            voiceId,
            text: PLAYBACK_BLOCKED_MESSAGE,
          });
        },
        // The element rejected the bytes. Also stated, for the same reason:
        // returning quietly to `idle` reads as "that was the sample".
        onError: () => {
          releaseSample();
          setPreview({
            kind: 'message',
            voiceId,
            text: `We couldn't play the ${label} sample just now. Your browser still reads everything aloud.`,
          });
        },
      });

      if (played) {
        setPreview({ kind: 'playing', voiceId, label });
        return;
      }

      setPreview({
        kind: 'message',
        voiceId,
        text: `We couldn't play the ${label} sample just now. Your browser still reads everything aloud.`,
      });
    },
    [releaseSample],
  );

  /**
   * THE CLICK HANDLER, and the synchronous half of a preview.
   *
   * Everything the browser's autoplay policy measures happens here, inside the
   * activation window the press opened: the element is acquired and primed
   * before a single `await` has been reached. `requestPreview` is then started
   * detached — see the file header for why splitting these two is the fix for
   * #383 rather than a tidying-up.
   */
  const beginPreview = useCallback(
    (voiceId: string, label: string) => {
      if (previewRef.current) return;

      // ─── GESTURE TIME. Nothing below this line may move after an `await`. ──
      releaseSample();
      acquireAndPrimeAudio(audioRef);

      previewRef.current = true;
      setPreview({ kind: 'preparing', voiceId });
      void requestPreview(voiceId, label);
    },
    [releaseSample, requestPreview],
  );

  const previewStatusText =
    preview.kind === 'preparing'
      ? 'Preparing the sample…'
      : preview.kind === 'playing'
        ? `Playing a sample in the ${preview.label} voice.`
        : preview.kind === 'message'
          ? preview.text
          : '';

  /** The voice the current status is ABOUT, if it is about one. */
  const previewVoiceId = preview.kind === 'idle' ? null : (preview.voiceId ?? null);

  /**
   * Is there a row on screen for that voice?
   *
   * Normally yes — every preview starts from a press on one of these rows. It
   * is `false` only if the catalog changed under a preview that was already in
   * flight, and that is exactly the case the visible fallback in the live
   * region exists for: a message with nowhere to live must still be readable.
   */
  const previewHasRow =
    previewVoiceId !== null &&
    (previewVoiceId === PROVIDER_DEFAULT ||
      voices.some((option) => option.id === previewVoiceId));

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

          {/* CONVERSATION MODE (#313, epic #304 / E13; behaviour completed by
              #350, epic #345).

              IN THIS CARD, not a new one, and not a new settings page: it
              answers the same question its neighbour above does — what happens
              when you answer out loud — and `CLAUDE.md`'s Settings UI Pattern
              reserves a new destination for a new question, never for one more
              switch about an existing one.

              THE LABEL IS NOW TRUE. #313 shipped this switch labelled "Start
              practice sessions hands-free" while it started nothing at all: it
              only seeded the session screen's `Text | Voice` control, and the
              loop still needed a second, separate "Start hands-free" tap. #350
              moved the mode choice onto `/practice` and made starting a session
              with Voice chosen start the loop too — so the label describes what
              happens, and the help text below describes the one arrival it does
              not cover (resuming a session already under way, where arming is
              still a deliberate tap). `VoiceSettings.test.tsx` pins the two
              against each other.

              Bound with `writeFor` like every other control here, so turning it
              back off sends the null-delete rather than pinning this learner to
              today's `false` forever. See rule C in the file header. */}
          <Box sx={{ mt: 2 }}>
            <FormControlLabel
              disabled={isSaving}
              label={CONVERSATION_MODE_LABEL}
              control={
                <Switch
                  checked={resolved.conversationMode}
                  onChange={(_event, next) =>
                    onChange({
                      conversationMode: writeFor(
                        next,
                        DEFAULT_VOICE_CONVERSATION_MODE,
                      ),
                    })
                  }
                  // `slotProps.input` for the same reason as its neighbour
                  // above: MUI forwards unknown props to the ROOT span, leaving
                  // the element that carries `role="switch"` undescribed.
                  slotProps={{ input: { 'aria-describedby': conversationHelpId } }}
                />
              }
            />
            <Typography
              id={conversationHelpId}
              variant="body2"
              color="text.secondary"
              sx={{ maxWidth: '62ch' }}
            >
              Practice starts on Voice instead of Text, and starting a session
              opens your microphone and begins straight away &mdash; so you can
              put the phone down and answer out loud. Coming back to a session
              you left waits for you to start it. You can switch back to typing
              at any moment, and nothing you have already answered is lost.
            </Typography>
          </Box>

          {/* SOUND CUES (#357, epic #345).

              IN THIS CARD for the same reason `conversationMode` is: it
              answers the same question its two neighbours do — what happens
              when you answer out loud. The cues exist only inside the
              hands-free loop, so a learner who never turns that on never hears
              one, and a settings destination of their own would be a page
              about three tones.

              `writeFor` like every other control here, so turning them back on
              sends the null-delete rather than pinning this learner to today's
              `true`. See rule C in the file header. */}
          <Box sx={{ mt: 2 }}>
            <FormControlLabel
              disabled={isSaving}
              label="Play sounds while I practise hands-free"
              control={
                <Switch
                  checked={resolved.soundCues}
                  onChange={(_event, next) =>
                    onChange({
                      soundCues: writeFor(next, DEFAULT_VOICE_SOUND_CUES),
                    })
                  }
                  // `slotProps.input` for the same reason as its neighbours
                  // above: MUI forwards unknown props to the ROOT span, leaving
                  // the element that carries `role="switch"` undescribed.
                  slotProps={{ input: { 'aria-describedby': soundCuesHelpId } }}
                />
              }
            />
            <Typography
              id={soundCuesHelpId}
              variant="body2"
              color="text.secondary"
              sx={{ maxWidth: '62ch' }}
            >
              Short tones mark when the microphone opens, while we are working
              out your answer, and when a session ends, so you can keep the
              phone in your pocket. Turn them off for a quiet room — questions
              and answers are still read aloud either way.
            </Typography>
          </Box>
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
                  ].map((option) => {
                    // THIS voice's request, not any request. See the file
                    // header: a page-wide busy state points at no voice.
                    const isPreparingThis =
                      preview.kind === 'preparing' &&
                      preview.voiceId === option.id;
                    const showsStatusHere =
                      previewStatusText !== '' && previewVoiceId === option.id;

                    return (
                      // The handle a test uses to prove the status really is IN
                      // THIS ROW rather than merely somewhere on the page — the
                      // whole point of #383's third defect, and not a claim
                      // "there is a status somewhere" could ever make.
                      <Box
                        key={option.id}
                        data-testid={`voice-row-${option.id}`}
                        sx={{ py: 0.5 }}
                      >
                      <Box
                        sx={{
                          display: 'flex',
                          flexDirection: { xs: 'column', sm: 'row' },
                          alignItems: { xs: 'flex-start', sm: 'center' },
                          gap: { xs: 0.5, sm: 2 },
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
                          // `beginPreview`, NOT `void previewVoice(...)`: the
                          // handler has to prime the audio element while the
                          // press is still the current user activation. See the
                          // file header (#383).
                          onClick={() => {
                            beginPreview(option.id, option.label);
                          }}
                          // A VISIBLE BUSY AFFORDANCE ON THE PRESSED BUTTON, so
                          // the learner can see which voice is being prepared.
                          // MUI's `loading` also makes this one button inert.
                          loading={isPreparingThis}
                          loadingPosition="start"
                          // Inert only while THIS voice's request is in flight.
                          // Not while any request is: the other rows stay
                          // pressable, because pressing another Preview is a
                          // legitimate "no, that one" — and `previewRef`, not
                          // this attribute, is what stops a second charge.
                          disabled={isSaving}
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

                      {/* THE STATUS, IN THE ROW IT BELONGS TO — under the button
                          that was pressed, rather than several screens below it.
                          `aria-hidden` on the sentence because the live region
                          below already announces it; the link is outside that,
                          because a remedy has to be reachable. See the file
                          header. */}
                      {showsStatusHere && (
                        <Typography
                          variant="body2"
                          color="text.secondary"
                          sx={{ mt: 0.5, ml: { sm: 4 }, maxWidth: '62ch' }}
                        >
                          <Box component="span" aria-hidden="true">
                            {previewStatusText}
                          </Box>{' '}
                          {preview.kind === 'message' && preview.needsKey && (
                            <Link component={RouterLink} to="/settings/ai">
                              Add a key
                            </Link>
                          )}
                        </Typography>
                      )}
                      </Box>
                    );
                  })}
                </RadioGroup>
              </FormControl>

              {/* THE ONE LIVE REGION. Always mounted, empty when idle, and it
                  never moves: a live region inserted at the same moment as its
                  text is frequently never announced at all, and one that
                  changes parents is inserted afresh every time. The visible
                  copy is in the row instead — see the file header. */}
              <Box role="status" aria-live="polite" sx={{ mt: 1 }}>
                {previewStatusText &&
                  (previewHasRow ? (
                    // Announced here, read on screen in the row above.
                    <Box component="span" sx={visuallyHidden}>
                      {previewStatusText}
                    </Box>
                  ) : (
                    // No row to live in — so it is visible here instead, rather
                    // than being a message nobody can see.
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
                  ))}
              </Box>
            </Box>
          )}
        </CardContent>
      </Card>
    </>
  );
}

export default VoiceSettings;

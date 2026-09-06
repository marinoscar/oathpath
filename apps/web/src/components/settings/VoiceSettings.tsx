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
 * ONE REUSED `<audio>`, UNLOCKED BEFORE THE FIRST `await` (#383)
 * =============================================================================
 *
 * A phone will not let a page make sound unless the element making it was
 * created or played inside a user gesture. A gesture is a WINDOW, not a flag:
 * it closes at the first `await`, and `previewVoice` awaits a synthesis round
 * trip that takes a second or more. So the shipped code — `new Audio(url)`
 * built AFTER the bytes arrived — asked a brand new, never-touched element to
 * play long after the tap that justified it, and every mobile browser
 * correctly refused. Eleven Preview buttons greyed out, came back, and made no
 * sound at all, with nothing on screen to say why.
 *
 * Two properties fix it, and BOTH are load-bearing:
 *
 *   1. THERE IS EXACTLY ONE `<audio>` ELEMENT, kept in `audioRef` for the life
 *      of the component. The unlock is granted per ELEMENT, so building a
 *      fresh one per press throws away the permission the previous press
 *      earned. It is emptied between presses (`releaseAudio`) and replaced
 *      never.
 *   2. IT IS PRIMED SYNCHRONOUSLY INSIDE THE CLICK HANDLER — muted, sourceless
 *      `play()`, rejection swallowed — BEFORE the first `await`. That call is
 *      what spends the gesture and marks the element user-initiated; the real
 *      `play()`, seconds later on the same element, then inherits it.
 *
 * A later refactor that moves `primePreviewAudio()` below the `await`, or that
 * nulls `audioRef` between presses, restores the silence exactly and breaks
 * nothing a desktop test would notice. `VoiceSettingsPage.test.tsx` pins the
 * priming call for that reason.
 *
 * AND A REFUSAL IS NOW VISIBLE. A rejected `play()` used to be routed into the
 * same `onEnd` as a clip that finished — byte-identical, to the learner, to
 * "the sample played" — so a blocked preview looked like a broken one. It gets
 * its own message now, in the same register as everything else here: the
 * browser voice still reads every question, so nothing is actually lost.
 */

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Link as RouterLink } from 'react-router-dom';
import {
  Box,
  Button,
  Card,
  CardContent,
  CircularProgress,
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

/**
 * What the preview is currently saying, if anything.
 *
 * EVERY NON-IDLE MEMBER CARRIES `voiceId`, INCLUDING `message` (#383). That is
 * what lets the feedback render in the row of the button that was pressed,
 * rather than in one box below a list that is eleven rows and several phone
 * screens long — where the learner who pressed the button never sees it.
 */
type PreviewState =
  | { kind: 'idle' }
  | { kind: 'preparing'; voiceId: string }
  | { kind: 'playing'; voiceId: string; label: string }
  | { kind: 'message'; voiceId: string; text: string; needsKey?: boolean };

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
   * THE ONE `<audio>` ELEMENT, for the life of the component.
   *
   * Never nulled between presses — see the file header. The autoplay unlock a
   * tap earns belongs to this element, so replacing it is how the fix undoes
   * itself. Created lazily by `primePreviewAudio`, dropped only on unmount.
   */
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const objectUrlRef = useRef<string | null>(null);

  /**
   * WHICH PRESS THE CURRENTLY INTERESTING ONE IS.
   *
   * `play()`'s rejection and the element's `onerror` both arrive later than the
   * press that caused them, and a learner comparing voices presses Preview
   * again long before either. Without this, a refusal belonging to the sample
   * they abandoned would overwrite the state of the one they are listening to
   * now — the stale-callback bug that is invisible on a fast connection and
   * routine on a phone.
   */
  const previewSeqRef = useRef(0);

  /**
   * Drop the SAMPLE — the bytes, the source and the handlers. **Keeps the
   * element**, which is the whole point (file header, property 1).
   */
  const releaseAudio = useCallback(() => {
    const audio = audioRef.current;
    if (audio) {
      audio.pause();
      audio.onended = null;
      audio.onerror = null;
      // `removeAttribute`, not `src = ''`: an empty string resolves against the
      // document URL, so the element would go and try to load this page as
      // media and report the 404 as a decode error.
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
  // nobody revokes pins them for the lifetime of the document. The ELEMENT is
  // released here and nowhere else — between presses it is the thing being
  // kept, not the thing being cleaned up.
  useEffect(
    () => () => {
      releaseAudio();
      audioRef.current = null;
    },
    [releaseAudio],
  );

  /**
   * Hand back the one `<audio>` element, unlocked for the gesture in progress.
   *
   * **MUST BE CALLED SYNCHRONOUSLY FROM THE CLICK HANDLER, BEFORE THE FIRST
   * `await`.** Everything about this function is that requirement; see the
   * file header for what a phone does when it is not met. The muted, sourceless
   * `play()` below is not an attempt to make sound — it is the call that spends
   * the tap and marks this element as one the learner asked to hear. Its
   * rejection is expected (there is nothing to play) and deliberately dropped.
   *
   * Returns `null` where there is no `Audio` constructor at all — jsdom, a
   * stripped embedded browser — so the caller degrades to saying so rather than
   * throwing.
   */
  const primePreviewAudio = useCallback((): HTMLAudioElement | null => {
    if (typeof Audio === 'undefined') return null;

    let audio = audioRef.current;
    if (!audio) {
      // No source argument: the element must exist and be unlocked BEFORE the
      // bytes do, which is the entire ordering this fix is about.
      audio = new Audio();
      audio.preload = 'auto';
      // iOS reads the ATTRIBUTE. The matching `playsInline` property is typed
      // on video elements only, and an attribute is what the platform honours
      // here anyway. `?.` because a test double need not implement it.
      audio.setAttribute?.('playsinline', '');
      audioRef.current = audio;
    }

    // Muted, because at this instant the element has no source and there is
    // nothing to hear — and because an unmuted priming call is exactly the
    // "page that made a noise I did not ask for" a browser is entitled to
    // punish. Unmuted again in `playPreparedSample`, on the same element.
    audio.muted = true;
    try {
      const started: unknown = audio.play();
      if (started && typeof (started as Promise<void>).catch === 'function') {
        // EXPECTED, AND NOT AN ERROR. Older browsers return `undefined` here,
        // which is why the promise is feature-detected rather than assumed.
        void (started as Promise<void>).catch(() => {});
      }
    } catch {
      // A synchronous throw is the same non-event: the gesture is spent either
      // way, and whether it worked is answered by the real `play()` later.
    }

    return audio;
  }, []);

  /**
   * Speak the sample in one specific voice. **Called from a click handler and
   * from nowhere else** — see the file header.
   */
  const previewVoice = useCallback(
    async (voiceId: string, label: string) => {
      if (previewRef.current) return;
      releaseAudio();

      // ---------------------------------------------------------------------
      // BEFORE THE FIRST `await`, AND THAT IS NOT AN ACCIDENT OF ORDERING.
      //
      // The synthesis round trip below is the await that closes the user
      // gesture. Anything this function does after it is, to a mobile browser,
      // something the page decided to do on its own. So the element is claimed
      // and unlocked HERE, while the tap is still being handled, and the bytes
      // are poured into that already-permitted element when they arrive.
      //
      // Moving this line below the `await` — or hoisting it into a `useEffect`,
      // or "tidying" it into `playPreparedSample` where the rest of the audio
      // handling lives — reintroduces #383 exactly, and does it silently: every
      // desktop browser and every test double plays fine either way.
      // ---------------------------------------------------------------------
      const audio = primePreviewAudio();

      previewRef.current = true;
      const token = ++previewSeqRef.current;
      /** Has this press since been superseded by a newer one? */
      const isCurrent = () => previewSeqRef.current === token;
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

      // No `Audio` in this environment at all, so the priming call never had an
      // element to make. Nothing was ever going to play, and saying so is more
      // use than an empty row that looks like it worked.
      if (!audio) {
        setPreview({
          kind: 'message',
          voiceId,
          text: `We couldn't play the ${label} sample just now. Your browser still reads everything aloud.`,
        });
        return;
      }

      const played = playPreparedSample(audio, result.audio, {
        objectUrlRef,
        onEnded: () => {
          if (!isCurrent()) return;
          releaseAudio();
          setPreview({ kind: 'idle' });
        },
        // BLOCKED IS NOT FINISHED (#383). Until this branch existed both landed
        // in the same callback, so a learner whose browser refused the sample
        // saw precisely what a learner who heard it saw: the row going quiet.
        // The remedy is theirs, so it is offered — and the reassurance is the
        // page's standing one, because it is true.
        onBlocked: () => {
          if (!isCurrent()) return;
          releaseAudio();
          setPreview({
            kind: 'message',
            voiceId,
            text: 'Your browser blocked the sample from playing. Press Preview again, or check that the phone is not muted. Your browser still reads everything aloud.',
          });
        },
        // A DIFFERENT FAILURE, SO A DIFFERENT SENTENCE. The bytes arrived and
        // the element could not make sense of them — telling this learner to
        // press the button again, as the blocked message does, would send them
        // round a loop that cannot end.
        onDecodeError: () => {
          if (!isCurrent()) return;
          releaseAudio();
          setPreview({
            kind: 'message',
            voiceId,
            text: `The ${label} sample arrived, but your browser could not play it. Your browser still reads everything aloud.`,
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
    [primePreviewAudio, releaseAudio],
  );

  const previewStatusText =
    preview.kind === 'preparing'
      ? 'Preparing the sample…'
      : preview.kind === 'playing'
        ? `Playing a sample in the ${preview.label} voice.`
        : preview.kind === 'message'
          ? preview.text
          : '';

  /**
   * The current preview state, flattened to the three things the list needs.
   *
   * Read out here rather than narrowed inside the `.map()` below: the row is
   * rendered in a callback, and a discriminated union narrowed in the enclosing
   * scope is not something to make a closure depend on.
   */
  const previewVoiceId = preview.kind === 'idle' ? null : preview.voiceId;
  const preparingVoiceId =
    preview.kind === 'preparing' ? preview.voiceId : null;
  const previewNeedsKey = preview.kind === 'message' && preview.needsKey === true;

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
                    // THE FEEDBACK BELONGS TO A ROW, NOT TO THE LIST (#383).
                    // On a phone the eleven rows are several screens tall, so a
                    // single box under the last of them is a box the learner
                    // who pressed the first button never scrolls to.
                    const isPreparing = preparingVoiceId === option.id;
                    const rowText =
                      previewVoiceId === option.id ? previewStatusText : '';

                    return (
                      <Box key={option.id} sx={{ py: 0.5 }}>
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
                            // The spinner replaces the speaker icon on THE
                            // PRESSED ROW ONLY, so "something is happening"
                            // and "here is where it is happening" are the same
                            // piece of information.
                            startIcon={
                              isPreparing ? (
                                <CircularProgress size={16} color="inherit" />
                              ) : (
                                <VolumeUpIcon />
                              )
                            }
                            // ONLY `onClick`. No `onFocus`, no `onMouseEnter`,
                            // no key handler — each of those would spend the
                            // learner's key on a gesture that is not a request
                            // for audio.
                            onClick={() => {
                              void previewVoice(option.id, option.label);
                            }}
                            // ONLY THE PRESSED ROW GOES INERT. What actually
                            // protects the key from a second charge is
                            // `previewRef`, which covers every button on the
                            // page and every way of pressing one; greying out
                            // the other ten only made the whole list look
                            // broken for the length of a round trip, and hid
                            // which of them the learner had asked for. Once
                            // audio is playing, pressing another Preview is a
                            // legitimate "no, that one" and stops the first.
                            disabled={isSaving || isPreparing}
                            // The accessible name NAMES THE VOICE. "Preview"
                            // alone is six identical buttons to anyone
                            // listening to the page rather than looking at it.
                            // The visible word is contained in the accessible
                            // name, so a speech-input user saying "Preview"
                            // still matches.
                            aria-label={`Preview the ${option.label} voice`}
                          >
                            Preview
                          </Button>
                        </Box>

                        {/* `aria-hidden`, because this is the VISIBLE copy of
                            what the live region below already announces —
                            without it every message is read twice. The link is
                            deliberately OUTSIDE that hidden text: focusable
                            content inside an `aria-hidden` subtree is a focus
                            stop assistive technology cannot name, and this is
                            the one remedy on the page a learner can act on, so
                            it stays reachable. */}
                        {rowText && (
                          <Box sx={{ pl: { xs: 0, sm: 4 }, pb: 0.5 }}>
                            <Typography
                              variant="body2"
                              color="text.secondary"
                              sx={{ maxWidth: '62ch' }}
                              aria-hidden="true"
                            >
                              {rowText}
                            </Typography>
                            {previewNeedsKey && (
                              <Link
                                component={RouterLink}
                                to="/settings/ai"
                                variant="body2"
                              >
                                Add a key
                              </Link>
                            )}
                          </Box>
                        )}
                      </Box>
                    );
                  })}
                </RadioGroup>
              </FormControl>

              {/* ONE live region for the whole group, always mounted and empty
                  when idle: a live region inserted at the same moment as its
                  text is frequently never announced at all — and eleven of
                  them, one per row, is a page that announces nothing reliably
                  and everything twice.

                  VISUALLY HIDDEN SINCE #383, because the same words are now on
                  screen beside the button that was pressed. Sighted learners
                  read them there; everyone else hears them from here. The
                  remedy is a SENTENCE rather than the link, since the link
                  itself lives in the row and a second copy here would be a
                  second focus stop saying the same thing. */}
              <Box role="status" aria-live="polite" sx={visuallyHidden}>
                {previewStatusText}
                {previewNeedsKey
                  ? ' You can add a key on the AI settings page.'
                  : ''}
              </Box>
            </Box>
          )}
        </CardContent>
      </Card>
    </>
  );
}

/**
 * Pour synthesized bytes into the ALREADY-PRIMED element, returning whether
 * playback was asked for.
 *
 * TAKES THE ELEMENT RATHER THAN MAKING ONE (#383). Constructing an
 * `HTMLAudioElement` here — which is what this function used to do — is what
 * put the construction after the synthesis `await` and lost the gesture, so
 * the element arrives as an argument and this function's only job is the
 * source, the handlers and the ask. `primePreviewAudio` is the only place an
 * element is ever built.
 *
 * Deliberately NOT awaited by the caller. `HTMLAudioElement.play()` resolves
 * when playback BEGINS, which in jsdom (and behind an autoplay policy) may be
 * never — so this reports "the element accepted the source and we asked it to
 * play", and the three callbacks report what actually happened. `false` means
 * there was nothing here that could play at all.
 *
 * THREE CALLBACKS, NOT ONE. Finishing, being refused, and failing to decode
 * are three different things to say to a learner, and collapsing them into a
 * single `onEnd` is what made a blocked preview indistinguishable from a
 * played one.
 */
function playPreparedSample(
  audio: HTMLAudioElement,
  blob: Blob,
  ctx: {
    objectUrlRef: { current: string | null };
    /** The clip reached its end. A genuine completion. */
    onEnded: () => void;
    /** `play()` was refused — an autoplay policy, most often. */
    onBlocked: () => void;
    /** The element has bytes it cannot make sense of. */
    onDecodeError: () => void;
  },
): boolean {
  if (typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') {
    return false;
  }

  const url = URL.createObjectURL(blob);
  ctx.objectUrlRef.current = url;

  audio.onended = ctx.onEnded;
  audio.onerror = ctx.onDecodeError;

  audio.src = url;
  // Unmuted here, and only here: it was muted for the priming call so that
  // spending the gesture could not itself make a noise.
  audio.muted = false;
  try {
    // The element is reused, so it may be sitting at the end of the last
    // sample. A seek before any metadata has loaded can throw, and that is not
    // worth failing a preview over — a fresh source starts at zero anyway.
    audio.currentTime = 0;
  } catch {
    /* Nothing to rewind. */
  }

  try {
    const started: unknown = audio.play();
    if (started && typeof (started as Promise<void>).then === 'function') {
      // The rejection is REPORTED rather than dropped. It is not an error —
      // the browser voice still reads everything — but it is a different
      // outcome from a sample that played, and the learner is owed the
      // difference. Older browsers return `undefined` here, hence the check.
      void (started as Promise<void>).catch(() => ctx.onBlocked());
    }
  } catch {
    ctx.onBlocked();
    return false;
  }

  return true;
}

export default VoiceSettings;

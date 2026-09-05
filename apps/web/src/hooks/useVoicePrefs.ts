/**
 * `user_settings.voice` — the seven spoken-practice preferences, resolved.
 *
 * Issue #288, epic #280. **No new endpoint and no new request pattern**: this
 * reads the same `GET`/`PATCH /api/user-settings` the rest of the app already
 * uses, through the same `useUserSettings` hook, exactly like `navigation`
 * (`useNavigationPrefs`) and `dataTables` before it. There is deliberately no
 * second fetch of the settings document anywhere in this feature.
 *
 * =============================================================================
 * ABSENT MEANS THE BUILT-IN DEFAULT, AND A DEFAULT IS NEVER WRITTEN BACK
 * =============================================================================
 *
 * The API ships this namespace with no `.default()` anywhere, on purpose (see
 * `user-settings-namespaces.schema.ts`'s own header): a learner who has never
 * touched a voice preference keeps moving with the defaults when a later
 * release changes one. Materialising today's default into their document —
 * here, or on the settings page — would silently opt them out of that forever,
 * with nothing on screen to explain why.
 *
 * So this hook RESOLVES for reading and writes nothing. Every resolver below is
 * total: an out-of-range or wrong-typed value out of a user-writable JSONB
 * column falls back to the default rather than reaching a
 * `SpeechSynthesisUtterance` as `NaN`.
 *
 * =============================================================================
 * THESE ARE WISHES, NOT CAPABILITIES
 * =============================================================================
 *
 * `preferPremiumVoice` and `preferredVoice` say what the learner would LIKE to
 * hear. Whether a premium voice exists on this deployment is a different fact,
 * answered by `AiStatus.unboundRoles` (`QuestionAudio` reads it) or by
 * `SpeechVoicesResponse.speakBound` (the settings page reads it), and never by
 * this hook. An unbound `speak` role is the ordinary state of a fresh install
 * (`docs/specs/voice.md` §2) — the browser's own voice reads everything, at
 * whatever `speechRate` the learner set, and nothing is missing.
 */

import { useCallback, useMemo } from 'react';

import { useUserSettings } from './useUserSettings';
import type { VoiceSettings, VoiceSettingsPatch } from '../types';

/**
 * A spoken answer grades itself on release, with no confirm step.
 *
 * MIRRORS `DEFAULT_VOICE_AUTO_SUBMIT_SPOKEN` in
 * `apps/api/src/common/schemas/user-settings-namespaces.schema.ts`, and is a
 * DISPLAY/behaviour default only: it is never sent, so the server's constant
 * stays the one that decides what an unopinionated learner gets. If the two
 * ever disagree the client shows the wrong value; it cannot cause the wrong
 * value to be stored, because nothing stores it.
 */
export const DEFAULT_VOICE_AUTO_SUBMIT_SPOKEN = true;

/** Mirrors `DEFAULT_VOICE_PREFER_PREMIUM`, on the same terms. */
export const DEFAULT_VOICE_PREFER_PREMIUM = true;

/**
 * Mirrors `DEFAULT_VOICE_SPEECH_RATE`, on the same terms.
 *
 * `0.95` is the rate `QuestionAudio.tsx` used to hard-code, for the reason its
 * own comment gives: a civics question read at conversational speed is hard to
 * follow for somebody studying in a second language, which is most of the
 * people this product is for. #288 turns that literal into a preference with
 * the same value as its default; it is not a new number.
 */
export const DEFAULT_VOICE_SPEECH_RATE = 0.95;

/** Mirrors `VOICE_SPEECH_RATE_MIN`. */
export const VOICE_SPEECH_RATE_MIN = 0.5;

/** Mirrors `VOICE_SPEECH_RATE_MAX`. */
export const VOICE_SPEECH_RATE_MAX = 2;

/** Mirrors `DEFAULT_VOICE_READ_QUESTIONS_ALOUD`. Auto-play is opt-in. */
export const DEFAULT_VOICE_READ_QUESTIONS_ALOUD = false;

/** Mirrors `DEFAULT_VOICE_READ_ANSWERS_ALOUD`. Auto-play is opt-in. */
export const DEFAULT_VOICE_READ_ANSWERS_ALOUD = false;

/**
 * Mirrors `DEFAULT_VOICE_CONVERSATION_MODE` (issue #307, epic #304), on the
 * same terms as its neighbours above: a display/behaviour default only, never
 * sent, so the server's constant stays the one that decides what an
 * unopinionated learner gets.
 *
 * `false` — hands-free Voice mode is opt-in, exactly as autoplay is.
 */
export const DEFAULT_VOICE_CONVERSATION_MODE = false;

/** Mirrors `VOICE_PREFERRED_VOICE_PATTERN`. Shape only — membership is the provider's. */
export const VOICE_PREFERRED_VOICE_PATTERN = /^[A-Za-z0-9_-]+$/;

/** Every voice preference, resolved. No field is optional here. */
export interface VoicePreferences {
  autoSubmitSpoken: boolean;
  preferPremiumVoice: boolean;
  /**
   * The provider's voice id, or `undefined` for "let the provider choose".
   *
   * `undefined` rather than a resolved id on purpose: which voice a provider
   * picks by default is the PROVIDER's answer (`SpeechVoicesResponse.defaultVoice`
   * reports it, `AiSpeechService` applies it), so inventing one here would put a
   * second opinion about it in the browser.
   */
  preferredVoice: string | undefined;
  speechRate: number;
  readQuestionsAloud: boolean;
  readAnswersAloud: boolean;
  /**
   * Whether a practice session starts in hands-free Voice mode rather than the
   * typed one (#307, epic #304).
   *
   * A WISH, NOT A CAPABILITY, on the same terms as `preferPremiumVoice` above:
   * whether this browser can actually listen is a different fact, answered by
   * the speech-recognition support check at the point of use, never here.
   */
  conversationMode: boolean;
}

/**
 * What to send for a value the learner just chose: the value, or `null`.
 *
 * `null` is the DELETE. Writing today's default back because the learner
 * happened to land on it pins them to it forever, invisibly, including after a
 * later release moves it — this file's own header states the cost in full.
 *
 * IT LIVES HERE, BESIDE THE DEFAULTS IT IS ALWAYS CALLED WITH, so the two
 * surfaces that write a voice preference — `/settings/voice` and the practice
 * screen's own `Text | Voice` control (#313) — share one reducer rather than
 * one of them re-deriving it. `components/settings/VoiceSettings.tsx` re-exports
 * it, so every existing caller of `writeFor` is unaffected.
 */
export function writeFor<T>(next: T, builtInDefault: T): T | null {
  return next === builtInDefault ? null : next;
}

/** A stored boolean, or the built-in default. A stored `false` is real. */
function resolveBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

/**
 * The stored speech rate, or the built-in default.
 *
 * Range- and type-checked, exactly as `resolvedReminderHour` is and for the
 * same reason: this object came out of a user-writable JSONB column, and a
 * `NaN` or a `12` reaching `utterance.rate` is unintelligible audio rather
 * than a preference this build will honour.
 */
export function resolveSpeechRate(value: unknown): number {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value < VOICE_SPEECH_RATE_MIN ||
    value > VOICE_SPEECH_RATE_MAX
  ) {
    return DEFAULT_VOICE_SPEECH_RATE;
  }
  return value;
}

/**
 * The stored voice id, or `undefined`.
 *
 * SHAPE CHECKED, MEMBERSHIP NOT — the accepted set belongs to the provider
 * (`aiSynthesizeRequestSchema` says so on the request itself). A stored id for
 * a voice the provider has since renamed still goes out and comes back as a
 * provider failure that names it, which the caller already falls back from;
 * silently dropping it here would instead look like the preference was never
 * saved.
 */
export function resolvePreferredVoice(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 64) return undefined;
  return VOICE_PREFERRED_VOICE_PATTERN.test(trimmed) ? trimmed : undefined;
}

/** The whole namespace, resolved against the built-in defaults. Total. */
export function resolveVoicePreferences(
  voice: VoiceSettings | undefined,
): VoicePreferences {
  return {
    autoSubmitSpoken: resolveBoolean(
      voice?.autoSubmitSpoken,
      DEFAULT_VOICE_AUTO_SUBMIT_SPOKEN,
    ),
    preferPremiumVoice: resolveBoolean(
      voice?.preferPremiumVoice,
      DEFAULT_VOICE_PREFER_PREMIUM,
    ),
    preferredVoice: resolvePreferredVoice(voice?.preferredVoice),
    speechRate: resolveSpeechRate(voice?.speechRate),
    readQuestionsAloud: resolveBoolean(
      voice?.readQuestionsAloud,
      DEFAULT_VOICE_READ_QUESTIONS_ALOUD,
    ),
    readAnswersAloud: resolveBoolean(
      voice?.readAnswersAloud,
      DEFAULT_VOICE_READ_ANSWERS_ALOUD,
    ),
    conversationMode: resolveBoolean(
      voice?.conversationMode,
      DEFAULT_VOICE_CONVERSATION_MODE,
    ),
  };
}

export interface UseVoicePrefsResult {
  /** Resolved preferences. The built-in defaults until the first read lands. */
  voice: VoicePreferences;
  /** True until the first settings read resolves. Callers render defaults meanwhile. */
  isLoading: boolean;
  /**
   * Store ONE voice preference, from outside the settings page (#313).
   *
   * THE SAME `PATCH /api/user-settings` EVERY OTHER CONTROL USES, on the same
   * `useUserSettings` instance this hook already reads through — so a page that
   * writes a preference still makes exactly one settings request, and there is
   * still no second copy of the document anywhere in this feature.
   *
   * The `null`-delete contract is the CALLER'S to keep, exactly as it is on
   * `/settings/voice`: send `null` for a field the learner has moved back to
   * the built-in default (`writeFor` in `components/settings/VoiceSettings.tsx`
   * is the reducer that does it), never today's default value — see this
   * file's own header for what materialising one costs.
   *
   * NEVER REJECTS. A preference that could not be stored must not take a
   * practice session down with it: the mode the learner just chose is already
   * theirs on screen, and all that was lost is that it will not be there next
   * time. `useUserSettings` has already reported the failure into its own
   * `error`.
   */
  saveVoice: (patch: VoiceSettingsPatch) => Promise<void>;
}

export function useVoicePrefs(): UseVoicePrefsResult {
  // `syncTheme: false` — this hook is mounted from practice and writing
  // screens, and it is here for the `voice` namespace only. Left on, it would
  // quietly make the STORED theme authoritative on every session load and
  // stamp over the AppBar's local light/dark toggle, exactly as
  // `useNavigationPrefs` documents for the rail. It also drops the
  // `ThemeContextProvider` requirement, which a practice screen has no other
  // reason to carry.
  const { settings, isLoading, updateSettings } = useUserSettings({
    syncTheme: false,
  });

  const voice = useMemo(
    () => resolveVoicePreferences(settings?.voice),
    [settings],
  );

  const saveVoice = useCallback(
    async (patch: VoiceSettingsPatch) => {
      try {
        await updateSettings({ voice: patch });
      } catch {
        // Swallowed on purpose — see `saveVoice`'s own contract above.
      }
    },
    [updateSettings],
  );

  return { voice, isLoading, saveVoice };
}

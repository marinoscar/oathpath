/**
 * What stands where the microphone would have been.
 *
 * Issue #109, epic #58 / E9. `transcribe` is `wired: true` as of this epic and
 * `systemReady` deliberately does not depend on it (`docs/specs/voice.md` §1),
 * so a learner can reach a spoken practice session with a perfectly good key,
 * a ready system, and no speech recognition configured on the deployment at
 * all.
 *
 * =============================================================================
 * THE FAILURE THIS PREVENTS IS A MICROPHONE BUTTON THAT DOES NOTHING
 * =============================================================================
 *
 * The mic is ABSENT in that state, not disabled and not greyed — `voice.md`
 * §1's table says "hidden, not disabled", for the reason `PushToTalkButton`'s
 * own header already gives for the two capture problems a second press cannot
 * fix: "a button guaranteed to fail is worse than no button." A greyed-out
 * control tells a learner the product is broken and offers them nothing to do
 * about it, and a learner practising for a naturalization interview is not the
 * person to hand an unexplained dead affordance to.
 *
 * The session loses nothing. Typing is an unconditional alternative (§5), so
 * with the mic gone the practice session is a complete, fully functional
 * text-mode session — which is why this notice is calm rather than a warning.
 *
 * =============================================================================
 * IT RENDERS `AiNotReady`. IT DOES NOT RE-IMPLEMENT IT.
 * =============================================================================
 *
 * `components/ai/AiNotReady.tsx` exists for one sentence — "This is not a
 * problem with your key" — and its own header names the way that sentence gets
 * lost: written per surface, it is the first thing dropped as boilerplate. A
 * voice-specific alert written from scratch here is exactly that rewrite, on
 * the one surface where the mistaken conclusion is easiest to reach (a learner
 * whose microphone vanished, who owns a microphone and a key, and who can see
 * no other explanation).
 *
 * So this file contains no copy of its own beyond the feature name. It is a
 * binding: `AiNotReady` with `role="transcribe"`.
 *
 * =============================================================================
 * `speak` HAS NO EQUIVALENT, AND MUST NOT GET ONE
 * =============================================================================
 *
 * The role is hard-coded rather than a prop. `voice.md` §2: an unbound `speak`
 * is not a degraded state — `QuestionAudio` reads the question with the
 * browser's own voice on every deployment, with no binding and no cost, so
 * nothing is missing and nothing explains itself. A `role` prop here would
 * make `<VoiceUnavailableNotice role="speak" />` spellable, and the day
 * somebody spells it a learner is told the product is broken while it is
 * reading their question aloud to them.
 *
 * =============================================================================
 * SYSTEM-WIDE FAILURE IS A DIFFERENT NOTICE
 * =============================================================================
 *
 * `systemReady === false` — no provider, master switch off, `tutor`/`grader`
 * unbound — is a different problem with a different remedy: it takes every AI
 * feature away, not one input method. It stays the plain `<AiNotReady />` a
 * page mounts for itself, unchanged by this epic. The two are never merged and
 * never rendered as one message.
 */

import { AiNotReady } from '../ai/AiNotReady';
import { useVoiceAvailability } from '../../hooks/useVoiceAvailability';

export interface VoiceUnavailableNoticeProps {
  /**
   * What the learner was trying to do, in their words.
   *
   * Passed straight through to `AiNotReady`, which turns it into the first
   * line. The default says what is actually gone in plain language, because
   * `transcribe` is a registry key an administrator recognises and a learner
   * has never seen.
   */
  feature?: string;
}

/**
 * The notice for an unbound `transcribe`, or nothing.
 *
 * RETURNS NULL UNLESS `transcribe` IS KNOWN TO BE UNBOUND, so a caller mounts
 * it unconditionally beside the control it replaces — the same shape
 * `AiNotReady` chose for the same reason.
 *
 * `transcribeUnbound` is the guard rather than `!transcribeBound` because both
 * are false while the status is still unknown (see `useVoiceAvailability`), and
 * a "speech recognition is not set up" message flashing on every page load of a
 * correctly configured deployment would not merely be noisy, it would be false.
 * The guard also means `AiNotReady` — which uses the THROWING status accessor —
 * is only ever mounted once a status has actually arrived, which cannot happen
 * without an `AiStatusProvider` above it.
 */
export function VoiceUnavailableNotice({
  feature = 'Answering out loud',
}: VoiceUnavailableNoticeProps = {}) {
  const { transcribeUnbound } = useVoiceAvailability();

  if (!transcribeUnbound) return null;

  return <AiNotReady role="transcribe" feature={feature} />;
}

export default VoiceUnavailableNotice;

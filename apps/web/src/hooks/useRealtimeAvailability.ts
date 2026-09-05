/**
 * Can this deployment hold a spoken interview at all? — issue #159, epic #60.
 *
 * The sibling of `useVoiceAvailability` (#109), reading the same field of the
 * same cached status for the same reason: `unboundRoles` has always meant
 * "every WIRED role with no model bound", so `unboundRoles.includes('realtime')`
 * answers this question exactly, with no new API surface and no duplicated copy
 * of the role registry (`CLAUDE.md`, "Adding a New AI Model Role": the registry
 * lives in the API precisely because `wired` is a per-deployment fact a static
 * copy would get wrong).
 *
 * =============================================================================
 * A SEPARATE HOOK, NOT TWO MORE FIELDS ON `useVoiceAvailability`
 * =============================================================================
 *
 * `transcribe` and `speak` are two roles that decide whether a CONTROL appears
 * on a screen that works without it — a microphone, a premium voice. `realtime`
 * decides whether an entire TRANSPORT is offered. The consequences are
 * different in kind, the screens that ask are different screens, and merging
 * them would produce exactly the merged flag `voice.md` §12 rejected
 * (`voiceReady`): a caller handed one boolean over three roles cannot render
 * any of them correctly.
 *
 * =============================================================================
 * `systemReady` IS NOT THE FIELD TO READ, AND MUST NOT BECOME ONE
 * =============================================================================
 *
 * `systemReady` is computed over the wired roles whose capability is `text`
 * (`tutor`, `grader`) precisely so that wiring a non-text role cannot flip an
 * already-deployed installation to "not ready" for a capability nobody asked
 * for (`voice.md` §1, `realtime-interview.md` §1). An installation with no
 * realtime model bound is a NORMAL, WORKING installation whose learners take
 * their mock interviews in text.
 *
 * =============================================================================
 * AN UNKNOWN STATUS RESOLVES TO "NOT BOUND", AND THAT IS THE SAFE DIRECTION
 * =============================================================================
 *
 * Before the first response, and after a failed one, both flags are `false`.
 * The spoken option is therefore absent for the moment rather than
 * present-and-dead, and the text interview — which always works — is what a
 * learner is offered. Resolving the other way hands them a control that cannot
 * succeed, and does so on a screen where pressing it asks for their microphone
 * first.
 *
 * `realtimeUnbound` is a SEPARATE field rather than `!realtimeBound` for that
 * same reason: while the status is unknown, both are `false`. Collapsing them
 * would flash "spoken interviews are not set up here" on every page load of a
 * perfectly configured deployment — a message that is not merely noisy but
 * false.
 */

import { useOptionalAiStatus } from '../contexts/AiStatusContext';

/** The role key, spelled once. It is an `AI_MODEL_ROLES` key and it is persisted. */
export const REALTIME_ROLE = 'realtime';

export interface RealtimeAvailability {
  /** A model is bound to `realtime`: a spoken interview can be offered. */
  realtimeBound: boolean;
  /** The status is KNOWN and `realtime` has no model bound. */
  realtimeUnbound: boolean;
  /** True until the first status response settles, success or failure. */
  isLoading: boolean;
}

/**
 * Read the `realtime` role's binding state.
 *
 * Safe in a tree with no `AiStatusProvider` above it, exactly as
 * `useVoiceAvailability` is: a `null` context is treated as a failed status
 * request, which is "not bound".
 */
export function useRealtimeAvailability(): RealtimeAvailability {
  const ai = useOptionalAiStatus();
  const status = ai?.status ?? null;

  return {
    realtimeBound: !!status && !status.unboundRoles.includes(REALTIME_ROLE),
    realtimeUnbound: !!status && status.unboundRoles.includes(REALTIME_ROLE),
    isLoading: ai?.isLoading ?? false,
  };
}

export default useRealtimeAvailability;

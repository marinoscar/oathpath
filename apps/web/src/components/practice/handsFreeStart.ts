/**
 * The one tap, carried across the one navigation it has to survive.
 *
 * Issue #350, epic #345. Starting a Quick 5 with Voice chosen must start the
 * session AND the hands-free loop — one tap, not "start, then find Start
 * again". The tap happens on `/practice`; the loop lives on
 * `/practice/sessions/:id`, on the other side of a `navigate()` to a URL that
 * did not exist until the server answered. Something has to carry the intent
 * across, and this is it: a flag in the router's own location state.
 *
 * =============================================================================
 * IT IS THE TAP, NOT THE PREFERENCE — AND THAT DISTINCTION IS THE WHOLE FILE
 * =============================================================================
 *
 * `voice.conversationMode` already crosses the navigation by itself: it is
 * stored, and the session page reads it. It is deliberately NOT what arms the
 * loop, for two reasons:
 *
 *  1. **The preference may not have landed yet.** A learner who chooses Voice
 *     and immediately taps Quick 5 has a `PATCH /api/user-settings` in flight;
 *     the session page's own settings read can honestly answer with the
 *     document as it was a moment ago. The tap is the newer fact, and it is
 *     right here — so the mode it asked for does not wait on a round trip.
 *  2. **A stored preference is not a gesture.** Auto-arming from
 *     `conversationMode` alone would open the microphone on a session RESUMED
 *     from Recent sessions, and after a reload — neither of which is a learner
 *     asking to start talking right now. `#350`'s own acceptance criterion
 *     keeps an explicit arm control for exactly those cases, and this flag is
 *     what tells them apart from a fresh start.
 *
 * =============================================================================
 * IT IS CONSUMED ONCE, AND A RELOAD IS NOT A SECOND TAP
 * =============================================================================
 *
 * Location state is persisted into `history.state` by the browser, so it
 * survives a reload of the session URL. The session page therefore CLEARS it
 * (a `replace` navigation) the moment it acts on it: a learner who reloads
 * mid-session is resuming, and resuming arms nothing on its own.
 *
 * The shape is read defensively because `location.state` is `unknown` by
 * construction — it can be anything a previous build, an extension, or a
 * restored history entry left there.
 */

/** What `/practice` puts in the location state when Voice is the chosen mode. */
export interface HandsFreeStartState {
  handsFree: true;
}

/**
 * The state to navigate with, or `undefined` for a typed start.
 *
 * `undefined` rather than `{ handsFree: false }`: absent already means "no",
 * and a stored `false` is a second way to spell it that a reader would then
 * have to check for.
 */
export function handsFreeStartState(handsFree: boolean): HandsFreeStartState | undefined {
  return handsFree ? { handsFree: true } : undefined;
}

/** Did the navigation that landed here ask for the loop to start? */
export function wantsHandsFreeStart(state: unknown): boolean {
  return (
    typeof state === 'object' &&
    state !== null &&
    (state as { handsFree?: unknown }).handsFree === true
  );
}

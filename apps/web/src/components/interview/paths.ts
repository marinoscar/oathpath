/**
 * The three mock-interview routes, spelled once each.
 *
 * Issue #140 (the first two), #145 (the debrief) and #159 (the spoken
 * interview), epics #57 / E8 and #60 / E11. Five places
 * now build one of these URLs — the start screen after `POST /api/interviews`,
 * the history list's two row affordances, the interview screen after
 * completion, and the practice page's entry band — and a template literal
 * written out at each of them is how one of them survives a route rename.
 *
 * This is the same reason `components/civics/StateRequiredNotice` exports its
 * own `SET_STATE_PATH` and `PracticePage` imports it rather than re-spelling
 * `/settings/journey`.
 *
 * =============================================================================
 * THESE ARE NOT DESTINATIONS, AND THERE IS NO `destinations.ts` ENTRY
 * =============================================================================
 *
 * All three live under `/practice`, which `config/destinations.ts` already owns
 * through `owns('/practice', …)` — segment-boundary matching, so the whole
 * subtree is covered. `docs/specs/mock-interview.md` §14 states the same
 * reachability-versus-content distinction `CLAUDE.md`'s Settings UI Pattern
 * draws for tabs versus destinations: these are content WITHIN the Practice
 * destination, never destinations of their own, which is why the rail keeps
 * highlighting Practice inside an interview and why the route-ownership test
 * keeps passing without a new `DESTINATION_ROUTES` key.
 */

/** Where the mock interview starts, and where its history is listed. */
export const INTERVIEWS_PATH = '/practice/interviews';

/** The live interview screen for one id. */
export function interviewPath(interviewId: string): string {
  return `${INTERVIEWS_PATH}/${interviewId}`;
}

/**
 * The SPOKEN interview screen for one id — a real, mounted route since #159.
 *
 * A separate route from {@link interviewPath} rather than a mode of it, and the
 * two are deliberately reachable from each other with the SAME id: falling back
 * from voice to text is a transport change, not a restart, because the engine's
 * state is server-side and untouched by which transport is driving it
 * (`docs/specs/realtime-interview.md` §7). A learner who loses their connection
 * lands on `interviewPath(id)` and resumes at exactly the question they were
 * on.
 *
 * Two screens rather than one because they hold opposite rules about the
 * microphone and about the writing sentence, and one component holding both is
 * the shape in which "never render the sentence" eventually gets rendered by
 * accident — the same reason `/practice/reading` and `/practice/writing` are
 * two pages.
 */
export function interviewVoicePath(interviewId: string): string {
  return `${interviewPath(interviewId)}/voice`;
}

/**
 * The debrief for one id — a real, mounted route since #145.
 *
 * Until it existed, `InterviewPage` deliberately sent a finished interview to
 * `/practice` instead, because a next step pointing at an unmounted route lands
 * the learner on the catch-all redirect to `/`. It exists now, so nothing needs
 * to point away from it any more.
 */
export function interviewDebriefPath(interviewId: string): string {
  return `${interviewPath(interviewId)}/debrief`;
}

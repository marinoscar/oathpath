/**
 * The English practice routes, spelled once each.
 *
 * Issue #144 (reading), epic #59 / E10. Three places build this URL already —
 * the Practice page's entry band, the Learn page's entry button, and the route
 * mounted in `App.tsx` — and a template literal written out at each of them is
 * how one of them survives a route rename. Same reason
 * `components/interview/paths.ts` exists, and this file follows it deliberately
 * rather than inventing a second convention.
 *
 * =============================================================================
 * THIS IS NOT A DESTINATION, AND THERE IS NO `destinations.ts` ENTRY
 * =============================================================================
 *
 * `/practice/reading` lives under `/practice`, which `config/destinations.ts`
 * already owns through `owns('/practice', …)` — segment-boundary matching, so
 * the whole subtree is covered. That is the same reachability-versus-content
 * distinction `CLAUDE.md`'s Settings UI Pattern draws for tabs versus
 * destinations, and the same one `docs/specs/mock-interview.md` §14 states for
 * the three interview routes: this is content WITHIN the Practice destination,
 * never a destination of its own. So the rail keeps highlighting Practice while
 * a learner is reading aloud, the AppBar title resolver already has an answer,
 * and no `DESTINATION_ROUTES` key is added or wanted.
 *
 * The writing screen (#147) gets its sibling constant here when it lands. It is
 * deliberately NOT declared ahead of the route existing: a path constant for an
 * unmounted route is a link that lands on the catch-all redirect to `/`.
 */

/** Reading practice — read one sentence aloud and be scored word by word. */
export const READING_PRACTICE_PATH = '/practice/reading';

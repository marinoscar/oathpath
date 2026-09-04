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
 * Both constants below are declared only because `App.tsx` mounts both routes.
 * A path constant for an unmounted route is a link that lands on the catch-all
 * redirect to `/`, so neither is ever added ahead of its `<Route>`.
 */

/** Reading practice — read one sentence aloud and be scored word by word. */
export const READING_PRACTICE_PATH = '/practice/reading';

/**
 * Writing practice — hear one sentence dictated and write down what you heard.
 *
 * A SIBLING OF THE ROUTE ABOVE, NOT A MODE OF IT (issue #147). The two screens
 * share a scorer, an endpoint and a diff renderer, and share almost nothing
 * else: reading SHOWS the sentence (it is the prompt), writing must NEVER show
 * it before submission (`docs/specs/english-test.md` §4 — a visible sentence
 * silently converts the exercise into copying practice). Folding them into one
 * route with a `?kind=` switch would put those two opposite rules inside one
 * component, one render tree and one set of conditionals, which is the shape in
 * which "never render the sentence" eventually gets rendered by accident.
 */
export const WRITING_PRACTICE_PATH = '/practice/writing';

/**
 * Learn (`/learn`) — the empty state, shipped with the destination.
 *
 * Issue #69, epic #50. A thin binding over
 * `components/journey/DestinationEmptyState`, which carries the layout and the
 * reasoning; this file contributes only the two sentences.
 *
 * THE COPY IS VERBATIM FROM `docs/specs/journey-shell.md` §8.1, which was
 * reviewed against `VISION.md`'s tone. It promises no date — no "soon", no
 * "coming in the next update" — because this application cannot honestly
 * promise one. Editing it here rather than in the spec is how the two stop
 * agreeing.
 */

import { DestinationEmptyState } from '../components/journey/DestinationEmptyState';

export default function LearnPage() {
  return (
    <DestinationEmptyState
      title="Learn"
      description="This is where you'll work through the official civics questions for your test version, one at a time, with a clear explanation whenever one doesn't click."
      rightNow="There isn't any content here yet. For now, check Home for what to do next, or revisit your setup answers."
    />
  );
}

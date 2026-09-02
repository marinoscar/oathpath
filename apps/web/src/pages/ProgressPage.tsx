/**
 * Progress (`/progress`) — the empty state, shipped with the destination.
 *
 * Issue #69, epic #50. A thin binding over
 * `components/journey/DestinationEmptyState`, which carries the layout and the
 * reasoning; this file contributes only the two sentences.
 *
 * THE COPY IS VERBATIM FROM `docs/specs/journey-shell.md` §8.3, and this page's
 * second sentence is the one that states the honesty rule outright: it will
 * keep saying there is no evidence until there is some. That is the promise
 * `VISION.md` makes about readiness, so it is not softened here.
 */

import { DestinationEmptyState } from '../components/journey/DestinationEmptyState';

export default function ProgressPage() {
  return (
    <DestinationEmptyState
      title="Progress"
      description="This is where you'll see how ready you actually are — not just how many questions you've answered, but real evidence: what you remember, how consistently, and what's still shaky."
      rightNow="There's no evidence to show yet, because nothing here is tracked yet. That's the honest answer, and it's the one this page will always give until it has something real to show."
    />
  );
}

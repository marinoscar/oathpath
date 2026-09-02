/**
 * Practice (`/practice`) — the empty state, shipped with the destination.
 *
 * Issue #69, epic #50. A thin binding over
 * `components/journey/DestinationEmptyState`, which carries the layout and the
 * reasoning; this file contributes only the two sentences.
 *
 * THE COPY IS VERBATIM FROM `docs/specs/journey-shell.md` §8.2 — see
 * `LearnPage.tsx` for why it stays that way, and §8 for why none of the three
 * stubs names a date.
 */

import { DestinationEmptyState } from '../components/journey/DestinationEmptyState';

export default function PracticePage() {
  return (
    <DestinationEmptyState
      title="Practice"
      description="This is where you'll answer questions out loud or in writing and get real feedback — what you got right, what you missed, and why."
      rightNow="There's nothing to practice here yet. For now, head back to Home to see what's ready."
    />
  );
}

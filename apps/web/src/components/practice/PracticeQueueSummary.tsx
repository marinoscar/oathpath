/**
 * "Your queue" — the coach-like read of `GET /api/practice/queue`, and the
 * first thing `/practice` says before it offers any action.
 *
 * Issue #90, epic #54 / E5 "Memory". Presentational only, in the shape
 * `InterviewCountdown` and `RecentSessions` already use: one icon, one bold
 * headline, one muted sentence beneath it, and every number rendered exactly
 * as the server sent it — no client-side re-derivation of a bucket rule
 * `mastery/selector.ts` already owns.
 *
 * =============================================================================
 * WHY THE HEADLINE IS THREE BRANCHES, NOT A GENERIC "N questions in your queue"
 * =============================================================================
 *
 * `due + weak` is the same figure `study-coach.ts`'s `recommendStudyAction`
 * gates its `review` rung on (`memory-model.md` §6) — reusing that threshold
 * here is what makes this card read as the same coach as Home's Next-up card,
 * not a second opinion. A learner with real due-or-weak evidence is told that
 * first; only once there is none does the card fall back to "new material
 * waiting"; only once neither is true does it say the honest thing left to
 * say, which is that there is nothing urgent right now.
 *
 * =============================================================================
 * THE BREAKDOWN IS A `<dl>`, NOT A ROW OF STYLED `<div>`S
 * =============================================================================
 *
 * Five label/value pairs have a native accessible structure already — a
 * definition list reads correctly to assistive technology with no ARIA at
 * all, which a flex row of divs would need to fake. `dt` (the label) comes
 * before `dd` (the count) in DOM and reading order for that reason, even
 * though the number is the visually larger line.
 */

import { Box, Typography } from '@mui/material';
import FactCheckOutlinedIcon from '@mui/icons-material/FactCheckOutlined';

import type { PracticeQueue } from '../../types';

/** "1 question" / "4 questions" — plural agreement, and nothing else. */
function questionCount(n: number): string {
  return n === 1 ? '1 question' : `${n} questions`;
}

/** One `dt`/`dd` pair. Order matches the `<dl>`'s: label first, then count. */
function Stat({ label, count }: { label: string; count: number }) {
  return (
    <Box sx={{ minWidth: '4.5rem' }}>
      <Typography
        component="dt"
        variant="caption"
        color="text.secondary"
        sx={{ display: 'block', textTransform: 'uppercase', letterSpacing: '0.04em' }}
      >
        {label}
      </Typography>
      <Typography component="dd" variant="h6" sx={{ fontWeight: 600, m: 0 }}>
        {count}
      </Typography>
    </Box>
  );
}

export interface PracticeQueueSummaryProps {
  queue: PracticeQueue;
  /** Ties the section to its heading for assistive technology. */
  headingId: string;
}

export function PracticeQueueSummary({ queue, headingId }: PracticeQueueSummaryProps) {
  // The exact gate `recommendStudyAction`'s `review` rung uses — see this
  // file's header. Exported so PracticePage can bias its Quick 5 copy off the
  // same number without re-deriving it.
  const reviewCount = queue.due + queue.weak;

  const headline =
    reviewCount > 0
      ? `${questionCount(reviewCount)} ready to review.`
      : queue.new.total > 0
        ? `${questionCount(queue.new.total)} you haven't seen yet.`
        : "You're caught up for now.";

  const detail =
    reviewCount > 0
      ? 'Due and struggling questions come up first when you start practising.'
      : queue.new.total > 0
        ? "Every new question you answer is more evidence you're ready."
        : "We'll keep sampling what you already know, so it stays that way.";

  return (
    <Box component="section" aria-labelledby={headingId}>
      <Typography
        id={headingId}
        variant="overline"
        component="h2"
        color="text.secondary"
        sx={{ display: 'block' }}
      >
        Your queue
      </Typography>

      <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 1.5, mt: 1 }}>
        <FactCheckOutlinedIcon aria-hidden color="action" sx={{ mt: 0.25, flexShrink: 0 }} />
        <Box sx={{ minWidth: 0 }}>
          <Typography component="p" sx={{ fontWeight: 600 }}>
            {headline}
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5, maxWidth: '60ch' }}>
            {detail}
          </Typography>
        </Box>
      </Box>

      <Box
        component="dl"
        sx={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: { xs: 2.5, sm: 4 },
          m: 0,
          mt: 2.5,
        }}
      >
        <Stat label="Due" count={queue.due} />
        <Stat label="Weak" count={queue.weak} />
        <Stat label="New" count={queue.new.total} />
        <Stat label="Learning" count={queue.learning} />
        <Stat label="Mastered" count={queue.mastered} />
      </Box>
    </Box>
  );
}

export default PracticeQueueSummary;

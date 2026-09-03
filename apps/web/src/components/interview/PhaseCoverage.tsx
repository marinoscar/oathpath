/**
 * Which parts of the interview this rehearsal actually conducted — and which it
 * named and skipped.
 *
 * Issue #145, epic #57 / E8.
 *
 * =============================================================================
 * THE SKIPPED PHASES ARE THE REASON THIS COMPONENT EXISTS
 * =============================================================================
 *
 * In text mode the `reading` and `writing` phases are recorded as `'skipped'`,
 * and `docs/specs/mock-interview.md` §2.4 names the harm that silence would
 * cause, in words worth keeping in front of whoever edits this next: a learner
 * who reads a debrief listing only the four phases that ran "has no way to tell
 * 'this rehearsal did not cover reading and writing yet' apart from 'OathPath
 * forgot to mention reading and writing exist'". The first is an honest,
 * temporary product limitation. The second is a learner walking into their real
 * interview believing they rehearsed a segment they never saw.
 *
 * So a skipped phase is rendered, in place, in order, saying so — never
 * omitted, never greyed into illegibility, and never left to the officer's
 * single mid-interview line to carry alone.
 *
 * =============================================================================
 * THE LIST COMES FROM THE RESPONSE, IN THE RESPONSE'S ORDER
 * =============================================================================
 *
 * `phases` is the API's own array, already in the order the phases are
 * conducted. It is neither sorted nor filtered here, and it is deliberately NOT
 * cross-checked against `INTERVIEW_PHASE_ORDER` in `phases.ts`: that constant
 * exists to answer "which part of six is this" on the live screen, and using it
 * to decide what a FINISHED interview contained would let a stale bundle claim
 * an interview had a phase the server never ran, or hide one it did.
 *
 * `phaseLabel` is used for the names, so a phase this build has never heard of
 * renders as "This part of the interview" rather than as a blank row — the
 * open-set-on-the-wire discipline that file's own header sets out.
 */

import { Box, Stack, Typography } from '@mui/material';
import CheckCircleOutlinedIcon from '@mui/icons-material/CheckCircleOutlined';
import RemoveCircleOutlineOutlinedIcon from '@mui/icons-material/RemoveCircleOutlineOutlined';

import type { InterviewPhaseStatus } from '../../types';
import { phaseLabel } from './phases';

export interface PhaseCoverageProps {
  phases: InterviewPhaseStatus[];
  /** Ties the section to its heading for assistive technology. */
  headingId: string;
}

/** The one sentence beside a phase name. Never a judgement, only a fact. */
function statusNote(status: string): string {
  if (status === 'completed') return 'Part of this rehearsal';
  if (status === 'skipped') return 'Not part of this rehearsal yet';
  // An unrecognised status from a newer server. Says only what is certainly
  // true: the phase was recorded, and this build cannot say more than that.
  return 'Recorded';
}

export function PhaseCoverage({ phases, headingId }: PhaseCoverageProps) {
  return (
    <Box component="section" aria-labelledby={headingId}>
      <Typography
        id={headingId}
        component="h2"
        variant="overline"
        color="text.secondary"
        sx={{ display: 'block', letterSpacing: '0.08em' }}
      >
        What this rehearsal covered
      </Typography>

      <Stack component="ul" spacing={1} sx={{ mt: 1.5, m: 0, p: 0, listStyle: 'none' }}>
        {phases.map((phase) => {
          const skipped = phase.status === 'skipped';
          const Icon = skipped
            ? RemoveCircleOutlineOutlinedIcon
            : CheckCircleOutlinedIcon;

          return (
            <Stack
              key={phase.kind}
              component="li"
              direction="row"
              spacing={1.5}
              sx={{ alignItems: 'flex-start' }}
            >
              {/* Decorative: the words beside it already say which of the two
                  this is, so a learner who cannot see the glyph — or cannot
                  tell the two apart — loses nothing. */}
              <Icon
                aria-hidden
                fontSize="small"
                color={skipped ? 'disabled' : 'action'}
                sx={{ mt: 0.25, flexShrink: 0 }}
              />
              <Box sx={{ minWidth: 0 }}>
                <Typography variant="body2" sx={{ fontWeight: 600 }}>
                  {phaseLabel(phase.kind)}
                </Typography>
                <Typography variant="body2" color="text.secondary">
                  {statusNote(phase.status)}
                </Typography>
              </Box>
            </Stack>
          );
        })}
      </Stack>
    </Box>
  );
}

export default PhaseCoverage;

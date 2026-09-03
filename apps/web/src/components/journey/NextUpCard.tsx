/**
 * The one recommendation Home renders — `journey-shell.md` §4 and §9.1.
 *
 * Issue #74, epic #50.
 *
 * =============================================================================
 * THE SERVER WROTE THE COPY. THIS COMPONENT DOES NOT SECOND-GUESS IT.
 * =============================================================================
 *
 * `title`, `reason` and `path` are rendered verbatim. There is deliberately NO
 * `switch (kind)` choosing wording here, and adding one would be a real defect
 * rather than a style disagreement: `apps/api/src/journey/next-action.ts` is a
 * pure function that already decided what to say, and a second copy of those
 * three strings in the browser would disagree with it the first time either is
 * edited — silently, because both would still render something plausible.
 *
 * `title` also proves the point: "12 days until your interview" is a
 * server-computed calendar-day count (§4.4). A client that owned this string
 * would have to own the arithmetic behind it, and a browser dividing a
 * timestamp difference by 86 400 000 gets the wrong answer across a DST
 * boundary.
 *
 * `kind` IS used, twice, and both uses are presentational only:
 *
 *   1. **An icon.** Purely decorative, `aria-hidden`, and carrying no
 *      information that is not already in the title beside it. This is exactly
 *      the exception the issue allows: an icon is not copy.
 *   2. **Nothing else.** The BUTTON LABEL is not keyed on `kind` either — see
 *      `actionLabel` below, which derives it from the destination registry the
 *      whole shell already reads.
 *
 * =============================================================================
 * THE BUTTON IS A ROUTER LINK, NOT AN `onClick`
 * =============================================================================
 *
 * Focusable, middle-clickable, and it shows its target in the status bar —
 * `DestinationEmptyState` makes the same choice for the same reasons. The
 * target is safe to hand to the router unexamined because §4.1 makes it so
 * structurally: `path` is one of the recommender's own hardcoded values, never
 * assembled from user input, and every one of them is a real mounted route that
 * does not redirect to `/`.
 */

import { Box, Button, Card, CardContent, Typography } from '@mui/material';
import AutorenewOutlinedIcon from '@mui/icons-material/AutorenewOutlined';
import EventAvailableOutlinedIcon from '@mui/icons-material/EventAvailableOutlined';
import ExploreOutlinedIcon from '@mui/icons-material/ExploreOutlined';
import PlaylistAddCheckOutlinedIcon from '@mui/icons-material/PlaylistAddCheckOutlined';
import RecordVoiceOverOutlinedIcon from '@mui/icons-material/RecordVoiceOverOutlined';
import type { SvgIconComponent } from '@mui/icons-material';
import { Link as RouterLink } from 'react-router-dom';

import {
  CONSOLE_DESTINATION,
  DESTINATIONS,
  SETTINGS_DESTINATION,
  resolveActiveDestination,
} from '../../config/destinations';
import type { NextAction, NextActionKind } from '../../types';

/**
 * One decorative glyph per kind. THE ONLY THING KEYED ON `kind` IN THIS FILE.
 *
 * An icon is not copy: it repeats what the server's own title already says, it
 * is `aria-hidden` where it is rendered, and a wrong one is a cosmetic bug
 * rather than the product telling a learner something untrue. That is the whole
 * reason this map is acceptable where a map of titles would not be.
 *
 * Typed as a total `Record` over the closed union on purpose: when E5 or E8
 * widens `NextActionKind` (with `review` and `interview`), this map fails to
 * compile until it gets its glyph — a build error is a better reminder than a
 * blank space on the front page. E3 (#81) was the first widening (`practice`
 * below); E5 (#82) is the second (`review`).
 */
const KIND_ICONS: Record<NextActionKind, SvgIconComponent> = {
  orientation: PlaylistAddCheckOutlinedIcon,
  interview_countdown: EventAvailableOutlinedIcon,
  explore: ExploreOutlinedIcon,
  // E3 (#52). `docs/specs/practice-sessions.md` §12: `NEXT_ACTION_PATHS` gains
  // `practice: '/practice'`, and the countdown branch re-points at it now that
  // Practice has real content to send a learner to.
  practice: RecordVoiceOverOutlinedIcon,
  // E5 (#82). `study-coach.ts`'s `recommendStudyAction` — due/lapsed evidence
  // to go back over, not new material.
  review: AutorenewOutlinedIcon,
};

/**
 * The glyph beside the title — with a FALLBACK, because the compile-time
 * totality above is not a runtime guarantee.
 *
 * `kind` arrives over the wire from a server that deploys independently of this
 * bundle. The day E5 adds `review`, every browser still holding today's
 * JavaScript receives a `kind` that is not in today's `KIND_ICONS`, and
 * `KIND_ICONS[kind]` is then `undefined`. Rendering `<undefined />` is not a
 * missing icon — React throws "Element type is invalid", the `ErrorBoundary`
 * catches it, and the learner's HOME SCREEN is replaced by an error for a
 * recommendation whose title, reason and path were all perfectly good.
 *
 * That failure is worth one line to prevent, and the fallback is honest: a
 * neutral glyph beside copy the server wrote. The card degrades to exactly what
 * it always was — the server's words, rendered verbatim — which is the whole
 * design of this component anyway. The BUTTON has never been keyed on `kind`
 * either (see `actionLabel`), so an unknown kind changes nothing else on the
 * card.
 */
function iconFor(kind: string): SvgIconComponent {
  return KIND_ICONS[kind as NextActionKind] ?? ExploreOutlinedIcon;
}

/**
 * Every destination whose label could name a `nextAction` target.
 *
 * The four bar destinations plus the two named ones, which is the complete set
 * — `DESTINATIONS` alone would be enough for E1's three paths, but this list
 * costs nothing and does not need revisiting if a later `kind` points at
 * settings.
 */
const LABELLED_DESTINATIONS = [
  ...DESTINATIONS,
  SETTINGS_DESTINATION,
  CONSOLE_DESTINATION,
];

/**
 * What the button says, DERIVED FROM THE DESTINATION REGISTRY rather than from
 * `kind`.
 *
 * §9.1 writes this as "Go to Learn." for both `interview_countdown` and
 * `explore` — but "Learn" is the name `config/destinations.ts` already gives
 * `/learn`, on the rail, in the bottom bar and in the AppBar title. Reading it
 * from there rather than restating it per kind means:
 *
 *   * the button and the nav row a learner is about to land on cannot disagree
 *     about what the place is called;
 *   * E3 re-pointing `interview_countdown` at `/practice` (§4) changes the
 *     button to "Go to Practice" with no edit here;
 *   * a new `kind` needs no entry in any list of labels.
 *
 * `/setup/journey` is deliberately owned by no destination (it is not a place
 * in the bar), so it falls through to "Continue" — honest and generic, which is
 * the right answer for a path the shell has no name for.
 */
function actionLabel(path: string): string {
  const key = resolveActiveDestination(path);
  const destination = LABELLED_DESTINATIONS.find((d) => d.key === key);
  return destination ? `Go to ${destination.label}` : 'Continue';
}

export interface NextUpCardProps {
  nextAction: NextAction;
  /** Ties the card to its heading for assistive technology. */
  headingId: string;
}

export function NextUpCard({ nextAction, headingId }: NextUpCardProps) {
  const Icon = iconFor(nextAction.kind);

  return (
    <Card
      component="section"
      aria-labelledby={headingId}
      variant="outlined"
      sx={{ mb: { xs: 3, sm: 4 } }}
    >
      <CardContent sx={{ p: { xs: 2, sm: 3 } }}>
        <Typography
          id={headingId}
          component="h2"
          variant="overline"
          color="text.secondary"
          sx={{ display: 'block', letterSpacing: '0.08em' }}
        >
          Next up
        </Typography>

        <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 1.5, mt: 1 }}>
          {/* Decorative, and hidden from assistive technology accordingly: the
              title immediately to its right is the information. */}
          <Icon aria-hidden color="primary" sx={{ mt: 0.5, flexShrink: 0 }} />
          <Box sx={{ minWidth: 0 }}>
            {/* `component="p"`: this is the card's most prominent line but not a
                heading — the section already has one, and a second heading here
                would put two different names on one region in a screen reader's
                heading list. */}
            <Typography
              component="p"
              variant="h6"
              sx={{ fontWeight: 600, lineHeight: 1.3 }}
            >
              {nextAction.title}
            </Typography>
            <Typography
              variant="body2"
              color="text.secondary"
              sx={{ mt: 1, maxWidth: '60ch' }}
            >
              {nextAction.reason}
            </Typography>
          </Box>
        </Box>

        <Button
          component={RouterLink}
          to={nextAction.path}
          variant="contained"
          // NOT `fullWidth`, even at 360px: the mockup's button is the width of
          // its words, and a stretched primary button on a page with a second
          // link below it reads as the only thing to do here.
          sx={{ mt: 2.5 }}
        >
          {actionLabel(nextAction.path)}
        </Button>
      </CardContent>
    </Card>
  );
}

export default NextUpCard;

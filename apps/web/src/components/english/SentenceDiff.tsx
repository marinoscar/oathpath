/**
 * The word-level diff of one English attempt (issue #144, epic #59 / E10).
 *
 * =============================================================================
 * WHY THIS COMPONENT EXISTS AT ALL
 * =============================================================================
 *
 * A learner told "78%" has learned nothing they can act on. `docs/specs/english-test.md`
 * §2.2 aligns the sentence and the transcript word by word precisely so that a
 * screen can say **which word** — and §9's own rejected-alternatives table names
 * that as the reason the alignment is word-level rather than character-level:
 * "what makes the required diff table directly legible as 'which words were
 * missed/added/swapped', the exact granularity a learner-facing correction
 * screen needs to render." This is that screen's renderer. The number is still
 * shown elsewhere; it is never the only thing shown.
 *
 * =============================================================================
 * THE DIFF IS NEVER COLOUR-ONLY. THIS IS AN ACCEPTANCE CRITERION, NOT A POLISH.
 * =============================================================================
 *
 * Every difference is carried on FOUR independent channels, and any one of them
 * alone is enough to read the diff:
 *
 *  1. **Words.** Each non-matching token is preceded, in the text itself, by a
 *     `visuallyHidden` label — "missing word:", "extra word:", "you said X
 *     instead of Y". These are real text nodes in reading order, not `title`
 *     attributes and not `aria-label`s on a `<span>` (which browsers and screen
 *     readers do not reliably expose on a non-interactive element). A screen
 *     reader therefore reads the sentence and the corrections as one continuous
 *     sentence — no mode switch, no table navigation, no "graphic".
 *  2. **A prose summary**, before the diff, that says the whole result in one
 *     sentence: "One word missing. One word changed." A user who never reaches
 *     the marked-up sentence still gets the finding.
 *  3. **Shape.** A missing word is struck through, a changed word is
 *     underlined, an extra word sits in brackets. Legible with no colour
 *     perception at all, and legible in a forced-colours / high-contrast mode
 *     where the palette below is discarded by the OS.
 *  4. **Icons**, `aria-hidden` because channel 1 already says it in words —
 *     duplicating it would read every correction twice.
 *
 * Colour is the fifth channel and is deliberately the *redundant* one. It is
 * `theme.palette` throughout — never a hex literal — so both themes get a token
 * that already meets contrast against their own background.
 *
 * =============================================================================
 * THE TOKENS SHOWN ARE THE SCORER'S, NOT THE SENTENCE'S SPELLING
 * =============================================================================
 *
 * Both sides are aligned AFTER `normalizeAnswer` (spec §2.1), so "first"
 * arrives here as `1` and "President of the United States" as the single token
 * `president`. Rendering the original spelling instead would show a learner a
 * diff that was not the one computed — a word marked wrong that the scorer
 * never looked at. So the normalised tokens are what is rendered, and the
 * caption says so in one line rather than leaving a learner to wonder why they
 * are being shown a digit.
 */

import AddIcon from '@mui/icons-material/Add';
import RemoveIcon from '@mui/icons-material/Remove';
import SwapHorizIcon from '@mui/icons-material/SwapHoriz';
import { Box, Stack, Typography } from '@mui/material';
import visuallyHidden from '@mui/utils/visuallyHidden';

import type { EnglishDiffOp } from '../../types';

export interface SentenceDiffProps {
  /** The alignment, in reference order, exactly as the API returned it. */
  diff: EnglishDiffOp[];
  /** Op counts, from the API — never recounted here. See {@link summarise}. */
  substitutions: number;
  deletions: number;
  insertions: number;
  /** Labels the region. Supply one when the diff sits under its own heading. */
  headingId?: string;
}

/**
 * The result in one plain sentence.
 *
 * READ FROM THE SERVER'S OWN COUNTS, not recounted from `diff`. The two are the
 * same alignment, but `errors` is what `docs/specs/english-test.md` §2.3's
 * outcome rule was applied to, and a summary derived from a second count could
 * disagree with the outcome beside it after any future change to either — the
 * "two things that must agree but are not derived from each other" failure this
 * codebase argues against everywhere else.
 *
 * Exported so the wording can be asserted directly.
 */
export function summarise(
  substitutions: number,
  deletions: number,
  insertions: number,
): string {
  const parts: string[] = [];
  if (deletions > 0) {
    parts.push(deletions === 1 ? 'one word missing' : `${deletions} words missing`);
  }
  if (substitutions > 0) {
    parts.push(
      substitutions === 1 ? 'one word changed' : `${substitutions} words changed`,
    );
  }
  if (insertions > 0) {
    parts.push(insertions === 1 ? 'one extra word' : `${insertions} extra words`);
  }

  if (parts.length === 0) return 'Every word matched.';

  const joined =
    parts.length === 1
      ? parts[0]
      : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;

  return `${joined.charAt(0).toUpperCase()}${joined.slice(1)}.`;
}

/** One legend row: the mark, then what it means. */
function LegendItem({
  icon,
  sample,
  label,
}: {
  icon: React.ReactNode;
  sample: React.ReactNode;
  label: string;
}) {
  return (
    <Stack direction="row" spacing={0.75} sx={{ alignItems: 'center' }}>
      {icon}
      {sample}
      <Typography variant="caption" color="text.secondary">
        {label}
      </Typography>
    </Stack>
  );
}

export function SentenceDiff({
  diff,
  substitutions,
  deletions,
  insertions,
  headingId,
}: SentenceDiffProps) {
  const summary = summarise(substitutions, deletions, insertions);
  const perfect = substitutions === 0 && deletions === 0 && insertions === 0;

  return (
    <Box aria-labelledby={headingId}>
      {/* CHANNEL 2. First in reading order, before any mark-up: the whole
          finding in one sentence, for anyone who does not read the diff below
          at all. */}
      <Typography variant="body2" sx={{ fontWeight: 600 }}>
        {summary}
      </Typography>

      {/* CHANNEL 1 + 3 + 4 + 5. One paragraph, in reference order, with the
          insertions in the position the aligner put them. `lang="en"` because a
          screen reader set to another language would otherwise read these words
          with the wrong pronunciation rules — on a screen whose entire subject
          is which English words were produced, that is not cosmetic. */}
      <Typography
        component="p"
        lang="en"
        sx={{
          mt: 1.5,
          // Big enough to read a struck-through word at 360px without zooming.
          fontSize: '1.125rem',
          lineHeight: 2,
          // The diff is the one thing on this screen that must not be clipped.
          overflowWrap: 'anywhere',
        }}
      >
        {diff.map((op, index) => {
          const key = `${op.kind}-${op.referenceIndex}-${index}`;

          if (op.kind === 'match') {
            return (
              <Box component="span" key={key}>
                {op.reference}{' '}
              </Box>
            );
          }

          if (op.kind === 'delete') {
            return (
              <Box
                component="span"
                key={key}
                sx={{ color: 'error.main', whiteSpace: 'nowrap' }}
              >
                {/* THE WHOLE FINDING, IN WORDS, INCLUDING THE WORD ITSELF —
                    and the full stop, which is what stops a screen reader
                    running the correction into the next word of the sentence.
                    The visible rendering below is `aria-hidden` precisely so
                    this is read once rather than twice. */}
                <Box component="span" sx={visuallyHidden}>
                  missing word: {op.reference}.{' '}
                </Box>
                <Box component="span" aria-hidden>
                  <RemoveIcon
                    sx={{ fontSize: '1rem', verticalAlign: 'text-bottom', mr: 0.25 }}
                  />
                  <Box component="span" sx={{ textDecoration: 'line-through' }}>
                    {op.reference}
                  </Box>{' '}
                </Box>
              </Box>
            );
          }

          if (op.kind === 'insert') {
            return (
              <Box
                component="span"
                key={key}
                sx={{ color: 'warning.dark', whiteSpace: 'nowrap' }}
              >
                <Box component="span" sx={visuallyHidden}>
                  extra word: {op.hypothesis}.{' '}
                </Box>
                {/* Brackets are the SHAPE channel — an extra word still reads
                    as an interjection with no colour perception at all and with
                    the icon font not loaded. */}
                <Box component="span" aria-hidden>
                  <AddIcon
                    sx={{ fontSize: '1rem', verticalAlign: 'text-bottom', mr: 0.25 }}
                  />
                  [{op.hypothesis}]{' '}
                </Box>
              </Box>
            );
          }

          // substitute
          return (
            <Box
              component="span"
              key={key}
              sx={{ color: 'warning.dark', whiteSpace: 'nowrap' }}
            >
              <Box component="span" sx={visuallyHidden}>
                you said {op.hypothesis} instead of {op.reference}.{' '}
              </Box>
              <Box component="span" aria-hidden>
                <SwapHorizIcon
                  sx={{ fontSize: '1rem', verticalAlign: 'text-bottom', mr: 0.25 }}
                />
                <Box
                  component="span"
                  sx={{ textDecoration: 'underline', textUnderlineOffset: 3 }}
                >
                  {op.hypothesis}
                </Box>{' '}
                <Box component="span" sx={{ textDecoration: 'line-through' }}>
                  {op.reference}
                </Box>{' '}
              </Box>
            </Box>
          );
        })}
      </Typography>

      {/* The legend, only for the marks actually on screen. A key explaining
          three symbols when one is present is noise, and it is also a claim
          that something is there which is not. */}
      {!perfect && (
        <Stack
          direction="row"
          spacing={2}
          useFlexGap
          sx={{ flexWrap: 'wrap', mt: 1 }}
          // The words beside every mark already say all of this; announcing the
          // key as well reads the same three facts a second time.
          aria-hidden
        >
          {deletions > 0 && (
            <LegendItem
              icon={
                <RemoveIcon sx={{ fontSize: '1rem', color: 'error.main' }} />
              }
              sample={
                <Typography
                  variant="caption"
                  sx={{ color: 'error.main', textDecoration: 'line-through' }}
                >
                  word
                </Typography>
              }
              label="missing"
            />
          )}
          {substitutions > 0 && (
            <LegendItem
              icon={<SwapHorizIcon sx={{ fontSize: '1rem', color: 'warning.dark' }} />}
              sample={
                <Typography
                  variant="caption"
                  sx={{
                    color: 'warning.dark',
                    textDecoration: 'underline',
                    textUnderlineOffset: 3,
                  }}
                >
                  word
                </Typography>
              }
              label="what you said instead"
            />
          )}
          {insertions > 0 && (
            <LegendItem
              icon={
                <AddIcon sx={{ fontSize: '1rem', color: 'warning.dark' }} />
              }
              sample={
                <Typography variant="caption" sx={{ color: 'warning.dark' }}>
                  [word]
                </Typography>
              }
              label="extra"
            />
          )}
        </Stack>
      )}

      {/* Why a learner who read "first" is looking at a `1`. One line, because
          the alternative is a diff that looks broken. */}
      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
        Words are compared in their plain form &mdash; lower case, no
        punctuation, and numbers written as digits. Spelling and capitalisation
        are never judged.
      </Typography>
    </Box>
  );
}

export default SentenceDiff;

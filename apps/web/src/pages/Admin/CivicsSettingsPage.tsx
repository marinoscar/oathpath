/**
 * Admin → Settings → Civics answers (`/admin/settings/civics`).
 *
 * Issue #126, epic #51. A REGISTRY CARD AND NOTHING ELSE, per `CLAUDE.md`'s
 * Settings UI Pattern: one entry in `ADMIN_SECTIONS` under General, one route
 * in `App.tsx` gated on the same permission string, and no tab anywhere. The
 * hub, the Console rail and the compact AppBar title all pick it up from that
 * single declaration.
 *
 * =============================================================================
 * THE PAGE'S SUBJECT IS A LIFECYCLE, NOT A FIELD
 * =============================================================================
 *
 * Correcting a governor or a Speaker does not overwrite a value. It CLOSES the
 * open `civics_answers` row and OPENS a new one, in one transaction
 * (`civics-content.md` §4), because `practice_attempts.answer_snapshot` (E3)
 * must keep pointing at text a learner was actually shown. So this page reads
 * that way throughout rather than pretending to be a form over a text column:
 *
 *   - the confirm step says the current answer will be closed, not replaced;
 *   - the result panel names BOTH rows, the closed one and the opened one, and
 *     gives the new effective date, which is the fact a correction produces;
 *   - `effectiveFrom` is offered as the REAL-WORLD date of the change, because
 *     that is the instant the two rows meet at.
 *
 * Presenting only the new value would read exactly like the in-place edit the
 * lifecycle refuses to perform, and would leave an admin with no idea that a
 * mistake here leaves two rows on the record rather than one wrong one.
 *
 * =============================================================================
 * REACHABILITY VERSUS CONTENT
 * =============================================================================
 *
 * The route and the card gate on `system_settings:read` — the exact string
 * `civics-admin.controller.ts` enforces on its GET, reused and never invented
 * (`civics-content.md` §9). Every WRITE control on this page gates internally
 * on `system_settings:write`, the string the same controller enforces on its
 * PUT. That split is the distinction `CLAUDE.md` draws: the route gate is about
 * REACHABILITY, and a read-only admin checking "is this actually what we are
 * telling learners" is worth letting in to look; the disabled Edit buttons are
 * about CONTENT.
 *
 * =============================================================================
 * WHAT THIS SURFACE DELIBERATELY CANNOT DO
 * =============================================================================
 *
 * Edit a prompt, a category, a `dynamicScope`, or any `none`-scope answer.
 * Those are content, changed by a reviewed PR and a reseed (§6–§7) — an admin
 * edit path to them would be a second, weaker-reviewed way to change rows that
 * only ever change through review. `none`-scope questions are consequently not
 * even listed by the endpoint; if one is submitted anyway (a reseed changed a
 * question's scope while this page was open) the API answers 400 with a
 * sentence explaining why, and this page shows that sentence verbatim rather
 * than flattening it to "could not save".
 *
 * =============================================================================
 * STATES ARE NAMED BY CODE, ON PURPOSE
 * =============================================================================
 *
 * There is no state-name list in `apps/web/src/config`, and this page does not
 * add one. The 56 codes travel on the learner profile response for the
 * orientation form, and the API validates against the same constant it serves —
 * a second copy here would be exactly the duplicate registry `types/index.ts`
 * and `journey-shell.md` §6 reject. Codes are also what this endpoint's
 * `stateCode`, `missingStateCodes` and audit rows speak in, so an administrator
 * reading this page is reading the same identifiers the API does.
 */

import { useMemo, useState } from 'react';
import { Navigate } from 'react-router-dom';
import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
  Alert,
  AlertTitle,
  Box,
  Button,
  Chip,
  Container,
  Divider,
  MenuItem,
  Pagination,
  Paper,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';

import { LoadingSpinner } from '../../components/common/LoadingSpinner';
import { CivicsAnswerDialog, questionLabel } from '../../components/admin/CivicsAnswerDialog';
import { usePermissions } from '../../hooks/usePermissions';
import {
  useCivicsDynamicAnswers,
  type CivicsScopeFilter,
} from '../../hooks/useCivicsDynamicAnswers';
import type { CivicsDynamicAnswer, CivicsDynamicAnswerItem } from '../../types';

/**
 * A date as an administrator should read it.
 *
 * FORMATTED IN UTC, deliberately. `effectiveFrom` is a real-world DAY that
 * reaches the wire as UTC midnight, so rendering it in the browser's own zone
 * would show "2 January" to anybody west of Greenwich for a change that took
 * effect on the 3rd — an off-by-one in the one field this page exists to get
 * right.
 */
function formatDay(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    timeZone: 'UTC',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

/** One editable slot: a state with its open answer, or a state with none. */
interface AnswerSlot {
  /** null for a `national` question. */
  stateCode: string | null;
  /** The open row, or null for a gap `missingStateCodes` reported. */
  answer: CivicsDynamicAnswer | null;
}

/**
 * Every slot of a question, gaps included, in a stable order.
 *
 * The gaps are merged in rather than listed separately because they are the
 * rows an admin most needs to act on: a state with no open answer is a state
 * whose learners see an unanswerable question, and burying it under the 50 that
 * are fine would hide the one thing this list is uniquely able to reveal.
 */
function slotsOf(item: CivicsDynamicAnswerItem): AnswerSlot[] {
  if (item.dynamicScope === 'national') {
    return [{ stateCode: null, answer: item.answers[0] ?? null }];
  }

  const withAnswers: AnswerSlot[] = item.answers.map((answer) => ({
    stateCode: answer.stateCode,
    answer,
  }));
  const gaps: AnswerSlot[] = item.missingStateCodes.map((stateCode) => ({
    stateCode,
    answer: null,
  }));

  return [...withAnswers, ...gaps].sort((a, b) =>
    (a.stateCode ?? '').localeCompare(b.stateCode ?? ''),
  );
}

/** The accessible name of a slot's Edit button — unique per row, and readable alone. */
function editLabel(item: CivicsDynamicAnswerItem, slot: AnswerSlot): string {
  const where = slot.stateCode ? `${slot.stateCode}` : 'the national answer';
  return slot.stateCode
    ? `Correct the answer for ${where} on question ${item.number}`
    : `Correct ${where} for question ${item.number}`;
}

export default function CivicsSettingsPage() {
  const { hasPermission } = usePermissions();
  const {
    items,
    total,
    page,
    totalPages,
    scope,
    setScope,
    setPage,
    isLoading,
    loadError,
    isSaving,
    saveError,
    clearSaveError,
    lastCorrection,
    clearLastCorrection,
    correct,
  } = useCivicsDynamicAnswers();

  /** Which slot's dialog is open, addressed the way the API addresses it. */
  const [editing, setEditing] = useState<{
    item: CivicsDynamicAnswerItem;
    slot: AnswerSlot;
  } | null>(null);

  /** Per-question client-side narrowing of a 56-row state list. Keyed by question id. */
  const [stateFilters, setStateFilters] = useState<Record<string, string>>({});

  const slotsByQuestion = useMemo(
    () => new Map(items.map((item) => [item.questionId, slotsOf(item)])),
    [items],
  );

  // Defence, not the gate — `App.tsx` wraps the route in `RequirePermission`
  // with this same string. This catches the page mounted from anywhere else,
  // and it sits after every hook so the hook order never changes.
  if (!hasPermission('system_settings:read')) {
    return <Navigate to="/" replace />;
  }

  const canWrite = hasPermission('system_settings:write');

  const openEditor = (item: CivicsDynamicAnswerItem, slot: AnswerSlot) => {
    clearSaveError();
    clearLastCorrection();
    setEditing({ item, slot });
  };

  return (
    <Container maxWidth="lg">
      <Box sx={{ py: 4 }}>
        {/* Title and description MIRROR the `Civics Answers` card in
            `config/adminSections.tsx`, so the hub card, the rail row, the
            compact AppBar title and this `h1` all name the page identically. */}
        <Typography variant="h4" component="h1" gutterBottom>
          Civics Answers
        </Typography>
        <Typography color="text.secondary" sx={{ mb: 2 }}>
          Correct the civics answers that change on their own — officeholders nationally and by
          state.
          {/* Stated up front rather than left for the user to discover by
              finding every control disabled. */}
          {!canWrite && ' (read-only)'}
        </Typography>

        <Alert severity="info" sx={{ mb: 3 }}>
          <AlertTitle>A correction adds a new answer — it does not overwrite one</AlertTitle>
          Recording a correction closes the current answer on the date the change took effect and
          opens a new one. The closed answer stays on record, so a learner graded against it last
          month can still be told what they were shown and why it was right at the time. Question
          wording, categories and the static answer bank are not editable here: those change
          through a reviewed content change.
        </Alert>

        {!canWrite && (
          <Alert severity="info" sx={{ mb: 3 }}>
            You can read these answers but not change them. Recording a correction needs permission
            to change system settings.
          </Alert>
        )}

        {loadError && (
          <Alert severity="error" sx={{ mb: 3 }}>
            {loadError}
          </Alert>
        )}

        {/* THE RESULT OF A CORRECTION, named as the pair of rows it really is.
            `role="status"` rather than the default `alert`: this is the
            expected outcome of a deliberate action, announced politely, where
            the red band on this page belongs to a correction that was refused. */}
        {lastCorrection && (
          <Alert severity="success" role="status" sx={{ mb: 3 }} onClose={clearLastCorrection}>
            <AlertTitle>
              New answer recorded — effective from {formatDay(lastCorrection.current.effectiveFrom)}
            </AlertTitle>
            Question {questionLabel(lastCorrection)}
            {lastCorrection.stateCode ? `, ${lastCorrection.stateCode}` : ''}: “
            {lastCorrection.current.text}” is now the answer learners see.{' '}
            {lastCorrection.previous ? (
              <>
                The previous answer, “{lastCorrection.previous.text}”, was closed as of{' '}
                {formatDay(lastCorrection.previous.effectiveTo ?? lastCorrection.current.effectiveFrom)}{' '}
                and stays on record.
              </>
            ) : (
              <>This slot had no answer before, so nothing was closed.</>
            )}
          </Alert>
        )}

        {/* A refused correction, surfaced OUTSIDE the dialog as well: the
            dialog shows it in place while it is open, and this keeps the
            explanation on screen if the admin closed the dialog to go and read
            it. Verbatim in both places — the API's 400s here are the sentence
            that says what to do instead. */}
        {saveError && !editing && (
          <Alert severity="error" sx={{ mb: 3 }} onClose={clearSaveError}>
            <AlertTitle>The correction was not recorded</AlertTitle>
            {saveError}
          </Alert>
        )}

        <Paper sx={{ p: { xs: 2, sm: 3 }, mb: 3 }}>
          <Stack
            direction={{ xs: 'column', sm: 'row' }}
            spacing={2}
            sx={{ alignItems: { xs: 'stretch', sm: 'center' } }}
          >
            <TextField
              select
              label="Scope"
              value={scope}
              onChange={(event) => setScope(event.target.value as CivicsScopeFilter)}
              sx={{ minWidth: { sm: 220 } }}
              helperText="Which answers vary by state."
            >
              <MenuItem value="all">All dynamic answers</MenuItem>
              <MenuItem value="national">National only</MenuItem>
              <MenuItem value="state">State only</MenuItem>
            </TextField>
            <Typography variant="body2" color="text.secondary">
              {isLoading
                ? 'Loading…'
                : `${total} question${total === 1 ? '' : 's'} whose answer changes over time.`}
            </Typography>
          </Stack>
        </Paper>

        {isLoading && <LoadingSpinner />}

        {!isLoading && !loadError && items.length === 0 && (
          <Alert severity="info">
            No dynamic questions match this filter. Static questions are not administered here.
          </Alert>
        )}

        {!isLoading &&
          items.map((item) => {
            const slots = slotsByQuestion.get(item.questionId) ?? [];
            const filter = (stateFilters[item.questionId] ?? '').trim().toUpperCase();
            const visibleSlots = filter
              ? slots.filter((slot) => (slot.stateCode ?? '').includes(filter))
              : slots;
            const nationalAnswer = item.dynamicScope === 'national' ? slots[0]?.answer : null;

            return (
              <Accordion
                key={item.questionId}
                disableGutters
                // MUI already wraps every summary in a heading — an `h3` by
                // default — so the question title must NOT also be a heading
                // inside the button, which would nest an `h2` in an `h3` and
                // hide it from the accessibility tree anyway. Retargeting the
                // wrapper is what puts the questions at `h2` directly under this
                // page's single `h1`.
                slotProps={{ heading: { component: 'h2' } }}
              >
                <AccordionSummary
                  expandIcon={<ExpandMoreIcon />}
                  aria-controls={`civics-${item.questionId}-content`}
                  id={`civics-${item.questionId}-header`}
                >
                  <Box sx={{ minWidth: 0 }}>
                    <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>
                      {questionLabel(item)} {item.prompt}
                    </Typography>
                    <Stack
                      direction="row"
                      spacing={1}
                      sx={{ mt: 1, flexWrap: 'wrap', gap: 1 }}
                      useFlexGap
                    >
                      <Chip
                        size="small"
                        label={item.dynamicScope === 'state' ? 'Varies by state' : 'National'}
                      />
                      {nationalAnswer && (
                        <Chip
                          size="small"
                          variant="outlined"
                          label={`Currently: ${nationalAnswer.text}`}
                        />
                      )}
                      {item.missingStateCodes.length > 0 && (
                        <Chip
                          size="small"
                          color="warning"
                          label={`${item.missingStateCodes.length} state${
                            item.missingStateCodes.length === 1 ? '' : 's'
                          } with no answer`}
                        />
                      )}
                    </Stack>
                  </Box>
                </AccordionSummary>
                <AccordionDetails id={`civics-${item.questionId}-content`}>
                  {item.missingStateCodes.length > 0 && (
                    <Alert severity="warning" sx={{ mb: 2 }}>
                      <AlertTitle>Learners in some states cannot answer this</AlertTitle>
                      No answer is recorded for {item.missingStateCodes.join(', ')}. Until one is,
                      a learner in those states is shown the question with nothing to study.
                    </Alert>
                  )}

                  {item.dynamicScope === 'state' && slots.length > 8 && (
                    <TextField
                      label="Filter states"
                      value={stateFilters[item.questionId] ?? ''}
                      onChange={(event) =>
                        setStateFilters((current) => ({
                          ...current,
                          [item.questionId]: event.target.value,
                        }))
                      }
                      size="small"
                      sx={{ mb: 2, width: { xs: '100%', sm: 240 } }}
                      helperText="By two-letter code, e.g. OH."
                    />
                  )}

                  <Stack divider={<Divider />} spacing={0}>
                    {visibleSlots.map((slot) => (
                      <Box
                        key={slot.stateCode ?? 'national'}
                        sx={{
                          display: 'flex',
                          flexDirection: { xs: 'column', sm: 'row' },
                          alignItems: { xs: 'stretch', sm: 'center' },
                          gap: { xs: 1, sm: 2 },
                          py: 1.5,
                        }}
                      >
                        <Typography
                          variant="body2"
                          sx={{ fontWeight: 600, minWidth: { sm: 56 }, flexShrink: 0 }}
                        >
                          {slot.stateCode ?? 'National'}
                        </Typography>
                        <Box sx={{ flexGrow: 1, minWidth: 0 }}>
                          {slot.answer ? (
                            <>
                              <Typography sx={{ wordBreak: 'break-word' }}>
                                {slot.answer.text}
                              </Typography>
                              <Typography variant="body2" color="text.secondary">
                                {/* `verifiedAt` is when a human last confirmed
                                    this text; `effectiveFrom` is when it became
                                    true. Both, because they answer different
                                    questions and an admin needs the second to
                                    date a correction. */}
                                Verified {formatDay(slot.answer.verifiedAt)} · effective from{' '}
                                {formatDay(slot.answer.effectiveFrom)}
                              </Typography>
                              {slot.answer.sourceNote && (
                                <Typography
                                  variant="body2"
                                  color="text.secondary"
                                  sx={{ wordBreak: 'break-word' }}
                                >
                                  Source: {slot.answer.sourceNote}
                                </Typography>
                              )}
                            </>
                          ) : (
                            <Typography color="warning.main">
                              No answer recorded for this state.
                            </Typography>
                          )}
                        </Box>
                        <Button
                          variant="outlined"
                          size="small"
                          disabled={!canWrite}
                          aria-label={editLabel(item, slot)}
                          onClick={() => openEditor(item, slot)}
                          sx={{ flexShrink: 0, alignSelf: { xs: 'flex-start', sm: 'center' } }}
                        >
                          {slot.answer ? 'Correct' : 'Add answer'}
                        </Button>
                      </Box>
                    ))}
                  </Stack>
                </AccordionDetails>
              </Accordion>
            );
          })}

        {totalPages > 1 && (
          <Box sx={{ display: 'flex', justifyContent: 'center', mt: 3 }}>
            <Pagination
              count={totalPages}
              page={page}
              onChange={(_, next) => setPage(next)}
              // The default sits at `md`; on a phone even five numbered pages
              // plus both arrows overflow 360px.
              siblingCount={0}
            />
          </Box>
        )}

        {editing && (
          <CivicsAnswerDialog
            open
            question={editing.item}
            stateCode={editing.slot.stateCode}
            currentAnswer={editing.slot.answer}
            isSaving={isSaving}
            error={saveError}
            onDismissError={clearSaveError}
            onClose={() => setEditing(null)}
            onSubmit={correct}
          />
        )}
      </Box>
    </Container>
  );
}

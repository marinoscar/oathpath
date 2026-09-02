/**
 * The one place a learner answers the six orientation questions.
 *
 * Issue #72, epic #50, copy from `docs/specs/journey-shell.md` §7 VERBATIM.
 * TWO CHROMES CONSUME THIS AND NEITHER FORKS IT: the full-screen orientation
 * screen (`/setup/journey`, this issue) and the ongoing settings page
 * (`/settings/journey`, #77). This is `components/ai/AiKeyForm.tsx`'s
 * arrangement, for the same reason — two copies drift, and the half most
 * likely to drift is the copy, which is the deliverable here rather than
 * decoration.
 *
 * =============================================================================
 * WHO IS READING THIS
 * =============================================================================
 *
 * Someone preparing for a naturalization interview, often an ESL speaker, being
 * asked for an immigration filing date they may have to go and look up. So the
 * sentences are short and plain, nothing is condescending about English
 * ability, and where the answer genuinely depends on their date the screen says
 * so instead of implying they should already know which test they take.
 *
 * `VISION.md`'s tone review is what §7's strings passed, which is why they are
 * used word for word rather than paraphrased. If a string here needs to change,
 * change the spec.
 *
 * =============================================================================
 * THE FILING DATE RESOLVES THE TEST VERSION, AND THE BROWSER NEVER LEARNS HOW
 * =============================================================================
 *
 * The cutoff date exists exactly once in this repository, on the server
 * (`apps/api/src/journey/test-version-resolution.ts`). This form submits
 * `filingDate` and lets the server resolve the version — it never sends
 * `testVersionCode`, and the API rejects a request carrying both.
 *
 * What it DOES do is tell the learner which test their date selects, because
 * silently resolving something that changes what they will be asked to study is
 * the opposite of honest. It derives that preview from `filedFrom` on the test
 * versions the server sent (see {@link resolveTestVersionForFilingDate}) —
 * server DATA, not a rule reimplemented here. Hardcoding "20 October 2025" in a
 * comparison would give the cutoff a second home and the two would disagree the
 * day it needs a carve-out.
 *
 * The one place that date appears in this file is inside §7's helper TEXT,
 * which is copy the learner reads, not a value anything branches on.
 *
 * =============================================================================
 * THE TIMEZONE IS CAPTURED, NOT ASKED
 * =============================================================================
 *
 * `Intl.DateTimeFormat().resolvedOptions().timeZone` is already correct for
 * essentially every learner, and a seventh question — a 400-entry IANA list —
 * would cost more than it could ever earn on a first-run screen. It is stored,
 * so a later screen can offer to change it; it is not asked here.
 */

import { useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import {
  Alert,
  AlertTitle,
  Box,
  Button,
  Checkbox,
  CircularProgress,
  FormControl,
  FormControlLabel,
  FormHelperText,
  FormLabel,
  Stack,
  TextField,
  Typography,
} from '@mui/material';

import { useLearnerProfile } from '../../contexts/LearnerProfileContext';
import { ApiError, updateJourneyProfile } from '../../services/api';
import type {
  CivicsTestVersionOption,
  JourneyProfileResponse,
  UpdateJourneyProfileInput,
} from '../../types';

/**
 * The daily goal's accepted range, mirroring `DAILY_GOAL_MIN_MINUTES` /
 * `DAILY_GOAL_MAX_MINUTES` in the API's DTO.
 *
 * Checked here so a mistyped goal is corrected in place rather than bouncing
 * off a 400 the learner has to interpret; the API is still the authority, and a
 * value that slips past this is rejected there.
 */
const MIN_GOAL_MINUTES = 1;
const MAX_GOAL_MINUTES = 480;

/**
 * The languages offered for AI explanations.
 *
 * NOT A REGISTRY, and deliberately not fetched: the API accepts any well-formed
 * BCP-47 tag (it validates STRUCTURE, not membership of a list), so this is a
 * convenience shortlist for a select, not a second declaration of an
 * authoritative set. It leads with the languages most commonly spoken by
 * naturalization applicants.
 *
 * Each is written in its own language as well as in English, because a learner
 * scanning for their language should not have to read English to find it.
 */
const EXPLANATION_LANGUAGES: Array<{ tag: string; label: string }> = [
  { tag: 'en', label: 'English' },
  { tag: 'es', label: 'Español (Spanish)' },
  { tag: 'zh-Hans', label: '简体中文 (Chinese, Simplified)' },
  { tag: 'zh-Hant', label: '繁體中文 (Chinese, Traditional)' },
  { tag: 'vi', label: 'Tiếng Việt (Vietnamese)' },
  { tag: 'tl', label: 'Tagalog' },
  { tag: 'ko', label: '한국어 (Korean)' },
  { tag: 'ht', label: 'Kreyòl ayisyen (Haitian Creole)' },
  { tag: 'ar', label: 'العربية (Arabic)' },
  { tag: 'ru', label: 'Русский (Russian)' },
  { tag: 'pt', label: 'Português (Portuguese)' },
  { tag: 'fr', label: 'Français (French)' },
  { tag: 'bn', label: 'বাংলা (Bengali)' },
  { tag: 'ur', label: 'اردو (Urdu)' },
  { tag: 'hi', label: 'हिन्दी (Hindi)' },
];

/**
 * Which civics test a filing date selects, from the versions the server sent.
 *
 * PURE, AND DATA-DRIVEN. It reads `filedFrom` — the earliest filing date a
 * version applies to, `null` when it has no lower bound — and picks the version
 * with the latest bound the date clears. Add a third test revision to the
 * server's table and this preview picks it up with no edit here, which is the
 * whole reason the eligibility rule travels as data rather than being restated.
 *
 * Exported for its own unit test: a preview that quietly names the wrong test
 * is worse than no preview, and it is not something an integration test would
 * notice.
 *
 * @param filingDate a `YYYY-MM-DD` calendar date. Zero-padded ISO dates compare
 *   correctly as strings, so this needs no `Date` and no notion of "now".
 */
export function resolveTestVersionForFilingDate(
  filingDate: string,
  versions: CivicsTestVersionOption[],
): CivicsTestVersionOption | null {
  if (!filingDate) return null;

  const eligible = versions.filter(
    (version) => version.filedFrom === null || filingDate >= version.filedFrom,
  );
  if (eligible.length === 0) return null;

  return eligible.reduce((best, version) =>
    (version.filedFrom ?? '') > (best.filedFrom ?? '') ? version : best,
  );
}

/** The browser's own IANA zone. See the header on why this is not a question. */
function detectTimezone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
  } catch {
    // A browser that cannot report its zone leaves the field absent, which the
    // merge semantics define as "unchanged" — the column keeps its default
    // rather than being overwritten with a guess.
    return undefined;
  }
}

/** Field-level messages, keyed by the control they belong to. */
interface FieldErrors {
  filingDate?: string;
  stateCode?: string;
  dailyGoalMinutes?: string;
}

export interface JourneyProfileFormProps {
  /**
   * Label on the primary action. Orientation says §7's "Save and continue";
   * the settings page says "Save changes".
   */
  submitLabel?: string;

  /**
   * Called after a successful save, with the server's response.
   *
   * Orientation uses it to hand off into the app. The settings page passes
   * nothing — the learner is already where they want to be — and gets the
   * inline confirmation below instead.
   */
  onSaved?: (response: JourneyProfileResponse) => void;
}

export function JourneyProfileForm({
  submitLabel = 'Save and continue',
  onSaved,
}: JourneyProfileFormProps) {
  const { profile, testVersions, states, applyProfile } = useLearnerProfile();

  // Initialised from the profile ONCE, on first render, and thereafter owned by
  // the form. Re-syncing from context on every change would fight the learner's
  // typing the moment a save lands.
  const [filingDate, setFilingDate] = useState('');
  const [seniorExemption, setSeniorExemption] = useState(
    profile?.seniorExemption ?? false,
  );
  const [interviewDate, setInterviewDate] = useState(
    profile?.interviewDate ?? '',
  );
  const [stateCode, setStateCode] = useState(profile?.stateCode ?? '');
  const [dailyGoalMinutes, setDailyGoalMinutes] = useState(
    String(profile?.dailyGoalMinutes ?? 5),
  );
  const [explanationLanguage, setExplanationLanguage] = useState(
    profile?.explanationLanguage ?? 'en',
  );

  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [isSaving, setIsSaving] = useState(false);

  /**
   * The version already resolved for this learner, if any.
   *
   * A settings-page learner has a stored `testVersionCode` and no filing date
   * to redisplay — the date is an input the server resolves from, never stored
   * — so the preview falls back to what is on the profile rather than going
   * blank and implying nothing was ever chosen.
   */
  const storedVersion = useMemo(
    () =>
      testVersions.find(
        (version) => version.code === profile?.testVersionCode,
      ) ?? null,
    [testVersions, profile?.testVersionCode],
  );

  const previewVersion = useMemo(
    () => resolveTestVersionForFilingDate(filingDate, testVersions) ?? storedVersion,
    [filingDate, testVersions, storedVersion],
  );

  /**
   * A filing date is required only while no version has been resolved yet.
   *
   * Orientation always needs one. The settings page must not force a learner
   * who is only changing their daily goal to re-enter a date they already gave
   * — and re-sending the same date would be a no-op anyway.
   */
  const filingDateRequired = !profile?.testVersionCode;

  function validate(): FieldErrors {
    const errors: FieldErrors = {};

    if (filingDateRequired && !filingDate) {
      errors.filingDate =
        'We need your filing date to know which civics test applies to you.';
    }

    if (!stateCode) {
      errors.stateCode = 'Please choose your state or territory.';
    }

    const goal = Number(dailyGoalMinutes);
    if (
      !Number.isInteger(goal) ||
      goal < MIN_GOAL_MINUTES ||
      goal > MAX_GOAL_MINUTES
    ) {
      errors.dailyGoalMinutes = `Please enter a whole number of minutes, between ${MIN_GOAL_MINUTES} and ${MAX_GOAL_MINUTES}.`;
    }

    return errors;
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setSaved(false);
    setSubmitError(null);

    const errors = validate();
    setFieldErrors(errors);
    if (Object.keys(errors).length > 0) return;

    // `filingDate` and NEVER `testVersionCode` — the server owns the cutoff,
    // and a request carrying both is a 400. An empty date is omitted rather
    // than sent blank, which the merge semantics read as "leave it alone".
    const timezone = detectTimezone();

    const body: UpdateJourneyProfileInput = {
      ...(filingDate ? { filingDate } : {}),
      seniorExemption,
      // Explicit null CLEARS a booked date — the one field where absent and
      // null differ, and the only way to say "the interview was cancelled".
      interviewDate: interviewDate ? interviewDate : null,
      stateCode,
      dailyGoalMinutes: Number(dailyGoalMinutes),
      explanationLanguage,
      ...(timezone ? { timezone } : {}),
    };

    setIsSaving(true);
    try {
      const response = await updateJourneyProfile(body);
      // Push the server's own answer into context rather than refetching it:
      // the gate is released on this tick, with no second round trip.
      applyProfile(response);
      setSaved(true);
      onSaved?.(response);
    } catch (error) {
      setSubmitError(
        error instanceof ApiError && error.message
          ? error.message
          : 'We could not save your answers. Please check your connection and try again.',
      );
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <Box component="form" onSubmit={handleSubmit} noValidate>
      <Stack spacing={3}>
        {/* --- 1. Filing date -------------------------------------------- */}
        <Box>
          <TextField
            id="journey-filing-date"
            type="date"
            label="When did you file your Form N-400?"
            value={filingDate}
            onChange={(event) => setFilingDate(event.target.value)}
            error={Boolean(fieldErrors.filingDate)}
            helperText={
              fieldErrors.filingDate ??
              "This tells us which civics test applies to you — the test changed for people who filed on or after October 20, 2025. We'll pick the right one for you automatically."
            }
            required={filingDateRequired}
            fullWidth
            slotProps={{ inputLabel: { shrink: true } }}
          />

          {/* The resolution, said out loud. Silently choosing what a learner
              will be asked to study is the failure this prevents. */}
          <Box sx={{ mt: 1.5 }} aria-live="polite">
            {previewVersion ? (
              <Alert severity="info" icon={false}>
                <AlertTitle sx={{ mb: 0.5 }}>
                  Your test: {previewVersion.label}
                </AlertTitle>
                <Typography variant="body2">
                  {seniorExemption
                    ? `${previewVersion.seniorQuestionsAsked} questions at the interview, and ${previewVersion.seniorPassThreshold} correct to pass, with the accommodation below.`
                    : `${previewVersion.questionsAsked} questions at the interview, and ${previewVersion.passThreshold} correct to pass.`}
                </Typography>
              </Alert>
            ) : (
              <Typography variant="body2" color="text.secondary">
                Once you add your filing date, we will show you here which test
                that means.
              </Typography>
            )}
          </Box>
        </Box>

        {/* --- 2. Senior exemption ---------------------------------------- */}
        <FormControl component="fieldset" variant="standard">
          <FormLabel component="legend" sx={{ typography: 'body1' }}>
            Are you 65 or older, with a green card for 20 years or more?
          </FormLabel>
          <FormControlLabel
            control={
              <Checkbox
                checked={seniorExemption}
                onChange={(event) => setSeniorExemption(event.target.checked)}
                slotProps={{
                  input: { 'aria-describedby': 'journey-senior-helper' },
                }}
              />
            }
            label="Yes, both are true"
          />
          <FormHelperText id="journey-senior-helper">
            If both are true, you may only need to know a shorter list of
            questions. Answer honestly — this changes what we ask you to
            practice.
          </FormHelperText>
        </FormControl>

        {/* --- 3. Interview date (optional) -------------------------------- */}
        <TextField
          id="journey-interview-date"
          type="date"
          label="Do you have an interview date yet? (Optional)"
          value={interviewDate}
          onChange={(event) => setInterviewDate(event.target.value)}
          helperText="If you don't have one yet, that's completely normal — leave this blank and add it later."
          fullWidth
          slotProps={{ inputLabel: { shrink: true } }}
        />

        {/* --- 4. State or territory --------------------------------------
            A NATIVE select, unlike the MUI menus elsewhere in the app. Fifty-six
            options is where a phone's own picker stops being a downgrade and
            starts being the better control — it scrolls with one thumb and
            types-to-jump. */}
        <TextField
          id="journey-state"
          select
          label="Which state or territory do you live in?"
          value={stateCode}
          onChange={(event) => setStateCode(event.target.value)}
          error={Boolean(fieldErrors.stateCode)}
          helperText={
            fieldErrors.stateCode ??
            "Some civics questions have answers that depend on where you live — like the name of your state's current governor."
          }
          required
          fullWidth
          slotProps={{
            select: { native: true },
            inputLabel: { shrink: true },
          }}
        >
          <option value="">Select a state or territory</option>
          {states.map((state) => (
            <option key={state.code} value={state.code}>
              {state.name}
            </option>
          ))}
        </TextField>

        {/* --- 5. Daily goal ---------------------------------------------- */}
        <TextField
          id="journey-daily-goal"
          type="number"
          label="How many minutes a day do you want to aim for?"
          value={dailyGoalMinutes}
          onChange={(event) => setDailyGoalMinutes(event.target.value)}
          error={Boolean(fieldErrors.dailyGoalMinutes)}
          helperText={
            fieldErrors.dailyGoalMinutes ??
            'Five minutes should matter. Start small — you can always do more, and a short streak beats a skipped week.'
          }
          fullWidth
          slotProps={{
            htmlInput: {
              min: MIN_GOAL_MINUTES,
              max: MAX_GOAL_MINUTES,
              step: 1,
              inputMode: 'numeric',
            },
          }}
        />

        {/* --- 6. Explanation language ------------------------------------- */}
        <TextField
          id="journey-language"
          select
          label="What language should we use to explain a tricky answer?"
          value={explanationLanguage}
          onChange={(event) => setExplanationLanguage(event.target.value)}
          helperText="Questions and official answers stay in English — this is only for extra explanations, so it's easier to understand why an answer is correct."
          fullWidth
          slotProps={{
            select: { native: true },
            inputLabel: { shrink: true },
          }}
        >
          {EXPLANATION_LANGUAGES.map((language) => (
            <option key={language.tag} value={language.tag}>
              {language.label}
            </option>
          ))}
        </TextField>

        {/* Anything that went wrong, in a region assistive technology
            announces. `role="alert"` rather than a polite region: the learner
            pressed Save and the answer is that it did not happen. */}
        {submitError && (
          <Alert severity="error" role="alert">
            {submitError}
          </Alert>
        )}

        {/* The validation summary is a SECOND announcement of the per-field
            messages above, not a replacement for them: a screen reader user who
            submits hears what is wrong without having to walk the form to find
            out. */}
        {Object.keys(fieldErrors).length > 0 && (
          <Alert severity="error" role="alert">
            <AlertTitle>Please check a couple of answers</AlertTitle>
            <Box component="ul" sx={{ pl: 2.5, m: 0 }}>
              {Object.values(fieldErrors).map((message) => (
                <li key={message}>{message}</li>
              ))}
            </Box>
          </Alert>
        )}

        {/* Only when nothing else is handling the hand-off. Orientation
            navigates away, so it never renders this. */}
        {saved && !onSaved && (
          <Alert severity="success" role="status">
            Saved. Your plan is up to date.
          </Alert>
        )}

        <Box>
          <Button
            type="submit"
            variant="contained"
            size="large"
            disabled={isSaving}
            startIcon={
              isSaving ? <CircularProgress size={18} color="inherit" /> : null
            }
            fullWidth
            sx={{ maxWidth: { sm: 280 } }}
          >
            {isSaving ? 'Saving…' : submitLabel}
          </Button>
        </Box>
      </Stack>
    </Box>
  );
}

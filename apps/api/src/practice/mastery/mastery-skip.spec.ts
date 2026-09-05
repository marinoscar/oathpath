import { ASR_CONFIDENCE_THRESHOLD } from '../../ai/ai.types';
import {
  isMisheardAttempt,
  masterySkipReason,
  type MasteryEvidence,
} from './mastery-skip';

// =============================================================================
// mastery-skip.ts — tests (issue #245, epic #60 / E11)
// =============================================================================
//
// The rule two services now share. `practice.service.spec.ts` still exercises
// `isMisheardAttempt`'s three conditions directly and
// `interviews.service.spec.ts` proves the interview path honours the skip end
// to end; this file is the rule itself, as a table, and the one place the two
// refusals are shown to be distinct rather than a boolean wearing two names.
// =============================================================================

function evidence(overrides: Partial<MasteryEvidence> = {}): MasteryEvidence {
  return {
    answerResolution: 'resolved',
    outcome: 'incorrect',
    asrConfidence: null,
    ...overrides,
  };
}

describe('masterySkipReason', () => {
  it('schedules an ordinary graded attempt', () => {
    expect(masterySkipReason(evidence())).toBeNull();
    expect(masterySkipReason(evidence({ outcome: 'correct' }))).toBeNull();
    expect(masterySkipReason(evidence({ outcome: 'partial' }))).toBeNull();
  });

  it('refuses a state_required attempt, and says so by name', () => {
    // No accepted answers could be resolved, so the learner was not wrong —
    // the product could not resolve what right was. Scheduling it would lapse a
    // question's mastery for a system limitation.
    expect(
      masterySkipReason(evidence({ answerResolution: 'state_required' })),
    ).toBe('state_required');
  });

  it('refuses a misheard attempt, and says so by a DIFFERENT name', () => {
    expect(masterySkipReason(evidence({ asrConfidence: 0.4 }))).toBe('misheard');
  });

  it('reports state_required first when both apply', () => {
    // The stronger statement wins: there were no accepted answers at all, so
    // whether the transcript was trusted is a question about an answer nothing
    // could have graded either way.
    expect(
      masterySkipReason(
        evidence({ answerResolution: 'state_required', asrConfidence: 0.1 }),
      ),
    ).toBe('state_required');
  });

  it('schedules a low-confidence attempt that was CORRECT anyway', () => {
    // Condition 3. A right answer is right however it was heard, and
    // withholding the schedule would discard evidence the learner earned.
    expect(
      masterySkipReason(evidence({ outcome: 'correct', asrConfidence: 0.1 })),
    ).toBeNull();
  });

  it('schedules when no confidence was reported — unknown is not low', () => {
    // The condition most likely to be "simplified" into `(confidence ?? 0)`.
    // Several transcription models report no confidence at all, and collapsing
    // the two would stop those learners accumulating any mastery evidence,
    // silently.
    expect(masterySkipReason(evidence({ asrConfidence: null }))).toBeNull();
    expect(masterySkipReason(evidence({ asrConfidence: undefined }))).toBeNull();
    expect(masterySkipReason({ answerResolution: 'resolved', outcome: 'incorrect' })).toBeNull();
  });
});

describe('isMisheardAttempt', () => {
  it('trusts the threshold exactly, and distrusts below it', () => {
    // The boundary has to fall on one side, and trusting the transcript is the
    // side that cannot invent a mishearing that did not happen.
    expect(isMisheardAttempt(ASR_CONFIDENCE_THRESHOLD, 'incorrect')).toBe(false);
    expect(isMisheardAttempt(ASR_CONFIDENCE_THRESHOLD - 0.001, 'incorrect')).toBe(
      true,
    );
  });

  it('treats a reported zero as a real measurement, not as absence', () => {
    expect(isMisheardAttempt(0, 'incorrect')).toBe(true);
  });

  it('never fires on a correct outcome', () => {
    expect(isMisheardAttempt(0, 'correct')).toBe(false);
  });
});

describe('the threshold is not compiled into this module', () => {
  it('reads ASR_CONFIDENCE_THRESHOLD rather than a copy of its value', () => {
    // The same "read the source off disk" discipline the interview engine's own
    // spec applies to pass marks, for the same reason: a behavioural test
    // passes just as happily against `0.6` written out here, and the harm of a
    // second copy is that the two drift and a learner is told they were
    // misheard on one screen and wrong on another.
    const source: string = require('node:fs')
      .readFileSync(
        require('node:path').join(__dirname, 'mastery-skip.ts'),
        'utf8',
      )
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1');

    expect(source).toContain('ASR_CONFIDENCE_THRESHOLD');
    expect(source).not.toMatch(/0\.\d/);
  });
});

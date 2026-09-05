import {
  ASKED_LEDGER_MAX_ENTRIES,
  PracticeRealtimeAskedLedger,
} from './practice-realtime-asked';

// =============================================================================
// The asked ledger (issue #354, epic #345 / E15)
// =============================================================================
//
// The tests that matter here are the two failure modes, not the happy path: a
// map that remembers correctly is uninteresting, and a map that is ALLOWED to
// be wrong is only safe if both ways it can be wrong are the harmless ones its
// own header claims.
// =============================================================================

const SESSION = 'session-1';
const OTHER = 'session-2';

const Q1 = { questionId: 'question-1', prompt: 'Who is the Chief Justice?' };
const Q2 = { questionId: 'question-2', prompt: 'What is the supreme law?' };

/** Nothing has been answered in this session yet. */
const NONE: ReadonlySet<string> = new Set<string>();

describe('PracticeRealtimeAskedLedger', () => {
  let ledger: PracticeRealtimeAskedLedger;

  beforeEach(() => {
    ledger = new PracticeRealtimeAskedLedger();
  });

  it('returns the question it served, with the words it served', () => {
    // THE PROMPT IS THE POINT, not only the id: `repeat_question` says these
    // words again, and a fresh lookup could name a different question entirely
    // because the selector shuffles.
    ledger.record(SESSION, Q1);

    expect(ledger.outstanding(SESSION, NONE)).toEqual(Q1);
  });

  it('remembers nothing for a session it has never served', () => {
    // THE "IT FORGOT" MODE — a process restart, a second replica, a connection
    // re-minted after a drop. It reads as "nothing outstanding", so every tool
    // that needs a question in the air is refused with an instruction to call
    // `next_question`. One spoken turn is spent; nothing is recorded wrong.
    expect(ledger.outstanding(SESSION, NONE)).toBeNull();
  });

  it('drops a memory the session has already answered, without being told to', () => {
    // THE "IT REMEMBERS TOO MUCH" MODE — a duplicate that raced, or an attempt
    // recorded on another transport. Without this the session deadlocks:
    // `next_question` refused because an answer is outstanding, and
    // `grade_answer` refused as a duplicate, for ever.
    ledger.record(SESSION, Q1);

    const answered = new Set([Q1.questionId]);

    expect(ledger.outstanding(SESSION, answered)).toBeNull();
    // And it is really gone, not merely reported absent once.
    expect(ledger.outstanding(SESSION, NONE)).toBeNull();
  });

  it('keeps a memory that another question’s answer does not touch', () => {
    ledger.record(SESSION, Q2);

    expect(ledger.outstanding(SESSION, new Set([Q1.questionId]))).toEqual(Q2);
  });

  it('keeps sessions apart', () => {
    ledger.record(SESSION, Q1);
    ledger.record(OTHER, Q2);

    expect(ledger.outstanding(SESSION, NONE)).toEqual(Q1);
    expect(ledger.outstanding(OTHER, NONE)).toEqual(Q2);
  });

  it('forgets a session on demand', () => {
    ledger.record(SESSION, Q1);
    ledger.clear(SESSION);

    expect(ledger.outstanding(SESSION, NONE)).toBeNull();
  });

  it('overwrites rather than accumulating, one entry per session', () => {
    ledger.record(SESSION, Q1);
    ledger.record(SESSION, Q2);

    expect(ledger.size).toBe(1);
    expect(ledger.outstanding(SESSION, NONE)).toEqual(Q2);
  });

  it('never grows past its cap', () => {
    for (let index = 0; index < ASKED_LEDGER_MAX_ENTRIES + 50; index += 1) {
      ledger.record(`session-${index}`, {
        questionId: `question-${index}`,
        prompt: `Question ${index}?`,
      });
    }

    expect(ledger.size).toBe(ASKED_LEDGER_MAX_ENTRIES);
    // The oldest went; the newest stayed. An eviction is the "it forgot" mode,
    // which a session recovers from by being asked a question again.
    expect(ledger.outstanding('session-0', NONE)).toBeNull();
    expect(
      ledger.outstanding(`session-${ASKED_LEDGER_MAX_ENTRIES + 49}`, NONE),
    ).not.toBeNull();
  });

  it('re-serving a session keeps it from being evicted in front of idle ones', () => {
    // The ordering rule `record`'s `delete`-then-`set` exists for: a long
    // conversation must not be evicted because it STARTED before sessions that
    // have since gone quiet.
    ledger.record(SESSION, Q1);

    for (let index = 0; index < ASKED_LEDGER_MAX_ENTRIES - 1; index += 1) {
      ledger.record(`filler-${index}`, {
        questionId: `question-${index}`,
        prompt: `Question ${index}?`,
      });
    }

    // Touched again: it moves to the newest end.
    ledger.record(SESSION, Q2);
    ledger.record('one-more', { questionId: 'question-x', prompt: 'Last?' });

    expect(ledger.outstanding(SESSION, NONE)).toEqual(Q2);
    expect(ledger.outstanding('filler-0', NONE)).toBeNull();
  });
});

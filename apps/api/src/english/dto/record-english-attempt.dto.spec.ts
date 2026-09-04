import { MAX_RESPONSE_LENGTH } from '../../practice/answer-matching';
import { recordEnglishAttemptSchema } from './record-english-attempt.dto';
import { englishNextQuerySchema } from './english-sentence.dto';

// =============================================================================
// The English request DTOs — tests (issue #136, epic #59 / E10)
// =============================================================================
//
// What a client may say, and — more importantly — what it may not. The
// forbidden fields have a compile-time proof in the DTO itself, which catches
// a field being ADDED; these tests catch the other half, that a field a client
// sends today is actually refused at runtime rather than silently dropped.
// =============================================================================

const SENTENCE_ID = 'aaaaaaa1-1111-4111-8111-111111111111';

const VALID = {
  sentenceId: SENTENCE_ID,
  responseText: 'We pay taxes.',
};

describe('recordEnglishAttemptSchema', () => {
  it('accepts the minimal body and defaults replayCount to 0', () => {
    const parsed = recordEnglishAttemptSchema.parse(VALID);

    expect(parsed).toEqual({
      sentenceId: SENTENCE_ID,
      responseText: 'We pay taxes.',
      replayCount: 0,
    });
    // ABSENT, not null and not 0 — "the recogniser reported none" must survive
    // parsing as an absence, because the service's misheard gate reads
    // `undefined` as unknown and unknown is not low.
    expect(parsed).not.toHaveProperty('asrConfidence');
  });

  it('accepts an empty response — a blank submission is a real, scoreable attempt', () => {
    // It scores as every reference token deleted, `wer` of 1, `incorrect`.
    // Rejecting it here would mean the one thing a learner can always do —
    // give up on a sentence — is the one thing the API refuses to record.
    expect(
      recordEnglishAttemptSchema.parse({ ...VALID, responseText: '' })
        .responseText,
    ).toBe('');
  });

  // ---------------------------------------------------------------------------
  // The forbidden fields
  // ---------------------------------------------------------------------------

  it.each([
    ['outcome', 'correct'],
    ['wer', 0],
    ['diffOps', []],
    ['diff', []],
    ['errors', 0],
    ['userId', '22222222-2222-4222-8222-222222222222'],
    ['kind', 'reading'],
    ['answeredAt', '2026-09-04T12:00:00Z'],
    ['misheard', true],
  ])('rejects a body carrying %s', (field, value) => {
    const result = recordEnglishAttemptSchema.safeParse({
      ...VALID,
      [field]: value,
    });

    // A 400 NAMING the key, not a silent drop: a client that sent a verdict
    // should learn immediately that the server does not take one, rather than
    // believing its outcome was honoured.
    expect(result.success).toBe(false);
  });

  it('rejects any unknown key at all, not merely the named ones', () => {
    expect(
      recordEnglishAttemptSchema.safeParse({ ...VALID, somethingNew: 1 })
        .success,
    ).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // asrConfidence
  // ---------------------------------------------------------------------------

  it.each([-0.1, 1.1, 2])('rejects an out-of-range asrConfidence: %s', (value) => {
    expect(
      recordEnglishAttemptSchema.safeParse({ ...VALID, asrConfidence: value })
        .success,
    ).toBe(false);
  });

  it.each([0, 0.5, 1])('accepts an in-range asrConfidence: %s', (value) => {
    expect(
      recordEnglishAttemptSchema.safeParse({ ...VALID, asrConfidence: value })
        .success,
    ).toBe(true);
  });

  it('does NOT reject asrConfidence on shape alone — the kind check is the service’s', () => {
    // The body cannot know the segment: `kind` lives on the sentence row, and
    // a client-supplied one is a forbidden field (see above). So "confidence
    // on a writing attempt" is a 400 raised in `EnglishService.recordAttempt`
    // after the sentence is loaded, not here — asserted in this file so the
    // division of labour is stated where a reader looking for the rule would
    // first look.
    expect(
      recordEnglishAttemptSchema.safeParse({ ...VALID, asrConfidence: 0.9 })
        .success,
    ).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // replayCount and responseText bounds
  // ---------------------------------------------------------------------------

  it.each([-1, 1.5])('rejects a replayCount that is not a non-negative integer: %s', (value) => {
    expect(
      recordEnglishAttemptSchema.safeParse({ ...VALID, replayCount: value })
        .success,
    ).toBe(false);
  });

  it('accepts a large replayCount — nothing is gated on it and no limit is enforced', () => {
    // §4: penalising replays would punish exactly the honest,
    // information-seeking behaviour the product should want.
    expect(
      recordEnglishAttemptSchema.safeParse({ ...VALID, replayCount: 99 })
        .success,
    ).toBe(true);
  });

  it('bounds responseText at the shared MAX_RESPONSE_LENGTH, imported not retyped', () => {
    expect(
      recordEnglishAttemptSchema.safeParse({
        ...VALID,
        responseText: 'x'.repeat(MAX_RESPONSE_LENGTH),
      }).success,
    ).toBe(true);

    expect(
      recordEnglishAttemptSchema.safeParse({
        ...VALID,
        responseText: 'x'.repeat(MAX_RESPONSE_LENGTH + 1),
      }).success,
    ).toBe(false);
  });

  it('requires a uuid sentenceId', () => {
    expect(
      recordEnglishAttemptSchema.safeParse({ ...VALID, sentenceId: 'nope' })
        .success,
    ).toBe(false);
  });
});

describe('englishNextQuerySchema', () => {
  it.each(['reading', 'writing'])('accepts kind=%s', (kind) => {
    expect(englishNextQuerySchema.parse({ kind })).toEqual({ kind });
  });

  it('requires kind — there is deliberately no default', () => {
    // Whichever default was chosen, a client that forgot the parameter would
    // silently practise the wrong skill and record evidence under the wrong
    // `kind`. The two banks are validated against two different USCIS
    // vocabulary lists and are not interchangeable.
    expect(englishNextQuerySchema.safeParse({}).success).toBe(false);
  });

  it('rejects an unknown segment', () => {
    expect(englishNextQuerySchema.safeParse({ kind: 'speaking' }).success).toBe(
      false,
    );
  });

  it('rejects ?userId= rather than ignoring it', () => {
    // `z.strictObject`, so a user id in the query is a 400 naming the
    // parameter rather than something a later edit might start honouring.
    expect(
      englishNextQuerySchema.safeParse({
        kind: 'reading',
        userId: '22222222-2222-4222-8222-222222222222',
      }).success,
    ).toBe(false);
  });
});

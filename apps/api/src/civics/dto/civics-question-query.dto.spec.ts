import { civicsQuestionQuerySchema } from './civics-question-query.dto';

// =============================================================================
// civicsQuestionQuerySchema — tests (issue #111, epic #51)
// =============================================================================
//
// Two things worth asserting: that the pagination shape is the one
// `AllowlistController` already established (civics-content.md §8 requires
// exactly that, and a drifted default is invisible until a client paginates),
// and that the parameters which would BREAK the resolution contract are
// rejected rather than ignored.
// =============================================================================

describe('civicsQuestionQuerySchema', () => {
  describe('pagination, borrowed unchanged from the allowlist', () => {
    it('defaults to page 1 and pageSize 20', () => {
      expect(civicsQuestionQuerySchema.parse({})).toMatchObject({
        page: 1,
        pageSize: 20,
      });
    });

    it('coerces the strings a query string actually delivers', () => {
      expect(civicsQuestionQuerySchema.parse({ page: '3', pageSize: '50' })).toMatchObject({
        page: 3,
        pageSize: 50,
      });
    });

    it.each([
      ['a zero page', { page: '0' }],
      ['a negative page', { page: '-1' }],
      ['a fractional page', { page: '1.5' }],
      ['a zero pageSize', { pageSize: '0' }],
      ['a pageSize past the 100 cap', { pageSize: '101' }],
    ])('rejects %s', (_label, input) => {
      expect(() => civicsQuestionQuerySchema.parse(input)).toThrow();
    });
  });

  describe('filters', () => {
    it('leaves testVersionCode absent rather than defaulting it in the schema', () => {
      // The fallback is the CALLER'S OWN profile, which the schema cannot see.
      // Defaulting here would pin every caller to one version.
      expect(civicsQuestionQuerySchema.parse({}).testVersionCode).toBeUndefined();
    });

    it('accepts a category id as a uuid', () => {
      const id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
      expect(civicsQuestionQuerySchema.parse({ categoryId: id }).categoryId).toBe(id);
    });

    it('rejects a categoryId that is not a uuid', () => {
      expect(() => civicsQuestionQuerySchema.parse({ categoryId: 'not-a-uuid' })).toThrow();
    });

    it.each([
      ['true', true],
      ['false', false],
    ])('coerces seniorEligible=%s from the query string', (input, expected) => {
      expect(civicsQuestionQuerySchema.parse({ seniorEligible: input }).seniorEligible).toBe(
        expected,
      );
    });

    it('leaves seniorEligible undefined when it was not asked for', () => {
      // Distinct from `false`. `undefined` means "no filter"; `false` means
      // "only the questions a senior applicant is NOT asked".
      expect(civicsQuestionQuerySchema.parse({}).seniorEligible).toBeUndefined();
    });
  });

  describe('the parameters that must not exist', () => {
    it.each([
      ['a state code', { stateCode: 'TX' }],
      ['a user id', { userId: '11111111-1111-4111-8111-111111111111' }],
      ['a senior exemption override', { seniorExemption: 'true' }],
    ])('rejects %s outright instead of ignoring it', (_label, input) => {
      // A silently ignored `?stateCode=TX` is worse than a 400: a client
      // written against a misremembered contract would quietly serve Texas's
      // governor to a learner in Ohio, and nothing would say so.
      expect(() => civicsQuestionQuerySchema.parse(input)).toThrow();
    });
  });
});

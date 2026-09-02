import { Prisma, CivicsDynamicScope } from '@prisma/client';

/**
 * Schema-contract tests for the civics content tables added by issue #97
 * (civics_categories / civics_questions / civics_answers).
 *
 * These read the generated Prisma Client's static DMMF — no database
 * connection, no mocked Prisma delegate calls, nothing that could pass
 * without the migration actually having been generated correctly. They
 * exist to catch exactly the regression this codebase's other registries
 * warn about elsewhere (`ai-model-roles.ts`, `notification-events.ts`): a
 * silent rename of a persisted column or enum value that breaks every
 * existing row without a compiler or runtime error anywhere near the change.
 *
 * What this file DELIBERATELY DOES NOT ASSERT: uniqueness, foreign-key
 * cascade/restrict behavior, or the hand-written partial unique index
 * (`civics_answers_open_slot_unique`). None of that is something a mocked
 * Prisma client can meaningfully verify — `jest-mock-extended`'s mock never
 * runs SQL, so a test that "asserts" a duplicate insert is rejected would
 * only be asserting that a jest mock function returns whatever the test
 * told it to return. Per this repo's testing rules (`docs/TESTING.md`: API
 * tests never touch a database), that proof was instead run directly
 * against a live Postgres via psql — see the PR description for the exact
 * commands and their output.
 */
describe('civics content schema (Prisma DMMF contract)', () => {
  const models = Prisma.dmmf.datamodel.models;
  const byName = Object.fromEntries(models.map((m) => [m.name, m]));

  function field(modelName: string, fieldName: string) {
    const model = byName[modelName];
    expect(model).toBeDefined();
    const f = model.fields.find((x) => x.name === fieldName);
    expect(f).toBeDefined();
    return f!;
  }

  it('declares CivicsDynamicScope as exactly none | national | state', () => {
    // The generated client exports each Postgres enum as a const object
    // (`{ none: 'none', national: 'national', state: 'state' }`), not as an
    // entry in the client-side DMMF (which no longer carries enum value
    // lists in this Prisma version) — so this is the real generated shape to
    // pin, and a renamed or reordered value fails this test the same way it
    // would silently orphan every stored row.
    expect(Object.keys(CivicsDynamicScope)).toEqual([
      'none',
      'national',
      'state',
    ]);
    expect(CivicsDynamicScope.none).toBe('none');
    expect(CivicsDynamicScope.national).toBe('national');
    expect(CivicsDynamicScope.state).toBe('state');
  });

  it('maps CivicsCategory to civics_categories with its documented columns', () => {
    expect(byName['CivicsCategory'].dbName).toBe('civics_categories');

    expect(field('CivicsCategory', 'testVersionCode').dbName).toBe(
      'test_version_code',
    );
    expect(field('CivicsCategory', 'sortOrder').dbName).toBe('sort_order');
    expect(field('CivicsCategory', 'createdAt').dbName).toBe('created_at');
    expect(field('CivicsCategory', 'updatedAt').dbName).toBe('updated_at');
  });

  it('maps CivicsQuestion to civics_questions with its documented columns', () => {
    expect(byName['CivicsQuestion'].dbName).toBe('civics_questions');

    expect(field('CivicsQuestion', 'testVersionCode').dbName).toBe(
      'test_version_code',
    );
    expect(field('CivicsQuestion', 'categoryId').dbName).toBe('category_id');
    expect(field('CivicsQuestion', 'seniorEligible').dbName).toBe(
      'senior_eligible',
    );
    expect(field('CivicsQuestion', 'dynamicScope').dbName).toBe(
      'dynamic_scope',
    );
    expect(field('CivicsQuestion', 'dynamicScope').type).toBe(
      'CivicsDynamicScope',
    );

    // `number` carries no @map — it is a bare column, and this pins that so
    // a future edit adding one would be a deliberate, reviewed migration.
    expect(field('CivicsQuestion', 'number').dbName).toBeUndefined();
  });

  it('maps CivicsAnswer to civics_answers with its documented columns', () => {
    expect(byName['CivicsAnswer'].dbName).toBe('civics_answers');

    expect(field('CivicsAnswer', 'questionId').dbName).toBe('question_id');
    expect(field('CivicsAnswer', 'stateCode').dbName).toBe('state_code');
    expect(field('CivicsAnswer', 'verifiedAt').dbName).toBe('verified_at');
    expect(field('CivicsAnswer', 'effectiveFrom').dbName).toBe(
      'effective_from',
    );
    expect(field('CivicsAnswer', 'effectiveTo').dbName).toBe('effective_to');
    expect(field('CivicsAnswer', 'sourceNote').dbName).toBe('source_note');

    // `text` and `sort` are the two legs (alongside `state_code`, folded via
    // COALESCE) of the hand-written partial unique index — pinned here so a
    // rename of either is caught next to the columns it would silently break
    // the migration's raw SQL against.
    expect(field('CivicsAnswer', 'text').dbName).toBeUndefined();
    expect(field('CivicsAnswer', 'sort').dbName).toBeUndefined();
  });

  it('wires the three tables together with the documented relations', () => {
    expect(field('CivicsCategory', 'testVersion').type).toBe(
      'CivicsTestVersion',
    );
    expect(field('CivicsQuestion', 'testVersion').type).toBe(
      'CivicsTestVersion',
    );
    expect(field('CivicsQuestion', 'category').type).toBe('CivicsCategory');
    expect(field('CivicsAnswer', 'question').type).toBe('CivicsQuestion');
  });
});

// =============================================================================
// Self-service account data reset — shared constants (issue #270)
// =============================================================================
//
// Two things live here, and both are shared between `AccountResetService`
// AND `account-reset.service.spec.ts` for the same reason
// `notification-events.ts` is a single array both the dispatcher and the
// preferences page read: a list duplicated between the implementation and
// its test is a list that can drift, and a test asserting "the service
// deletes these tables" against a SECOND, independently-typed copy of the
// same thirteen strings would only ever catch itself disagreeing with
// itself, never a real omission.
// =============================================================================

/**
 * The two destructive scopes this feature offers, and the exact phrase a
 * caller must type back to invoke each one.
 *
 * -----------------------------------------------------------------------------
 * WHY A TYPED PHRASE, NOT A CHECKBOX
 * -----------------------------------------------------------------------------
 *
 * A checkbox ("I understand this cannot be undone") records that a click
 * happened, not that the person read what they were clicking. Both scopes
 * here are irreversible and total — there is no "restore" button anywhere in
 * this codebase for a learner's own history — so the confirmation step is
 * the ONLY thing standing between an idle click and years of practice
 * attempts, readiness snapshots and interview history disappearing. Typing
 * `DELETE MY DATA` verbatim is friction with a purpose: it forces the caller
 * to actually read the word "DELETE" immediately before it happens.
 *
 * `data_and_key` gets its OWN, more severe phrase rather than reusing
 * `data`'s with a second checkbox, because the two scopes are not "the same
 * action plus an extra". Losing a stored AI key is a different KIND of loss
 * (a credential the learner will have to re-enter from OpenAI, not learning
 * history that no longer exists to lose) and deserves its own explicit
 * acknowledgement rather than riding along on the data phrase.
 *
 * -----------------------------------------------------------------------------
 * WHY THE PHRASE IS VERIFIED SERVER-SIDE, NOT ONLY BY A DISABLED BUTTON
 * -----------------------------------------------------------------------------
 *
 * A web form that merely disables its submit button until the typed text
 * matches is a UI convenience, not a control — nothing stops a direct
 * `POST /api/account/reset` with a guessed or empty `confirmationPhrase`
 * from a script, a replayed request, or a client the web team never wrote.
 * `AccountResetService.reset` re-checks the phrase itself, case-sensitively,
 * against THIS constant, before a single row is touched (see that method's
 * own comment for why the check runs first and unconditionally). The web's
 * disabled button and the server's check enforce the same rule for two
 * different reasons — one is UX, the other is the actual gate — and only one
 * of them is optional.
 */
export const ACCOUNT_RESET_PHRASES = {
  /** Erase practice/journey/AI-usage history. The stored AI key is kept. */
  data: 'DELETE MY DATA',
  /** Everything `data` erases, plus the caller's own stored AI key. */
  data_and_key: 'DELETE EVERYTHING',
} as const;

/** Which of the two destructive scopes a reset request names. */
export type AccountResetScope = keyof typeof ACCOUNT_RESET_PHRASES;

/**
 * One table this feature deletes the caller's rows from.
 *
 * `model` is the Prisma Client accessor (`prisma.<model>`), used to drive the
 * delete generically rather than as thirteen hand-written `deleteMany` calls
 * that could silently fall out of order. `table` is the snake_case name the
 * *database* uses, which is what a human reads in an audit row's `meta` and
 * in `AccountDataSummaryDto` — a caller of `GET /api/account/data-summary`
 * has no reason to know Prisma's camelCase accessor names, and freezing the
 * two apart means renaming a Prisma model later does not silently rename
 * what an old audit row's `meta` keys mean.
 */
export interface AccountResetTableEntry {
  /** The Prisma Client model accessor, e.g. `'practiceAttempt'`. */
  readonly model: string;
  /** The underlying Postgres table, e.g. `'practice_attempts'`. */
  readonly table: string;
}

/**
 * Every table `AccountResetService` deletes the caller's rows from, IN THE
 * ORDER IT DELETES THEM.
 *
 * -----------------------------------------------------------------------------
 * ORDER IS NOT COSMETIC — IT IS WHAT KEEPS `PracticeAttempt`'S CROSS-LINKS
 * FROM FIRING
 * -----------------------------------------------------------------------------
 *
 * `practice_attempts` carries three nullable FKs with `onDelete: SetNull`
 * (`sessionId` -> `practice_sessions`, `mockInterviewId` -> `mock_interviews`,
 * `aiUsageEventId` -> `ai_usage_events`) plus a self-referential one
 * (`retryOfAttemptId`). Every one of those exists precisely so that deleting
 * the PARENT never deletes the EVIDENCE — see `PracticeAttempt`'s own schema
 * comments ("evidence must outlive its bookkeeping"). That guarantee is
 * exactly backwards for THIS feature: a reset is supposed to erase the
 * evidence, not leave orphaned, nulled-out attempt rows behind once their
 * parents are gone. Deleting `practiceAttempt` FIRST — before
 * `mockInterview`, `practiceSession`, and `aiUsageEvent` — means those
 * `SetNull` triggers have nothing left to null out by the time their parent
 * rows are removed: children are gone before parents, so the parent-delete
 * path is never exercised at all on this user's data.
 *
 * `mockInterview` deletion CASCADES `mock_interview_turns` automatically
 * (`MockInterviewTurn.mockInterview` is `onDelete: Cascade`) — there is
 * deliberately no separate entry for it below, matching how
 * `storage_object_chunks` is not counted or deleted separately from
 * `storage_objects` either (see `AccountResetService.summarize`'s own
 * comment).
 *
 * `userSettings` and `learnerProfile` are deliberately LAST: both are
 * lazily recreated at their defaults the next time they are read
 * (`UserSettingsService.getSettings`, `JourneyService`'s own
 * `upsert({ create: { userId }, update: {} })`), so deleting the row IS the
 * reset for each — nothing here writes a fresh default row back, and
 * nothing downstream depends on either existing mid-transaction.
 *
 * STORAGE OBJECTS ARE NOT IN THIS LIST. `storage_objects` (and the blobs
 * they name) are deleted separately, OUTSIDE this transaction, by
 * `AccountResetService.reset` calling `ObjectsService.delete` per object —
 * see that method's own comment for why blob deletion cannot live inside a
 * database transaction.
 */
export const ACCOUNT_RESET_TABLES: readonly AccountResetTableEntry[] = [
  { model: 'practiceAttempt', table: 'practice_attempts' },
  { model: 'mockInterview', table: 'mock_interviews' },
  { model: 'practiceSession', table: 'practice_sessions' },
  { model: 'questionMastery', table: 'question_mastery' },
  { model: 'readinessSnapshot', table: 'readiness_snapshots' },
  { model: 'dailyActivity', table: 'daily_activity' },
  { model: 'englishAttempt', table: 'english_attempts' },
  { model: 'aiUsageEvent', table: 'ai_usage_events' },
  { model: 'notification', table: 'notifications' },
  { model: 'notificationDelivery', table: 'notification_deliveries' },
  { model: 'personalAccessToken', table: 'personal_access_tokens' },
  { model: 'deviceCode', table: 'device_codes' },
  { model: 'learnerProfile', table: 'learner_profiles' },
  { model: 'userSettings', table: 'user_settings' },
];

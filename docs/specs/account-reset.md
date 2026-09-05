# Design Spec: Self-service account data reset (issue #270)

This is the durable design for the "Danger zone" — the one place in OathPath a
learner can erase their own accumulated data, optionally including their own
stored AI key, without anyone else's involvement. An epic or issue that
touches `apps/api/src/account/` or the `/settings/reset` destination links
here instead of restating the design.

Source of truth for every claim below:

- `apps/api/src/account/account-reset.constants.ts` — `ACCOUNT_RESET_PHRASES`,
  `ACCOUNT_RESET_TABLES` and the ordering argument on the latter.
- `apps/api/src/account/account-reset.service.ts` — the full six-step
  `summarize`/`reset` sequence, including the module-header comment on why
  `refresh_tokens` and `audit_events` are absent from the delete list.
- `apps/api/src/account/account.controller.ts` — the route contract and its
  own "no route accepts a user id" argument.
- `apps/api/src/account/dto/*.ts` — the three DTOs, each with its own
  compile-time or structural proof.
- `apps/api/src/ai/ai-user-key.service.ts`'s `purgeForDeletedUser` — now takes
  a `reason: 'account_deleted' | 'account_reset'`, and its own comment on why
  this stayed one method rather than growing a near-duplicate.
- `apps/api/src/notifications/notification-events.ts`'s `account.data_reset`
  entry — the `mandatory: true` reasoning and the ordering hazard it
  sidesteps.
- `apps/api/src/email/templates/account-data-reset.email.ts` — the "no
  actor named" and "no before/after table" copy decisions.
- `apps/api/src/openapi/tags.ts`'s `Account` tag entry.
- `apps/web/src/config/userSettingsSections.tsx`'s `Danger zone` group.
- `apps/web/src/pages/UserDataResetPage.tsx` and
  `apps/web/src/components/settings/ResetAccountDialog.tsx` — the
  refresh-before-navigate ordering and the server-sourced phrase.
- `apps/web/src/hooks/useAccountReset.ts` — the two-independent-requests
  shape.
- `docs/specs/ai-settings.md` — the "API owns the registry, the web reads it
  over an endpoint" pattern this design reuses for the confirmation phrase
  (§3 below), and the credential-address discussion this design's AI-key
  purge builds on (§4.1 of that document).
- `CLAUDE.md`'s Settings UI Pattern — the registry-card-plus-route rule this
  design follows for `/settings/reset`, and the reachability-vs-content
  distinction that keeps this off `AiKeyForm`'s tabs.

---

## 1. The problem

Every per-learner table in this application accumulates for the life of the
account — `practice_attempts`, `question_mastery`, `readiness_snapshots`,
`daily_activity`, `mock_interviews`, `english_attempts`, `learner_profiles` —
and until this feature, nothing in `apps/api` erased any of it. The only
destructive control anywhere in the product was `DELETE /api/ai/key`, and
that removes a credential, not data.

That is a real gap, not a hypothetical one: a learner who has been practising
for weeks against the wrong test version or the wrong state, or who shares a
household account, or who simply wants a clean baseline before their real
study period starts, has no way to clear the history the readiness engine,
the mastery scheduler and the streak counter all keep grading them against.
Their only recourse before this feature was asking an operator to run SQL by
hand — which this design deliberately does not build a UI for either (see
§9's exclusions).

There was also a latent, already-documented gap this feature closes in
passing: `AiUserKeyService.purgeForDeletedUser` existed, was written and
commented as the correct hook for a future account-teardown path, and had
**no caller anywhere in the codebase** (`docs/specs/ai-settings.md` §4.1
calls this out explicitly — "nothing calls this today, and that was the
point," backstopped only by the nightly `AiUserCredentialCleanupTask` sweep).
This feature is that method's first real, reviewed call site.

## 2. The two scopes

`ACCOUNT_RESET_PHRASES` (`account-reset.constants.ts`) declares exactly two
destructive scopes, each with its own typed confirmation phrase:

| Scope | Phrase | What it does |
|---|---|---|
| `data` | `DELETE MY DATA` | Erases every table in §2.1 below. The caller's stored AI key is kept. |
| `data_and_key` | `DELETE EVERYTHING` | Everything `data` does, plus the caller's own stored OpenAI key (`purgeForDeletedUser`). |

Neither scope touches the `users` row, its OAuth identity
(`user_identities`), its role assignments, or its `refresh_tokens` — see §5.

### 2.1 The table list, verbatim, in delete order

`ACCOUNT_RESET_TABLES`, reproduced exactly as declared (Prisma model
accessor → underlying table), in the order `AccountResetService.reset`
deletes them:

1. `practiceAttempt` → `practice_attempts`
2. `mockInterview` → `mock_interviews`
3. `practiceSession` → `practice_sessions`
4. `questionMastery` → `question_mastery`
5. `readinessSnapshot` → `readiness_snapshots`
6. `dailyActivity` → `daily_activity`
7. `englishAttempt` → `english_attempts`
8. `aiUsageEvent` → `ai_usage_events`
9. `notification` → `notifications`
10. `notificationDelivery` → `notification_deliveries`
11. `personalAccessToken` → `personal_access_tokens`
12. `deviceCode` → `device_codes`
13. `learnerProfile` → `learner_profiles`
14. `userSettings` → `user_settings`

Two tables are deliberately **not** in this list because they cascade or are
handled through a separate path, not because they survive a reset:

- `mock_interview_turns` cascades automatically when its parent
  `mock_interviews` row is deleted (`MockInterviewTurn.mockInterview` is
  `onDelete: Cascade`), the same way `storage_object_chunks` cascades from
  `storage_objects` rather than being counted or deleted on its own.
- `storage_objects` (and the blobs they name) are deleted through
  `ObjectsService.delete`, outside the `$transaction` that deletes the
  fourteen tables above — see §6.

`AccountDataSummaryDto.counts` and `AccountResetResultDto.deleted` both key
by the `table` string above, plus a fifteenth key, `storage_objects`, added
by `AccountResetService` itself for the objects deleted outside the
transaction.

`data_and_key` adds one more destructive action outside this list entirely:
purging the credential at `('ai-user', <userId>)` — see §7.

## 3. Why the phrase is server-issued, and re-verified server-side

Two separable decisions, both stated in `ACCOUNT_RESET_PHRASES`'s own header
comment:

**Why a typed phrase at all, not a checkbox.** A checkbox ("I understand this
cannot be undone") records that a click happened, not that the person read
what they were clicking. Both scopes are irreversible and total — there is no
"restore" button anywhere in this codebase for a learner's own history — so
the confirmation step is the only thing standing between an idle click and
years of practice attempts, readiness snapshots and interview history
disappearing. `data_and_key` gets its **own**, more severe phrase rather than
reusing `data`'s with a second checkbox, because losing a stored AI key is a
different *kind* of loss (a credential the learner re-enters from OpenAI, not
learning history that no longer exists to lose) and deserves its own explicit
acknowledgement rather than riding along on the data phrase.

**Why the phrase is served by the API and re-verified server-side, rather
than duplicated as a web constant.** This mirrors the same choice
`notification-events.ts` documents at length for the notification registry
(`docs/specs/ai-settings.md` cites it too, as "option 1 of the three
`notification-events.ts` weighs"): a value that a security check compares
against must have exactly one declaration, or the two copies can drift. Here
the concrete failure mode is sharper than a stale label — a web-hardcoded
`'DELETE MY DATA'` would silently disable the dialog's only real gate the
day either phrase changed server-side (the button stays disabled forever, or
worse, accepts the *wrong* phrase and lets the server's 400 be the only
thing standing in the way). So `GET /api/account/data-summary` echoes
`ACCOUNT_RESET_PHRASES` back verbatim as `phrases`, and
`ResetAccountDialog` renders exactly the string the server will check,
sourced from the one place that check reads from.

A web form that merely disables its submit button until the typed text
matches is a UI convenience, not a control — nothing stops a direct
`POST /api/account/reset` with a guessed or empty `confirmationPhrase` from a
script, a replayed request, or a client the web team never wrote.
`AccountResetService.reset` re-checks the phrase itself, `.trim()`-only and
case-sensitively, against `ACCOUNT_RESET_PHRASES`, **before a single row is
touched** — step 1 of the six-step sequence in §4, and unconditional: nothing
below it runs on a mismatch. Case-sensitivity is deliberate too: the whole
point of a typed phrase is that it proves the caller read and reproduced the
exact word "DELETE", and a comparison that forgave a wrong case would prove
something weaker than that.

Two different layers enforce two different things, on purpose:
`resetAccountSchema` (Zod) validates the **shape** — a real scope, a
non-empty string — and `AccountResetService.reset` validates the **content**.
The content check is not folded into the DTO because it is a security
control, and belongs next to the comparison it protects, not in the
transport layer.

## 4. The delete sequence, and why the order is load-bearing

`AccountResetService.reset` runs six steps, in this exact order:

1. Verify the confirmation phrase. Nothing below runs on a mismatch.
2. Delete storage objects — network I/O, outside any transaction (§6).
3. Delete every `ACCOUNT_RESET_TABLES` row, in one DB transaction, in the
   order §2.1 lists them.
4. On `data_and_key` only, purge the caller's stored AI key (§7).
5. Write the audit event — **after** destruction, not before or during (§8).
6. Notify the caller by email (§9).

### 4.1 Why `practiceAttempt` deletes first

`practice_attempts` carries three nullable FKs with `onDelete: SetNull`
(`sessionId` → `practice_sessions`, `mockInterviewId` → `mock_interviews`,
`aiUsageEventId` → `ai_usage_events`) plus a self-referential one
(`retryOfAttemptId`). Every one of those exists so that deleting the
**parent** never deletes the **evidence** — `PracticeAttempt`'s own schema
comments call this "evidence must outlive its bookkeeping." That guarantee
is exactly backwards for this feature: a reset is supposed to erase the
evidence, not leave orphaned, nulled-out attempt rows behind once their
parents are gone.

Deleting `practiceAttempt` **first** — before `mockInterview`,
`practiceSession`, and `aiUsageEvent` — means those `SetNull` triggers have
nothing left to null out by the time their parent rows are removed:
children are gone before parents, so the parent-delete path that
`SetNull` exists to protect is never exercised at all on this user's data.
Reordering the list (or adding a fifteenth table without checking where it
sits relative to its own FKs) is the one change to this constant that would
silently defeat that guarantee.

### 4.2 `userSettings` and `learnerProfile` are deliberately last

Both are lazily recreated at their defaults the next time they are read
(`UserSettingsService.getSettings`; `JourneyService`'s own
`upsert({ create: { userId }, update: {} })`), so deleting the row **is**
the reset for each — nothing in `reset` writes a fresh default row back, and
nothing else in the transaction depends on either existing mid-transaction.

### 4.3 The 30-second transaction timeout

The default interactive-transaction timeout (5s) is sized for ordinary
request handlers, not for a caller with years of practice history across
fourteen tables. `AccountResetService.reset` passes `{ timeout: 30_000 }` —
generous headroom for the slowest realistic account, without leaving a
runaway transaction open indefinitely if something is genuinely wrong.

## 5. What is deliberately retained, and why

The service module header states the case for each explicitly; this is not
an oversight list, it is the boundary that makes this "a data reset, not an
account deletion."

**`refresh_tokens` — session state, not data.** This feature is scoped to
what a learner has *built* — practice history, readiness, interview
transcripts, settings — not to what devices they happen to be signed in on
right now. Deleting `refresh_tokens` here would silently sign the caller
(and every other device they are signed in on) out as a *side effect* of a
data reset, which is a materially different, separately-named action this
codebase already has (`POST /api/auth/logout-all`) and which a caller did
not ask for by typing "DELETE MY DATA". A learner finishing a reset should
land right back on their own dashboard, not be bounced to the sign-in
screen.

**`audit_events` — the operator's record, not the user's own data.** The
identical distinction `NotificationDelivery`'s own schema comment draws
against `Notification`, applied here: an operator table that must outlive
the account it describes, never shown to the user it is about. Deleting it
here would be self-defeating in the most literal sense — this very method
writes an `account:reset` row to that table as its own accountability
record (step 5 of §4), so a reset that could erase its own audit trail
would let a caller destroy the evidence that a destructive action ever
happened, defeating the reason `audit_events` exists at all. It would also
erase the history of every *other* admin action ever taken on this account
(role changes, deactivations), which belongs to the administrators who
performed them, not to a self-service delete button. `audit_events` is
retained by design — `actorUserId` is `onDelete: SetNull` — and this
feature appends to it, never prunes it.

**The `users` row, its OAuth identity, and its role assignments.** The
account itself, its sign-in, its roles, and its email address are untouched
by either scope. That is a deliberate, narrower promise than "delete my
account" would make — see §9 for what an actual account-deletion feature
would additionally need to decide (consent, allowlist implications) and why
that is explicitly out of scope here.

## 6. Why storage-object deletion runs outside the transaction

Deleting a blob is a call to the storage provider (S3 today) — real network
I/O with its own latency and its own failure modes, and Postgres
transactions must not wrap around either. Holding a database transaction
open across a network round trip holds row locks for as long as that call
takes, and a provider hiccup would turn "the reset is a little slow" into
"the reset is blocking anyone reading the tables this transaction touches,
for however long S3 takes to time out."

`AccountResetService.reset` therefore deletes storage objects **first**,
step 2, one at a time, before the `$transaction` in step 3 ever opens. It
calls `ObjectsService.delete` — never a direct
`prisma.storageObject.deleteMany` — deliberately: `ObjectsService.delete`
is what actually removes the blob and its `storage_object_chunks` rows from
the storage provider, not merely the metadata. A raw `deleteMany` would
delete the row and leave every uploaded file behind forever, unreachable
and still billed. It is called with `canDeleteAny` left at its default
`false`: the caller is deleting their **own** objects, the ordinary
self-delete path that method already serves, not the cross-user admin
override (`storage:delete_any`, see `CLAUDE.md`'s RBAC Model section).

## 7. Why the AI-key purge reuses `purgeForDeletedUser` rather than a new path

`AiUserKeyService.purgeForDeletedUser(userId, reason)` was originally
written for a user-*deletion* path this application still does not have
(`docs/specs/ai-settings.md` §4.1). It had exactly one job — delete the
credential at `('ai-user', <userId>)`, idempotently, then write an
`ai_key:delete` audit row — and no caller.

`AccountResetService.reset`'s `data_and_key` branch calls this same method
on a **live, still-active account** that chose to erase its own data and
key, rather than a deletion path. The mechanics are identical either way:
the row lives at the same address, keyed by the string `userId`, and "gone"
means the same thing whether the account survives the call or not. So this
stayed **one method with a `reason` parameter**
(`'account_deleted' | 'account_reset'`, defaulting to `'account_deleted'`
so the one pre-existing, still-theoretical caller's behavior is unchanged)
rather than growing a near-duplicate `purgeForResetUser`. Only the audit
trail needs to tell the two callers apart — `reason` changes nothing about
what is deleted or how, and is recorded in the `ai_key:delete` audit row's
`meta` only.

This is a small instance of a larger rule this codebase already states for
"Adding an AI feature" in `CLAUDE.md`: reuse the one door rather than
opening a second one that can drift from it.

## 8. The audit-after-destruction ordering, and what it follows

`AccountResetService.reset` writes its `account:reset` audit row **after**
every deletion has actually run — after the storage-object sweep, after the
fourteen-table transaction commits, and after the conditional AI-key purge.
This is the identical ordering `AiUserKeyService.purgeForDeletedUser`'s own
comment states for a single credential, applied one level up: "an unaudited
deletion is a smaller problem than a retained credential" generalizes here
to "an unaudited deletion is a smaller problem than a reset that only
half-happened while an audit row claims it fully did." Writing the audit
row first would risk exactly that — a row asserting rows were deleted
moments before the transaction that deletes them runs, so a crash in
between would leave a lie in `audit_events`. Writing it last means the
audit row is only ever written for destruction that genuinely already
happened.

The audit write is **not** inside the `$transaction` from step 3 — it
already committed by the time step 5 runs, and `audit_events` has no FK to
any of the fourteen tables that transaction touches, so there is nothing for
a shared transaction to buy. This matches the pattern
`objects.service.ts`'s own `delete` and `UsersService.updateUserRoles` both
use: the audit write is a separate statement, after the state change it
describes has already landed.

The row itself: `actorUserId: userId`, `action: 'account:reset'`,
`targetType: 'user'`, `targetId: userId`, and a `meta` carrying `scope` plus
`deleted` — the same per-table counts (and `aiKeyRemoved`) the HTTP response
returns. **Counts and table names only, never a row's content** — the
identical "meta carries counts, never values" discipline
`AiUserKeyService.audit`'s own comment states for a credential action,
applied here to fourteen tables instead of one. See
`docs/SECURITY-ARCHITECTURE.md` §18 for the security-control framing of this
audit trail.

## 9. The `account.data_reset` notification

Declared in `NOTIFICATION_EVENTS` (`apps/api/src/notifications/
notification-events.ts`) as the one-registry entry the "Adding a
Notification" section of `CLAUDE.md` describes: `channels: ['email']`,
`defaultEnabled: true`, `mandatory: true`.

**Why email-only, and not browser too**, even though the browser channel
exists and `security.role_changed` already uses it: a browser notification
renders in the **same tab** that just finished the reset. Its reader has
just watched the confirmation screen report success; a bell badge repeating
that fact a second later, in the one tab already showing it, has no reader
who does not already know. Email is the only channel that reaches this
person somewhere *other* than the tab where the action happened — exactly
where a "did I really mean to do that, and did it actually happen" record
belongs.

**Why `mandatory: true`**, for two independent reasons stated on the
registry entry itself:

1. An irreversible destruction of every practice attempt, readiness
   snapshot, and interview a learner has built is a fact they must not be
   able to silence — the same class of "the user must always be told"
   event `security.role_changed` carries the flag for, applied to data loss
   instead of a privilege change.
2. It sidesteps an ordering hazard unique to this one event:
   `AccountResetService.reset` deletes `user_settings` — where a
   non-mandatory event's stored channel preference would live — *moments*
   before this notification dispatches (step 6 runs after step 3's
   transaction). A resolver that read stored preferences here would be
   reading a row the very call that triggers it just deleted, and would
   have to fall back to the registry default anyway. `mandatory` sidesteps
   the question entirely: resolution ignores stored preferences for a
   mandatory event, so there is no preference row to race against its own
   deletion.

The email template (`account-data-reset.email.ts`) is modeled on
`role-changed.email.ts` — the only other template whose event carries
`mandatory: true` — with two differences the content itself forces: there
is no before/after table (a data reset's "after" is "empty" for a dozen-odd
tables, so the template states in plain language what was erased and what
was kept), and the actor is not named, for a stronger reason than the role
template gives — `POST /api/account/reset` is `@Auth()` with no permissions
resolved entirely from `@CurrentUser('id')`, so "who did this" is almost
always "you, moments ago," and the one case this message actually needs to
alert on is the case where "you" is wrong (a compromised session acting
without the real owner's knowledge) — which is exactly the reader the
closing line ("If you did not do this, contact an administrator now") is
written for.

## 10. Excluded scope

Six items, named explicitly in issue #270's own "Exclusions" section so a
later reader does not treat their absence as an oversight:

- **Account deletion.** This resets data and keeps the account. Deleting
  the `users` row, its identity and its roles is a separate concern with
  its own consent and allowlist implications — a materially different
  feature, not a bigger scope on this one.
- **Undo, export, or a grace period.** The reset is immediate and
  irreversible by design; a "download your data first" flow is its own
  feature, not a checkbox on this one.
- **Admin-initiated reset of another user.** No route accepts a user id,
  deliberately (§5's boundary, §11 below). An operator-facing teardown is a
  different surface with a different threat model, and is not this
  feature widened.
- **Revoking the session.** `refresh_tokens` are deliberately not deleted —
  see §5. Personal access tokens and device codes *do* go (they are in
  `ACCOUNT_RESET_TABLES`), because a PAT is a long-lived credential the
  learner created and a pending device code could mint a fresh one after
  the wipe, but the refresh token that *is* the current login survives.
- **Pruning `audit_events`.** Retained by design — see §5. The reset
  appends to the log and never prunes it.
- **A post-reset receipt screen.** The counts are in the HTTP response and
  the audit row; the UI navigates to the re-armed gate (`/setup/journey` or
  `/setup/ai-key`) rather than showing a summary screen of what was erased.

## 11. No route accepts a user id — the security boundary

`account.controller.ts`'s own header states this at length, and it is
restated here because it is the property every other decision in this
document assumes: every method resolves the account from
`@CurrentUser('id')` and from nowhere else. There is no path parameter, no
query parameter and no body field naming a user — the same structural
discipline `ai-user-key.controller.ts` states for the caller's own AI key,
applied here to the caller's own data. Widening this to a "reset ANY user's
data" admin action is a signature change with a visible diff at every call
site it would need to touch, not a query-string edit.

An admin cannot reset another user's data through this controller either.
That is enforced by the same property, structurally: there is no permission
check to relax, because there is no parameter naming a target for a relaxed
check to admit. `@Auth()` carries **no permissions** for the same reason
every other caller-scoped module in this codebase (AI key, Journey,
Practice, Progress, Readiness, Engagement, Interviews, Voice, English) is
gated the same way: erasing your own data is not a privilege, it is what
owning the account already means, and gating it with an invented permission
string would leave some role unable to make a choice that is structurally
theirs alone.

# Design Spec: AI configuration (server bindings + per-user BYOK)

This is the durable design for AI configuration in OathPath: one
administrator-held OpenAI key used to populate a model catalog and prove
connectivity, a binding of each AI **model role** to a concrete model id, and a
**personal OpenAI key for every user** that all inference runs on. An epic and
its child issues link here instead of restating the design — read this first,
then the issue you were sent to implement.

Source of truth for every claim below:

- `apps/api/src/credentials/credentials.service.ts` — the `(purpose, name)`
  address, the blank-preserves contract, the two-methods-two-types no-egress
  rule, and `list(purpose)`'s scoping (which is the hazard in §4.2).
- `apps/api/src/credentials/interfaces/credential-info.interface.ts` — the
  compile-time proofs that a presentation type cannot carry secret material.
- `apps/api/src/credentials/credentials.module.ts` — why this module has no
  controller and is deliberately not `@Global()`.
- `apps/api/src/common/crypto/secret-cipher.ts` — AES-256-GCM, and
  `deriveKey(purpose)`, which is why two `purpose` values are two domains.
- `apps/api/src/common/crypto/encryption-key-startup-check.ts` — what happens
  at boot when `SECRETS_ENCRYPTION_KEY` is absent or has changed.
- `apps/api/src/email/email-settings.schema.ts` — the settings-row shape, the
  `provider: … | null` + `enabled` two-axis split, and the "carries no secret"
  proof this design copies twice.
- `apps/api/src/email/smtp-credential.constants.ts` — why credential addresses
  live in a leaf module that imports nothing.
- `apps/api/src/email/email-settings.service.ts` — the separate
  `system_settings` row, the two read paths (`get` throws, `describeForAdmin`
  reports), `If-Match`, and the credential-before-settings write order.
- `apps/api/src/email/base-email.provider.ts` — `BaseEmailProvider`'s
  never-throw implementation and `SecretRedactor`.
- `apps/api/src/email/email-settings.controller.ts` — the permission choice
  (`system_settings:*`, reused not invented) and why `test` is gated on write.
- `apps/api/src/email/email-test-send.service.ts` — the no-target-parameter
  rule and the single-funnel audit.
- `apps/api/src/email/dto/test-email-result.dto.ts` — why a failed test is
  HTTP 200.
- `apps/api/src/email/dto/update-email-settings.dto.ts` — why the write-only
  secret field carries no `.trim()`, no `.min(1)` and no `.default('')`.
- `apps/api/src/notifications/notification-events.ts` — the one-registry idiom,
  and its option-1 reasoning: the API owns the registry, the web reads it over
  an endpoint.
- `apps/api/src/common/constants/roles.constants.ts` — the complete permission
  set. There is no AI permission in it, and this design does not add one.
- `apps/api/src/common/decorators/trace.decorator.ts` — `@Trace()`, and why it
  is not sufficient for a never-throw provider.
- `apps/api/prisma/schema.prisma` — the `Credential` model (note the absence of
  a `User` foreign key, §4.1), and the `@db.Uuid` / `@map` / `@db.Timestamptz`
  conventions a new table follows.
- `apps/web/src/config/adminSections.tsx` — `SettingsCardDef`, including the
  `disabled` flag the unwired roles reuse. Four roles were unwired when this
  document was written; `transcribe` and `speak` wired since E9
  (`docs/specs/voice.md` §1) and `realtime` wired since E11
  (`docs/specs/realtime-interview.md` §1), so `embed` is the only role left
  rendering this way.
- `apps/web/src/config/userSettingsSections.tsx` — the no-`permission` rule for
  per-user cards, and the `Security` group's stated reasoning.
- `apps/web/src/pages/Admin/EmailSettingsPage.tsx` — the write-only secret
  field, the `testBlockedReason` ladder, and Alert-not-snackbar for a
  diagnosis.
- `apps/web/src/App.tsx` — `ProtectedRoute` and `RequirePermission`, the two
  gate shapes `RequireAiKey` composes with.
- `docs/runbooks/rotate-secrets-encryption-key.md` — the runbook whose blast
  radius this design materially widens.
- `CLAUDE.md` — the Settings UI Pattern (registry-declared destinations, the
  reachability-vs-content distinction, the five coupled `sm` breakpoint gates).
- `VISION.md` — the seven AI roles, the AI-personality section the onboarding
  copy is reviewed against, and the mobile-first requirement.

**Nothing described past this line exists yet.** There is no `apps/api/src/ai/`
directory, no `ai` settings row, no `ai_usage_events` table, no `openai`
dependency, no AI route in `App.tsx`, and no AI environment variable anywhere.
Every path in the list above resolves today; the only paths named below that do
not are the two this epic creates — `apps/api/src/ai/ai-credential.constants.ts`
(§3.1) and `apps/api/src/common/crypto/secret-redactor.ts` (§10, a destination
for an existing file, not a new implementation).
This document is what the epic and its 19 child issues build *against*, not a
description of code already in the repository. Every fact cited above about the
*existing* codebase has been verified against the files named; the *proposed*
architecture in every other section is a design, and a child issue is free to
find a better answer to a specific sub-problem as long as it keeps the
contracts this document promises to the pieces around it — the credential
addresses, the two-flag status shape, the never-throw provider, and the
no-user-id rule on every caller-scoped route.

---

## 1. Why more than one model

`VISION.md` names seven roles the AI companion must play. They do not collapse
onto one model, because they are not one API surface:

| Role slot | `VISION.md` role(s) | API surface | Profile |
|---|---|---|---|
| `tutor` | Teacher, Encourager, Progress Guide, Study Coach | Responses / Chat, streaming | medium volume |
| `grader` | **Evaluator** — semantic answer match, and *why* it failed | Chat + structured outputs | **highest volume, sub-second** |
| `realtime` | Interview Simulator, Practice Partner | Realtime speech-to-speech | session-length |
| `transcribe` | voice answers; ASR confidence feeds the "misheard" failure cause | Audio transcription | high |
| `speak` | "hear questions aloud" | Text to speech | high |
| `embed` | weak-area clustering, retrieval over versioned civics content | Embeddings | batch |

So the configuration surface is **one credential plus a role → model map**,
never a single "model" dropdown. The `grader` runs on every practice answer and
must be cheap and fast; the `tutor` must be strong. Binding both to one model is
either too expensive or too weak, immediately — and the failure is not visible
until it is a bill or a bad grade.

This also constrains the "5.4 and above" filter the epic asks for: a numeric
generation floor is meaningful only for the **text** families. Transcription,
TTS and embedding models use entirely different naming, and applying a floor to
them empties the dropdown rather than filtering it. See §6.

## 2. The five locked decisions

Do not re-open these in a child issue without raising it at the epic. Each one
shapes several modules at once.

| # | Decision | What it rules out |
|---|---|---|
| 1 | **Six role slots declared, two wired at launch.** The schema declares all six; the admin UI bound `tutor` + `grader` and rendered the other four inert using the registry's existing `disabled` card idiom. **Since E9 (`docs/specs/voice.md` §1), `transcribe` and `speak` are wired too, and since E11 (`docs/specs/realtime-interview.md` §1), `realtime` is as well — five wired, `embed` the only one still inert.** | A schema change (and a settings migration over live rows) when voice work starts — which is exactly what did **not** have to happen: E9 flipped two booleans in the existing registry, and E11 a third, no migration either time. |
| 2 | **Configurable generation floor with an escape hatch.** Classify each id into a capability family, parse its generation, apply the floor (default `5.4`) **to the text families only** — plus a "show all models" toggle. | An upstream rename emptying the dropdown with no admin workaround. |
| 3 | **Provider interface now, OpenAI concrete only.** `AiProvider` + `BaseAiProvider` mirroring `EmailProvider` / `BaseEmailProvider`, with per-provider capability flags. | Reshaping the settings surface, the test endpoint and the admin page all at once when Anthropic arrives. Also rules out an `openai-compatible` custom-baseURL kind for now. |
| 4 | **BYOK is mandatory per user.** All inference runs on the calling user's key. There is no server-key fallback. The server key populates the model catalog and lets an admin verify connectivity — nothing else. | A shared server key, and with it any ability to tell a user what they personally spent. |
| 5 | **Permissions are reused, not invented.** Admin surfaces gate on `system_settings:read` / `system_settings:write`; user surfaces declare no permission. | A new permission string, which costs a seed change, a re-seed, and every existing Admin role being updated — the reasoning already written down in `email-settings.controller.ts`. |

Decision 4 is the one with the widest consequences, and they are not all
comfortable: it makes an OpenAI account a hard prerequisite for using the
product at all, which is why §7 treats the key screen as an onboarding
experience with acceptance criteria rather than as a settings form.

## 3. Where things are stored

Two stores, split the way the email module already splits them.

| What | Where | Why |
|---|---|---|
| Provider choice, master switch, role → model bindings, generation floor | `system_settings` row at `key = 'ai'` | Ordinary configuration. Safe to return from an admin endpoint. |
| Server / admin OpenAI key | `credentials` at `(purpose: 'ai', name: 'openai')` | A secret. Encrypted at rest, unreadable through the API. |
| Per-user BYOK key | `credentials` at `(purpose: 'ai-user', name: <userId>)` | Same, per caller. |
| Recorded per-user usage | new `ai_usage_events` table | Time-series rows, queried by user and window; not settings. |

**A row of its own, not a key inside the `global` blob.** The argument is in
`email-settings.service.ts` and applies here unchanged:
`SystemSettingsService` rebuilds the `global` value field by field on every
write — `replaceSettings` parses through `systemSettingsSchema` (and zod
*strips* unknown keys), `patchSettings` hand-builds `{ ui, features }` — so an
`ai` key inside that blob would be silently destroyed the next time an admin
saved an unrelated feature flag. AI stops working, nothing in the audit trail
connects the two, and the admin's action ("I toggled a flag") has no visible
relationship to the outcome. A separate row also gives the AI settings page its
own version counter for `If-Match`.

**No database migration is needed for either key.** `credentials` is addressed
by `@@unique([purpose, name])`, which already accommodates both scopes. The only
new table in this epic is `ai_usage_events`.

### 3.1 Two `purpose` values, deliberately

`purpose` is not only the first half of the address — it is the HKDF sub-key
domain in `secret-cipher.ts`'s `deriveKey(purpose)`, and `CredentialsService`
passes the same string to both by construction, so the two can never drift.

Using `'ai'` for the server key and `'ai-user'` for personal keys therefore
means the two scopes are encrypted under **different sub-keys**. A ciphertext
lifted from one scope into the other — by a SQL write, or by a bug copying rows
— fails GCM authentication rather than decrypting into a context where it means
something different. That is the same guarantee `smtp` already relies on, and it
is worth more here, where one scope is organisation-wide and the other is a
named individual's credential.

The addresses live in `apps/api/src/ai/ai-credential.constants.ts`, a **leaf
module that imports nothing**, exactly as `smtp-credential.constants.ts` does.
That is not tidiness: with `emitDecoratorMetadata`, an import cycle between a
service and a provider means `design:paramtypes` is evaluated while one of them
is half-loaded, so a constructor parameter type reads `undefined` and Nest
fails to resolve the dependency at boot.

```ts
export const AI_SYSTEM_CREDENTIAL_PURPOSE = 'ai';
export const AI_SYSTEM_CREDENTIAL_NAME = 'openai';
export const AI_USER_CREDENTIAL_PURPOSE = 'ai-user';
export function aiUserCredentialName(userId: string): string;
```

`aiUserCredentialName` must produce a value that satisfies
`CredentialsService.assertIdentifier` — non-empty, with no leading or trailing
whitespace. That service rejects whitespace rather than trimming it, because
`'ai-user '` and `'ai-user'` derive two different keys and a silently trimmed
address is a row that saves and can never be read back.

## 4. The two hazards BYOK has that SMTP never did

Reusing the credential store for per-user secrets is the right call — it
inherits encryption, blank-preserves, the masked hint, and the no-egress proofs
for free. It also inherits two properties that were harmless for exactly one
organisation-wide SMTP password and are not harmless per user.

### 4.1 Orphaned key rows

`Credential` has **no foreign key to `User`**. The only relation in
`schema.prisma` is `updatedByUserId`, and it is `onDelete: SetNull` — it records
*who last edited* a credential, not who owns it. That behaviour is correct for
what it was designed for, and its comment says why: offboarding the admin who
typed in the SMTP password must not delete a working SMTP configuration.

A per-user key is addressed by `(purpose: 'ai-user', name: <userId>)`, where the
user id is **a string in the `name` column**, not a reference. The database
therefore has no way to know that row belongs to that user, and nothing will
ever collect it.

**Deleting a user leaves behind a row containing that person's live OpenAI API
key.** Encrypted, but retained indefinitely, and still chargeable to someone who
has left. That is a data-retention defect, not housekeeping.

The fix has two halves, because one alone is not enough.

**The hook.** `AiUserKeyService.purgeForDeletedUser(userId)` deletes the
credential, using the idempotent `CredentialsService.deleteSecret`. It is the
right immediate action wherever a user account is removed.

**The sweep.** `AiUserCredentialCleanupTask` runs nightly, finds
`('ai-user', <id>)` rows whose `<id>` matches no existing user, and deletes
them.

The sweep is not belt-and-braces; it is the part that actually holds. **This
application has no user-deletion endpoint** — `UsersService` offers
deactivation (`isActive: false`) and role changes and nothing else — so the
hook has no call site today. A hook with no call site is an unenforced promise
that whoever adds the first deletion path remembers to call it, and if they do
not, the failure is invisible: no FK and no query will ever point at the
orphan. The sweep does not depend on anyone remembering, and it additionally
collects rows orphaned by deletions performed outside the application entirely
— a `DELETE FROM users` run by an operator, a data migration, a GDPR erasure
done in SQL.

The sweep is the one legitimate caller of `CredentialsService.list('ai-user')`.
§4.2's rule is about **controllers**; this is a scheduled server-side task with
no HTTP surface, no caller and no response, and enumerating is the entire job —
an orphan cannot be found without looking at the set. It reads
`CredentialInfo`, so no key is decrypted even there.

**Deactivation is the opposite decision, and it is deliberate.** Deactivation is
reversible and the user may return; destroying their key on a temporary
suspension would make reactivation silently useless until they noticed and
re-entered it. So a deactivated user's key is **preserved**. Deletion is not
reversible and the key must go. Both halves are stated here so neither reads as
an oversight later.

Any future per-user credential `purpose` inherits this problem verbatim. The
rule is: **a `purpose` whose `name` is a user id owes the same deletion hook**,
and adding one without it is the same defect again.

### 4.2 `CredentialsService.list(purpose)` is unscoped

`list('ai-user')` enumerates **every** user's key metadata. It returns
`CredentialInfo`, which carries a compile-time proof that it cannot hold secret
material and whose query does not even select the ciphertext column, so this is
not a plaintext leak — but it is a cross-user metadata leak (who has a key, when
they set it, the masked hint) waiting for a convenient admin listing.

The rule this design adopts:

- Every per-user route resolves the credential address **from the authenticated
  principal**, and **no route accepts a user id parameter**. Widening that is
  then a signature change and a visible diff, not a query-string edit.
- `list('ai-user')` is never called from a controller.
- `CredentialsModule` still has no controller of its own, for the reason its own
  header gives.

An admin cannot read any user's key. That is enforced structurally — by the
endpoints having no parameter to name another user — not by a permission check
that a later refactor could relax.

## 5. The gate: two severities, never one flag

`GET /api/ai/status` returns two **independent** facts:

```
userKeyConfigured   this caller has a credential at ('ai-user', <their id>)
systemReady         provider configured, tutor + grader bound, master switch on
```

**`tutor` and `grader` here happened to be "every wired role" only because
they were the only two wired roles at the time.** E9 (`docs/specs/voice.md`
§1) wired `transcribe` and `speak` too, and narrowed `systemReady`'s formula
in the same commit to keep meaning exactly this — the *text* roles, not
"every wired role" — precisely so that wiring the two speech roles could not
flip an already-deployed installation's `systemReady` to `false` for a
capability nobody asked for. Read `docs/specs/voice.md` §1 for the failure
that would have caused and the narrowing that prevents it; it is not
restated here.

**E11 (`docs/specs/realtime-interview.md` §1) wired a third non-text role,
`realtime`, and needed no further change to this formula at all** — the
identical property the narrowing above was written to have. `realtime`'s
capability is `'realtime'`, not `'text'`, so it joins `unboundRoles` the
moment no model is bound to it (an admin sees the interview simulator has
no model) without ever touching `systemReady` (a learner with no `realtime`
binding still has a complete, working *text* mock interview). **State this
once, generally, rather than per role: `systemReady` is, and remains, a
statement about the wired *text* roles only — today `tutor` and `grader` —
and every voice or realtime surface gates on its own role's entry in
`unboundRoles`, never on `systemReady`.**

**`userKeyConfigured === false` is a hard block.** Immediately after login the
user is routed to `/setup/ai-key` and can reach nothing else. It is framed as a
first-run onboarding step, not an error state — because that is what it is.

**`systemReady === false` is not a block.** A user with a valid personal key
gets into the app. AI surfaces then fail at the point of use with an explicit
message that names the actual problem — the administrator has not finished
setting up the models — and, for a caller holding `system_settings:read`, a
direct link to `/admin/settings/ai`.

Collapsing these into one `ready` flag is **rejected**: it would tell a user to
add a key they already have, which is the single most confusing thing this
surface could do.

### 5.1 The exempt routes, and the deadlock one of them prevents

The gate's exemption list is deliberately short, and complete:

1. **`/setup/ai-key` itself** — or the redirect loops.
2. **Logout** — or a blocked user cannot leave.
3. **`/admin/settings/*` for a caller holding `system_settings:read`.**

Exemption 3 is not a courtesy. The admin AI settings page is the only place the
server key and the model bindings are set. Putting it behind a gate that nothing
has configured yet is a **deadlock on a fresh install**: the first admin cannot
configure the system they are being blocked for. The existing
`RequirePermission` gate still applies underneath, so a keyless *non*-admin
gains nothing from this exemption.

Note the exemption is keyed on the permission, not on a role name — the same
string the admin cards and routes declare.

### 5.2 Performance

The gate consults this endpoint on every navigation. It must be a cheap
existence check, not a settings parse plus a provider round trip:

- **No outbound provider call is made on this path**, ever.
- The `systemReady` half is derived from the settings row and cached in-process,
  invalidated on a settings write.
- The `userKeyConfigured` half is a single indexed lookup on
  `@@unique([purpose, name])`.

The web side must not re-fetch it per render. A request storm behind a
first-run gate is a self-inflicted outage on the one screen a new user cannot
get past.

## 6. The model catalog

`GET /v1/models` returns a flat, unordered list mixing chat, reasoning,
realtime, transcription, TTS, embedding, image and moderation models, plus
fine-tunes and long-deprecated ids. Handing that raw to an admin binding a
`grader` is not a usable surface.

So the provider **classifies** each id into a capability family — chat/reasoning,
realtime, transcribe, tts, embedding, other — and parses a generation where one
can be determined. Classification is table-driven and unit-tested against a
fixture of real ids, **including ids the classifier does not recognise**.

Filtering is applied by the caller, not baked into the fetch:

- The generation floor (`minModelGeneration`, default `5.4`) applies **only to
  the text families**.
- Non-text families are filtered by capability family alone.
- A model whose generation cannot be parsed is **not silently dropped**. It
  surfaces under the show-all view.

The show-all toggle is the guarantee that an upstream naming change can never
leave an admin with an empty dropdown and no workaround. That is a real failure
mode: model naming is not ours to control, and a filter we cannot switch off is
a filter that eventually locks the product out of its own configuration.

A missing server credential returns a clean "not configured" result rather than
a crash — `getSecret` returns `null` for an absent credential by design, and
that is the state of every fresh install.

The catalog is cached briefly, in-process, on the order of minutes: the admin
page calls it on every render and each call is a round trip on the org's key.
**The cache must not leak between differing key configurations** — a key change
invalidates it.

## 7. The onboarding UI is an acceptance criterion

`/setup/ai-key` is **the first thing every user sees after their first login**,
and until they finish it the product does nothing at all.

The audience makes this harder than it sounds. `VISION.md`'s user is preparing
for a naturalization interview, is often an ESL speaker, may understand written
English better than spoken, and has almost certainly never heard of an API key.
We are asking them, at minute one, to visit a third-party developer console,
create a credential, and paste it into an app.

**A bare settings form here is a product failure, not a styling gap.** It is
also directly against `VISION.md`'s stated tone — "never condescending about
English ability", "warm, but not sugary", "comfortable admitting uncertainty".

The screen must carry:

1. **Welcome framing** — who this is for and what happens next, in one or two
   plain short sentences.
2. **Why a key is needed** — that OathPath uses AI to teach, listen and run mock
   interviews, and that the user brings their own key so their usage is theirs:
   they control it, they can see it, they can revoke it. In the user's terms,
   not the architecture's.
3. **How to get one**, as numbered steps with the real OpenAI link, assuming the
   reader has never seen that console.
4. **The paste field and a prominent Test action.**
5. **Celebrated, unambiguous success**, then hand-off into the app — not a
   dead-end confirmation screen.

Constraints that are part of the deliverable, not polish:

- One shared `AiKeyForm` component, two chromes (onboarding and `/settings/ai`).
  Neither forks it; the failure-state copy is exactly the thing that gets
  written well once and badly the second time.
- Mobile-first per `VISION.md`; responsive at the **`sm` (600px)** boundary,
  honouring the five coupled breakpoint gates named in `CLAUDE.md`. The boundary
  is `sm`, never `md` — gating at 900px hands the phone treatment to tablets and
  landscape phones.
- Legible at 360px wide, correct in both themes, real labels, visible focus,
  sensible heading order, results announced to assistive technology.
- **Do not trap the user.** Logout must be reachable from this screen, and an
  admin must be able to reach `/admin/settings/*` from it.

## 8. A user's Test must verify reachability, not just validity

The admin binds model ids using the **server** key. A user's personal key may
sit in a different organisation or tier with **no access to those models**.

So `POST /api/ai/key/test`:

1. authenticates the key, then
2. checks that each **wired** role's bound model is actually reachable on it,

and reports **per-role results**, not a single boolean. Testing only
`GET /v1/models` would pass for a key that cannot run a single request the app
actually makes — which is the entire failure this endpoint exists to catch.

The UI must name the actual problem, in four distinguishable classes:

- the key is malformed (wrong shape, pasted with whitespace, a partial copy),
- the key was rejected by OpenAI,
- the key works but cannot reach a bound model,
- the request never got there (network / server).

Echoing one raw provider string for all four is not acceptable. The raw text may
be shown *in addition*, in monospace, the way `EmailSettingsPage.tsx` shows a
verbatim provider error — but it is not the message.

Test results live in a **persistent dismissible `Alert`**, never a snackbar. A
diagnosis has to stay on screen. Save confirmations are the transient case.

## 9. Usage accounting

Every user pays for their own consumption, so every user must be able to see
what they have spent. `ai_usage_events` records one row per call, on success and
on failure alike, written from `BaseAiProvider`.

Getting the token counts right is the substance of it:

- OpenAI returns `usage` on a completed non-streaming response.
- For **streamed** responses it is emitted **only** when the request sets
  `stream_options: { include_usage: true }`. Omitting that silently records
  zero for every streaming call. This is the most likely way the feature ends up
  quietly wrong, so a test asserts the flag is set — the failure has no symptom
  of its own.
- A call that fails mid-stream yields **partial or no** usage. Record
  `success: false` and the `errorCode`, and leave the token columns **null**
  rather than writing `0`. Null means "unknown"; `0` is a claim, and a false one
  that understates consumption.

Recording must never fail the user's request. A usage write that throws is
logged and swallowed — the same never-throw posture the provider base class
already takes for delivery.

`userId` on `ai_usage_events` gets a real relation with **`onDelete: Cascade`**
— unlike `Credential`, whose missing FK is the defect in §4.1. Usage rows are
the user's own data and should go with the account.

No prompt or completion content is ever recorded. Token counts and metadata
only.

**Presentation contract: this is recorded usage, never a bill.** Token counts
are not dollars, calls that fail mid-stream record nothing, and the
authoritative number is the user's own OpenAI dashboard. The page says so
plainly and links there. Presenting an approximate figure as a bill is the
failure to avoid.

## 10. The provider abstraction

`AiProvider` + `BaseAiProvider` in `apps/api/src/ai/providers/`, mirroring
`EmailProvider` / `BaseEmailProvider`.

**Never-throw**, implemented once in the base class with a bare `catch`.
Subclasses implement only a `protected` delivery method and contain no
`try`/`catch` at all. The email base class explains why the contract lives in
one file rather than in a comment on an interface, and the argument transfers
without modification.

**Error text is returned verbatim** after passing through `SecretRedactor` and
the existing length cap. No categorising, no rewriting — a refused call is a
successful diagnosis. `SecretRedactor.protect()` is called **the instant a key
is obtained**, before anything that can throw while holding it, so that even an
error authored by the OpenAI SDK is scrubbed.

**Per-provider capability flags** are load-bearing rather than decorative:
Anthropic, Kimi and Qwen offer chat but no TTS, transcription or realtime
surface, so a provider must be able to declare which roles it can serve at all,
and a provider that does not declare a capability cannot be selected for that
role.

**`SecretRedactor` moves** out of `apps/api/src/email/base-email.provider.ts`
into `apps/api/src/common/crypto/secret-redactor.ts`, and is re-exported from
the email module for path stability. Its behaviour is already generic; only its
location was email-specific. This is the same move `smtp-credential.constants.ts`
models. It is not forked, and the email module's behaviour is unchanged — its
existing tests pass untouched.

**Observability:** `@Trace()` is **not sufficient here**. `BaseAiProvider` is
never-throw by design, so the decorator would record every call as `OK`,
including every failure — which is worse than no instrumentation, because it
looks like data. The provider sets span status and attributes explicitly:
model, role, token counts, failure. No key, in any attribute, ever.

## 11. API surface

| Method + path | Gate | Notes |
|---|---|---|
| `GET /api/ai-settings` | `system_settings:read` | Settings + non-secret `apiKeyStatus`. Never the key. |
| `PUT /api/ai-settings` | `system_settings:write` | `If-Match` optimistic concurrency. Write-only `apiKey`, blank preserves. |
| `GET /api/ai-settings/models` | `system_settings:read` | Classified catalog + the role registry. Show-all escape hatch. |
| `POST /api/ai-settings/test` | `system_settings:write` | Side-effecting. 200 with `{ success: false }` on failure. |
| `GET /api/ai/key` | `@Auth()`, no permissions | `{ configured, hint, updatedAt }`. Caller-scoped. |
| `PUT /api/ai/key` | `@Auth()`, no permissions | Caller-scoped. Blank preserves. |
| `DELETE /api/ai/key` | `@Auth()`, no permissions | The only way to erase. Idempotent. |
| `POST /api/ai/key/test` | `@Auth()`, no permissions | Per-role reachability. 200 on failure. |
| `GET /api/ai/status` | `@Auth()`, no permissions | Two independent flags. No provider call. |
| `GET /api/ai/usage` | `@Auth()`, no permissions | Caller-scoped. Recorded, not billed. |

**No route in the caller-scoped half takes a user id.** That is the enforcement
mechanism described in §4.2, and it is why these are `@Auth()` with no
permissions rather than gated: every authenticated user owns their own
credentials, and gating them would leave a Viewer unable to use the app at all.

The admin `test` endpoint is gated on **write**, not read, and takes **no target
parameter**. Both follow `POST /api/email-settings/test`: it has a side effect
(an outbound call on the org's key), and a free-text model or base URL would
make it a call-arbitrary-endpoint primitive.

**Both test endpoints return HTTP 200 even when the test failed**, as
`{ success: false, error }`. The argument is written out in full in
`dto/test-email-result.dto.ts`: this app's error envelope suppresses detail in
production and the web client funnels it into generic failure handling, so the
one fact the endpoint exists to produce would be the one fact lost. A real
4xx/5xx still means what it always means — not authenticated, not permitted,
malformed, or a bug.

**Every test attempt is audited**, success or failure, through one funnel.
Actions follow the `<domain>:<verb>` convention already used by
`email_settings:replace`: `ai_settings:replace`, `ai_settings:test`,
`ai_key:set`, `ai_key:delete`, `ai_key:test`. The audit `meta` carries neither
the key nor its hint.

## 12. The write-only key field

`apiKey: z.string().max(...).nullish()` in the request DTO — **no `.trim()`, no
`.min(1)`, no `.default('')`**. Each of those defeats blank-preserves, and each
looks like tidying up:

- `.trim()` — a key whose surrounding whitespace is significant becomes a
  different key, and authentication starts failing with no visible cause.
- `.min(1)` — a blank submission becomes a 400, so an admin editing the model
  bindings can no longer save without retyping a secret they cannot see.
- `.default('')` — turns "absent" into a value, and any code downstream that
  distinguishes the two now sees the wrong one.

Blank means "the admin did not retype the key" and preserves the stored value.
Erasing is `DELETE`, from a distinct control.

**Ordering on save: write the credential first, then the settings row.**
`CredentialsService.setSecret` rejects a blank secret written to an address that
holds nothing yet, so doing the settings write first would persist a selected
provider with no key behind it and *then* 400 — the admin sees a failure, the
configuration changed anyway, and the next call fails for a reason the error
never mentioned. The opposite partial failure is harmless: a stored key that no
settings row points at is inert.

## 13. The two read paths

`AiSettingsService` has two reads that differ deliberately, as
`EmailSettingsService` does:

- an **internal read** used by the provider, which **throws** on a
  stored-but-invalid row, naming **field paths only, never values**. Silently
  substituting defaults would report a corrupt row as the benign "AI is not
  configured", which is the silent-disablement failure the credential store
  refuses on a decrypt error, for the same reason.
- **`describeForAdmin()`**, which **never throws** and reports the problem
  through a `settingsError` field instead. A 500 here would make the broken row
  take down the one screen capable of repairing it.

## 14. Compile-time proofs

Two of them, and they are separate claims:

1. `aiSettingsSchema` carries the "carries no secret" proof from the bottom of
   `email-settings.schema.ts`. Adding `apiKey` to the **persisted** schema must
   break the build.
2. The **response** DTO carries its own, because it `.extend()`s the persisted
   schema and an extension is exactly where a convenience field ("just send the
   key back so the form can prefill it") would land.

The role registry is likewise **derived**, not hand-written: adding a role
widens every consuming `switch` in the same edit rather than falling through
silently.

## 15. Where the role registry lives

In the **API**, read by the web over `GET /api/ai-settings/models` — never a
duplicated copy in `apps/web/src/config`.

This is option 1 of the three `notification-events.ts` weighs, chosen for the
same reason. A duplicate with a test asserting agreement is detection rather
than prevention, and it breaks the one-registry-entry promise directly. A
shared package is available (`packages/shared` exists), but it carries
rebrandable constants as plain CommonJS with a hand-written `.d.ts` and no build
step; a registry the admin UI drives its selects from is a different kind of
thing, and the web getting the *server's answer* beats the web getting a second
declaration a build could skew.

## 16. Key rotation widens `SECRETS_ENCRYPTION_KEY`'s blast radius

`docs/runbooks/rotate-secrets-encryption-key.md` today describes a rotation
whose practical cost is that an administrator re-enters the SMTP password.

After this epic, rotating that key means **every user must re-enter their own
OpenAI key**, and — because a keyless user is hard-blocked (§5) — every user is
locked out of the product until they do. That is a different operational event
from "email stops sending", and the runbook must say so.

The failure is loud rather than silent, which is right: `CredentialsService`
throws on a credential that exists but will not decrypt, rather than reporting
it as "not configured".

## 17. Rejected alternatives

| Alternative | Why it lost |
|---|---|
| **A single `model` setting instead of role → model bindings** | The `grader` runs on every practice answer and must be cheap and sub-second; the `tutor` must be strong. One binding is either too expensive at `grader` volume or too weak at `tutor` quality, and the product has no way to express the difference. §1. |
| **A shared server key for all inference** | Removes the per-user consumption picture entirely, which is the reason BYOK was chosen. It also concentrates every user's spend on one org key with no per-user attribution and no way for a user to see, cap, or revoke their own usage. |
| **One combined `ready` flag on `/api/ai/status`** | Produces the worst possible message: a user blocked by missing *admin* configuration is told to add a key they already have. The two facts have different severities and different remedies. §5. |
| **Gating the per-user key endpoints on a permission** | Every authenticated user owns their own credentials. A permission gate would leave a Viewer unable to use the app at all — and the gate would be enforcing an authorization rule the product does not have. Decision 5. |
| **A new `ai_settings:read`/`:write` permission pair** | Costs a seed change, a re-seed, and every existing Admin role being updated, for a page that is administering system configuration by any reading. The same conclusion `email-settings.controller.ts` reached. |
| **Storing AI config inside the `global` settings blob** | `SystemSettingsService` rebuilds that blob field by field on every write, so an `ai` key in it is silently destroyed the next time an admin saves an unrelated feature flag. §3. |
| **Putting the API key in the settings schema** | A settings blob is returned wholesale by an admin endpoint, so a secret in it is one careless response away from exposure — and blank-preserves would have to be reimplemented there rather than inherited. There is a compile-time proof against it. §14. |
| **A user-id parameter on the per-user routes** | Turns cross-user access into a query-string edit. Resolving the address from the authenticated principal makes widening it a signature change and a visible diff. §4.2. |
| **An admin listing of all users' keys via `list('ai-user')`** | Not a plaintext leak, but a cross-user metadata leak (who has a key, when, the masked hint), and the shape that grows a "show me everything" endpoint. §4.2. |
| **Exempting no admin route from the key gate** | Deadlocks a fresh install: the first admin cannot reach the only page that configures the system they are being blocked for. §5.1. |
| **Blocking on `systemReady === false`** | Punishes a user for an administrator's unfinished configuration, and — with the flags merged — tells them to fix their key. Point-of-use messaging is the correct severity. §5. |
| **A hard-coded model allowlist instead of a live catalog + floor** | Goes stale the week OpenAI ships a model, and the staleness is invisible until an admin cannot select the model they are paying for. |
| **A generation floor applied to every family** | Transcription, TTS and embedding models use entirely different naming, so a numeric floor empties those dropdowns rather than filtering them. §6. |
| **Dropping models whose generation cannot be parsed** | Makes an upstream rename look like a model that does not exist, with no way for an admin to find out otherwise. They surface under show-all instead. §6. |
| **No show-all escape hatch** | A filter that cannot be switched off eventually locks the product out of its own configuration, because model naming is not ours to control. Decision 2. |
| **Writing the settings row before the credential** | `setSecret` rejects a blank secret at an address holding nothing, so the request would persist a provider with no key behind it and then fail. §12. |
| **Recording `0` tokens for a mid-stream failure** | `0` is a claim, and a false one that understates consumption. Null means unknown, and `success`/`errorCode` distinguish the two. §9. |
| **Omitting `stream_options: { include_usage: true }`** | Silently records zero for every streaming call. The failure has no symptom of its own, which is why a test asserts the flag. §9. |
| **Using `@Trace()` alone on the provider** | The provider is never-throw, so the decorator records every failure as `OK` — instrumentation that looks like data and is not. §10. |
| **Forking `SecretRedactor` into the AI module** | Two copies of the one thing standing between a provider error and a leaked key. It moves to `common/crypto/` and is re-exported. §10. |
| **A snackbar for test results** | A diagnosis has to stay on screen long enough to act on. Snackbars are for save confirmations. §8. |
| **A bare settings form at `/setup/ai-key`** | It is the first screen of the product for an audience that has never seen an API key. §7. |
| **Duplicating the model-role registry in `apps/web/src/config`** | Detection instead of prevention, and it breaks the one-registry-entry promise. The web reads the server's answer. §15. |
| **An `openai-compatible` custom-baseURL provider kind now** | Would unlock Kimi and Qwen, and is the obvious next step — but it is a separable piece of work with its own trust questions (an admin-supplied base URL is an outbound-request primitive), and it does not have to reshape anything this epic builds. |
| **A `Credential` → `User` foreign key** | Would fix §4.1 structurally, and is wrong for the existing consumer: `SetNull` deliberately keeps a working SMTP configuration alive when the admin who typed it in is offboarded. The per-user case needs a deletion hook, not a changed FK for everybody. |

## 18. Out of scope (deliberately)

- Admin-wide usage rollup across users. This epic gives each user only their
  own.
- Rate limiting and spend caps.
- The `openai-compatible` provider kind.
- **Any actual AI feature.** This epic makes AI configurable and provably
  working; it consumes nothing yet. The first consumer arrives in a later epic,
  and §5's point-of-use component is the blocked state it will render.

## 19. Suggested phasing (non-binding)

Not the actual issue list — the epic owns that — but the dependency order the
modules impose:

1. This document.
2. Declarations: settings schema, role registry, credential addresses.
3. `AiProvider` + `BaseAiProvider`, including the `SecretRedactor` move.
4. The OpenAI provider: catalog, classification, generation floor.
5. `ai_usage_events` and its migration.
6. Admin service + controller, then `/models`, then `/test`.
7. Per-user key endpoints, then `/status`, then usage recording and `/usage`,
   then the deletion hook.
8. Web: the admin page; then `AiKeyForm`; then the gate; then `/setup/ai-key`
   and `/settings/ai`; then the point-of-use state.
9. Documentation: `CLAUDE.md`, `docs/API.md`, `docs/SECURITY-ARCHITECTURE.md`,
   and the rotation runbook.

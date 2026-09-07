# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Release checklist: realtime and voice code

This repository has no separate release-procedure document, so this note
lives here — the place a release's own entry is already written, and
therefore the one place a person compiling that entry cannot miss it.

**Before any release whose diff touches voice or realtime code** —
`apps/api/src/ai/providers/`'s `transcribe`/`synthesize`/`createRealtimeSession`
paths, anything under `apps/api/src/interviews/realtime/` **or
`apps/api/src/practice/realtime/`** (added by E15, epic #345), or
`apps/web/src/services/realtimeConnection.ts`, `apps/web/src/hooks/useRealtimeInterview.ts`,
**or `apps/web/src/hooks/useRealtimePractice.ts`/`useConversationSession.ts`**
— run the manual verification checklist in
[`docs/specs/realtime-interview.md`](docs/specs/realtime-interview.md) §11:
eight numbered items (barge-in in both directions, end-to-end latency, the
end control under load, mid-session device switching, microphone denial,
network loss, and secret expiry), each with its own pass criterion, run by a
person against a real deployment, a real browser, and a real microphone. No
suite in this codebase automates it, by design — §10 of that same document
states why honestly rather than pretending otherwise — so this checklist is
the only thing standing between a barge-in regression and a shipped release.
`docs/specs/realtime-practice.md` §12 confirms this is the identical
physical checklist for practice's own realtime transport, reused rather than
duplicated, plus one practice-specific addition: confirming the
**mid-session fallback** actually speaks its notice and resumes on the same
session id with no lost progress.

**Record the result as a line in that release's own entry below**: pass/fail
per item, who ran it, and when. A release note that changes realtime or
voice code with no corresponding checklist line is incomplete, not merely
undocumented — the identical standard `docs/specs/realtime-interview.md`
§11 already states for this exact rule.

## [Unreleased]

### Added

- **A place to see what this device will actually allow (issue #384).**
  `/settings/device` — "Device & permissions" — is a new per-user settings
  destination with three rows, each stating what is true right now and
  offering the one action that can change it: the **microphone**
  (observed, and worded with `describeCaptureProblem`'s existing
  seven-remedy table verbatim, so it says the same sentence the practice
  screen would), **notifications** (observed, and requested through the
  same shared `requestBrowserNotificationPermission` the notification
  preferences page already calls), and **sound** (a "Play a test tone"
  button, so a learner can tell a muted phone from a broken feature).
  Nothing on the screen prompts on mount, on navigation, or on app start:
  every permission request sits behind a real click, because browsers
  penalise gestureless prompts and a denial is effectively permanent — the
  app cannot re-prompt or undo one. A blocked state therefore renders an
  explanation and **no button**, because there is no action this
  application can honestly offer. Adds no API route, no permission string,
  no migration and no setting; the page makes no authenticated API call at
  all. See [`docs/specs/voice.md`](docs/specs/voice.md) §5.1.

- **Conversation mode — hands-free spoken practice (E13, epic #304).** A
  session-wide `Text | Voice` control on a practice session: with `Voice`
  selected, tapping **Start hands-free** arms a persistent microphone
  stream, a calibrated voice-activity detector (with barge-in — talking
  over a question cancels it and starts listening), synthesised earcons,
  and a screen wake lock, and the app reads each question, listens for the
  spoken answer, grades it, speaks the accepted answer, and moves on with
  no further taps. `voice.conversationMode` (issue #307, `false` by
  default) is the seventh field on the existing `voice` user-settings
  namespace; turning it on only decides which mode a session *loads* with
  — a learner still taps **Start hands-free** to arm the loop, so the
  preference buys one tap instead of two, never a zero-tap session.
  Fixed as a side effect: `voice.readQuestionsAloud` is now actually
  honoured (`QuestionAudio`'s `autoPlay` prop was resolved but never wired
  to the practice page's mount), and `QuestionAudio` now exposes an
  `onFinished` callback and a `stop()` handle so a caller can tell when
  playback ends and cancel it mid-read. No API route or permission string
  was added. See
  [`docs/specs/conversation-mode.md`](docs/specs/conversation-mode.md).

**Manual microphone checklist: not run, for either E12 or E13.**
`ROADMAP.md`'s own E12 footnote already records that a person has not run
E12's real-microphone verification against a real deployment — that gap
is restated here, not newly discovered. E13 has the identical gap, and
this entry is where issue #315 asked it to be recorded: this environment
has no microphone, no Docker daemon, and no compose stack, so nobody ran
`docs/specs/conversation-mode.md` §16's acoustic checklist for this
release either — what follows is not a defect list but a record of what a
later reader should not assume was verified:

1. Ambient-floor VAD calibration on a quiet room versus a noisy or windy
   one — unverified against real audio.
2. Deliberate barge-in (talking over a question mid-read) versus ambient
   noise not falsely triggering it — unverified against a real speaker and
   a real microphone.
3. The ~8 s onset timeout and the spoken re-listen nudge it triggers on
   silence — unverified end to end.
4. A full one-tap session, start to finish, on a real device — not run.

What *was* run: the state-machine unit tests
(`useConversationSession.test.ts`, `useVoiceActivity.test.ts`,
`useWakeLock.test.ts`, `PracticeSessionPage.conversation.test.tsx`), which
drive the detector and the driver against synthetic level sequences — a
real test of the logic, and, honestly, not a test of whether the
calibration copes with a real windy street, exactly as
`docs/specs/conversation-mode.md` §16 says of itself. Issue #314
(PR #342, commit `ae7821e`) closed the acceptance-journey gap by adding
five conversation-mode scenarios to `tests/e2e/specs/voice.spec.ts`: the
one-tap Quick 5 journey, asserting an instrumented tap count of exactly
one; barge-in over the question cancelling playback and starting
recording; a wrong answer re-listened to exactly once, with a second miss
moving on; "Type instead" reachable from all five phases, parameterised
into five generated tests; and a mic-permission denial exiting the loop
with a spoken and a rendered reason. Like `civics-learn.spec.ts` before it
(`ROADMAP.md` §3's E2 footnote), these five were written and registered
but never executed: this environment has no Docker daemon and no compose
stack, and `tests/e2e` is not run by CI. What was independently verified
is that `tsc --noEmit -p tests/e2e/tsconfig.json` is clean and
`npx playwright test --list` registers all five (57 tests across 13
files).

#314 also added Vitest coverage for cross-hook composition, the retry
budget as a property, and unmount in every state (+28 tests; the web
suite is now 151 files / 3024 passed / 3 skipped, up from a 2996
baseline), and introduced one **test-only** product seam in
`PracticeSessionPage.tsx` for the VAD level source, gated on
`import.meta.env.PROD` exactly as `App.tsx` gates `TestLoginPage` — a
production build eliminates it.

- **A coach whose voice a learner chooses (E14, epic #305).** Four
  personas — `supportive` (the default; exactly today's voice, unchanged
  for anyone who never opens the setting), `academic`, `playful`, and
  `unfiltered` (opt-in only, never suggested) — colour the grader's
  feedback, the tutor's civics explanation, and a new short reaction line
  shown after most practice attempts. `GET /api/ai/coach/personas` lists
  the four voices; `coach.persona` and `coach.reactions` (Settings →
  Coach) are the new user-settings fields. No persona ever changes a
  verdict, an accepted answer, or a readiness figure — a seven-rule
  invariant floor, unchanged across all four voices, forbids commenting on
  a learner's English, their origin or status, or their odds of becoming a
  citizen, on every persona including `unfiltered`. See
  [`docs/specs/coach-personality.md`](docs/specs/coach-personality.md) and
  [Choosing Your Coach](docs/choosing-your-coach.md).

  **On the reaction bank's content review, stated plainly rather than
  implied:** every line in `apps/api/src/ai/coach/reaction-lines.ts`,
  `unfiltered`'s included, was written and read against the invariant floor
  by Claude (Anthropic's coding agent), working at the repository owner's
  direction and under his standing authorization to merge without his own
  review — not by an independent human reviewer. An automated banned-topic
  lint runs over every shipped line as part of the test suite and fails
  the build on a match; that check is real and enforced today. A human
  read of the bank — `unfiltered`'s lines specifically — has not happened
  and is recommended before this feature reaches a public release.

  **The bank was deepened from 123 lines to 648 (issue #352, epic #345),
  and the attestation above covers the new lines exactly as it covers the
  old ones:** all 525 additions were written by Claude and read back by
  Claude against the same invariant floor, with no human review of any of
  them. Every one passes the same automated banned-topic lint, which now
  also enforces a depth floor tied to `MAX_PLANNED_COUNT` (twenty lines per
  `answer.*` cell, so a full twenty-question session can never be forced to
  repeat a line) and global uniqueness across the whole bank. The same
  issue lit up the three `session.complete_*` cells, which had been
  computed and served since #320 and rendered by nothing: a completed
  session's `coachReaction` is now shown on the practice summary and, in
  Voice mode, spoken as the session's closing turn.

- **Live, full-duplex voice practice, and a spoken turn that finally says
  whether you were right (E15, epic #345).** The epic's own acceptance
  sentence: a learner completes a practice session by voice, on a phone or
  a laptop, hearing whether each answer counted and why, in their chosen
  coach's voice.

  - **The spoken turn (issues #351, #352).** `composeSpokenTurn`
    (`apps/api/src/practice/spoken-turn.ts`) replaces the single line the
    hands-free loop used to speak after grading — `acceptedAnswers[0].text`
    and nothing else, which made a right answer and a wrong answer
    byte-identical audio — with an ordered sequence: what was heard (on a
    miss only), the verdict, the grader's reason (only when one ran), the
    accepted answer (on a miss or a skip, never a correct answer), and the
    coach's persona line, with the accepted answer deferred past an armed
    retry so the retry is never a repeat-after-me. Reaches the wire as
    `spokenTurn: string[]` / `retryBoundary: number | null` on an attempt
    and on a completed session's summary. `composeSessionClosingTurn`
    speaks the three `session.complete_*` reaction cells E14 lit up but
    nothing rendered.
  - **A live voice transport (issues #353, #354, #355, #356), alongside
    E13's request/response loop rather than replacing it.** `realtime`
    joins `tutor`/`grader`/`transcribe`/`speak` as a sixth AI model role,
    `wired: true`, capability `'realtime'` — optional, and, like
    `transcribe`/`speak`, never affecting `systemReady`. Bound, the
    session-wide `Voice` control opens a full-duplex conversation over
    `POST /api/practice/sessions/{id}/realtime-session` (a short-lived
    client secret) and `POST /api/practice/sessions/{id}/realtime/tool-calls`
    (`next_question` / `grade_answer` / `repeat_question` /
    `skip_question` / `end_session`); `grade_answer` records the identical
    `practice_attempts` row, column for column, that the ordinary attempt
    route would, verified by an equivalence test that drives both
    transports against one pinned clock and compares the two writes as
    whole objects. Unbound, or a live connection failed or dropped past its
    bounded reconnect attempts, `Voice` falls back to E13's loop instead —
    spoken aloud, with no attempt or progress lost, because none of it was
    ever held in the browser. `VoiceSurface` (#356) replaces roughly 300
    lines of bespoke per-transport markup on `PracticeSessionPage.tsx`
    with one full-screen component shared by both loops: one `h1`, one
    live region, and the two controls a learner must always be able to
    reach (Stop, Type instead) never scrolled off a small viewport.
    `resolveVoiceTransport` is the one function that decides the ladder;
    `useRealtimePractice` is the one hook that opens exactly one
    `getUserMedia` stream for the live transport.
  - **A learner starting Voice from `/practice` no longer has to find
    "Start hands-free" a second time (issue #350).** A fresh start carries
    a one-shot intent across the navigation and arms whichever transport
    the ladder resolves to the moment the session is ready — a genuinely
    zero-tap session from the picker's own tap forward. A **resumed**
    session (Recent sessions, or a reload) still requires the explicit
    Start tap, deliberately: a stored preference is not a fresh gesture.
  - **A preflight before the learner commits, not only a failure after
    (issue #349).** `useMediaReadiness` reads `navigator.permissions` and
    `enumerateDevices()` on mount — observationally, never prompting — so a
    microphone already blocked is shown on the session screen before Start
    is ever tapped, not discovered mid-walk. The honest new `preparing`
    phase (between the tap and the question) replaces a screen that used
    to claim "Asking you the question." while the permission dialogue was
    still open.
  - **Eight earcons on one phase-keyed table, and a learner's own switch
    to turn them off (issue #357).** `apps/web/src/lib/conversationCues.ts`
    derives every cue from the state machine's own transitions — adding a
    phase does not compile until every cell touching it has a decision,
    silence included — replacing three hand-placed calls that had left
    five edges (the tap, the question, the pause, both exits) silent.
    `voice.soundCues` (default `true`) is the eighth field on the `voice`
    namespace.
  - **No permission string, no migration.** Every route E15 adds is
    `@Auth()` with no permissions, for the identical reason every other
    practice route is; every settings field added (`soundCues`) follows
    the existing no-`.default()` namespace pattern. See
    [`docs/specs/realtime-practice.md`](docs/specs/realtime-practice.md),
    [`docs/specs/conversation-mode.md`](docs/specs/conversation-mode.md),
    and [`docs/runbooks/configuring-voice.md`](docs/runbooks/configuring-voice.md).

  **A real, live gap this epic's own closing test pass (issue #360) found
  rather than fixed, tracked as
  [issue #375](https://github.com/marinoscar/oathpath/issues/375) — now
  closed:** `useConversationSession.ts`'s hands-free loop had never
  adopted `attempt.spokenTurn` — it spoke only the bare accepted answer, on
  every outcome, via the exact pre-#351 line `spoken-turn.ts`'s own header
  names as the original defect. `VoiceSurface`'s visual live region did
  render the full composed turn correctly (so a screen-reader user heard
  it), but the app's own `speechSynthesis` voice — what a learner walking
  with the phone in a pocket actually relies on — did not. Filed rather
  than fixed at the time, per issue #360's own scope (tests and docs only,
  no product code).

  **Closed by [PR #377](https://github.com/marinoscar/oathpath/pull/377)
  (`fix/e15-375-speak-turn`), merged to `main` as `c8a4c18`.**
  `ConversationGrade.spokenAnswer` is gone from
  `useConversationSession.ts`'s own type entirely, replaced with
  `spokenTurn: string[]` and `retryBoundary: number | null` — the API's
  own field names and meanings (#351), passed through verbatim rather than
  re-derived. `gradeTranscript` now speaks `spokenTurn.slice(0, boundary)`
  one utterance per element; on a miss with the one-per-question retry
  still unspent it speaks the retry nudge and returns **without** the
  deferred tail (typically the accepted answer) — so a learner who still
  has a retry is never told the answer first — and otherwise speaks the
  tail and advances. `retryBoundary === null` speaks the whole array; a
  negative boundary is clamped rather than handed to `slice`. Verified by
  unit tests and `tsc --noEmit` only, not by the Playwright walk or a real
  microphone — see the web suite count below and the manual checklist
  immediately following, which this PR does not touch.

**Manual real-microphone checklist (E15, epic #345): not run, on the
identical basis E12's and E13's own footnotes above already state, restated
here rather than newly discovered.** This environment has no microphone, no
Docker daemon, and no compose stack — the same three absences that kept
`tests/e2e` from executing for the past two epics keep it from executing for
this one. Per the release-checklist note at the top of this file and
`docs/specs/realtime-practice.md` §12, what a person must still run against
a real deployment, a real browser, and a real microphone before this epic
ships to production:

1. Live voice's own barge-in and end-to-end latency, and the six other
   items on `docs/specs/realtime-interview.md` §11's checklist, reused
   verbatim (`realtime-practice.md` §12 states why this is the identical
   physical phenomenon, not a second checklist to write) — **not run.**
2. The mid-session fallback (§8 of that document) actually speaking its
   notice, on a real dropped connection, and actually resuming on the same
   session id with no lost progress — the one item that checklist has no
   analogue for — **not run.**
3. Conversation mode's own acoustic checklist (`docs/specs/conversation-mode.md`
   §16, the four items E12/E13's own footnote above already lists:
   ambient-floor calibration, deliberate barge-in versus ambient noise, the
   onset timeout and its spoken nudge, and a full one-tap session on a real
   device) — **still not run**, for the identical reason it was not run for
   E12 or E13; this epic changed no product code that would newly verify
   any of the four.
4. `voice.soundCues`'s eight earcons, actually audible and actually
   distinguishable from each other on a real speaker — **not run.**

**What *was* run for this epic:** the full API suite (`npm test`,
`--maxWorkers=2`) — 207 suites, 5,184 tests passed, 74 skipped, zero
failures — and the full web suite (`vitest run`, sharded) — 174 files,
**3,485 tests passed, 3 skipped, zero failures** (up from 3,478 passed
before PR #377 closed issue #375; the +7 is that PR's own new coverage in
`useConversationSession.test.ts` and
`PracticeSessionPage.conversation.test.tsx`) — both against the baseline
this repository already carried, plus `tsc --noEmit` clean on both
workspaces. Issue #360 added: a property test asserting no two outcomes
(including a retry-armed miss) produce the same composed spoken turn; a
test asserting all four coach personas produce four different spoken turns
from an identical verdict; a test asserting the shared `AudioContext`
survives a switch to realtime voice and back as the same single instance;
and five Playwright scenarios extending `voice.spec.ts` — a one-tap
fresh-start journey, "Type instead" reachable from `preparing` (the sixth
of the now-seven `ConversationPhase` values), a microphone already blocked
shown before Start is ever tapped, the voice surface fitting 360×640 with
no document scroll, and (added as `test.fixme`, pending issue #375) a
correct answer and a spent-retry wrong answer NOT being byte-identical
audio. Like every Playwright spec in this repository, none of the five was
executed here — `tsc --noEmit -p tests/e2e/tsconfig.json` is clean, which
is the one thing about them this environment could actually confirm.
**The fifth scenario is no longer `test.fixme`: PR #377 closed issue #375
and the scenario is a live test in `tests/e2e/specs/voice.spec.ts` today**
(`grep -n test.fixme` against that file returns nothing) — verified by
`tsc --noEmit -p tests/e2e/tsconfig.json` staying clean and by the unit
test counts above, not by actually running the Playwright walk, which
remains unexecuted in this environment for the same reason as every other
spec in this file.

### Changed

- **Rebranded to OathPath.** The application, its CLI, its database and its
  observability identity all carried names inherited from the upstream
  template. `APP_NAME` is now `OathPath`, which renames the web wordmark and
  page title, the OpenAPI document and reference page, all email templates and
  the CLI banner from one constant. The CLI binary is `oathpath` (config in
  `~/.oathpath/`, environment variables prefixed `OATHPATH_`), the default
  database is `oathpath`, and the OpenTelemetry service is `oathpath-api`.

### Fixed

- **The officer's own question could echo back through the phone's speaker
  and be graded as the applicant's answer, in an interview whose verdict
  feeds `passedCivics`, the debrief, and readiness history (issue #400).**
  `useRealtimeInterview.ts` had the identical hole issue #399 closed for
  spoken practice: nothing checked the realtime model's claimed
  `grade_answer` transcript against what the microphone actually heard, and
  full-duplex browser echo cancellation is best-effort and fails routinely
  at volume. This is worse here than on practice's own transport — a
  fabricated interview answer writes a `practice_attempts` row with
  `source: 'mock_interview'`, moves `mock_interviews.civicsAsked`/
  `civicsCorrect`, writes the `mock_interview_turns` row the debrief is
  built from, and feeds the readiness recompute `POST
  /api/interviews/{id}/complete` triggers — so a learner could be told they
  passed or failed a rehearsal on words they never said, and the number
  would persist in their readiness history. Both #399 guards are now ported
  unforked, reusing `lib/coachEcho.ts`'s `isLikelyCoachEcho`: (1) a
  `grade_answer` for a turn in which the provider transcribed no applicant
  speech at all is refused in the browser and never posted, arming only
  once the connection has proven this deployment transcribes input at all;
  (2) a `grade_answer` whose transcript is provenance-matched to the
  officer's own last completed utterance is refused the same way. Both are
  provenance checks, never grading ones — neither reads a transcript for
  meaning or forms a verdict, and the engine's grading ladder remains the
  only one. Two decisions specific to this transport: the echo guard is
  disarmed only in the `reading` phase, where the applicant is *supposed*
  to say the officer's own words back (an armed guard there would refuse
  precisely the right answers), and stays fully armed through `writing`,
  where the officer's sentence is dictated aloud and a genuine answer is
  always typed, never spoken back. The interview has no `repeat_question`
  tool, so both local refusals reuse `answer_outstanding`'s existing
  recovery wording ("Wait for the applicant to answer, then call
  grade_answer with what you heard.") rather than inventing a third
  phrasing, and stay silent to the applicant exactly as every other
  rejection on this transport already does. #399 already gave this
  transport input transcription at the mint and the shared
  `realtimeConnection.ts` deferred-`response.create` fix for free, with two
  side effects: the applicant's live transcript now renders during a
  spoken interview for the first time, and each spoken interview costs one
  extra billed transcription call on the learner's own key. See
  [`docs/specs/realtime-interview.md`](docs/specs/realtime-interview.md)
  §4.5, and the release checklist note at the top of this file — a manual
  pass against a real deployment and a real microphone is still owed
  before this ships, per that checklist.

- **The spoken coach never told a learner whether their answer was right —
  it narrated its own tool use instead (issue #403).** Over a 71-second
  device recording the coach took four answers and spoke zero verdicts,
  wrapping every turn in sentences nobody authored: "let me check that
  response against the sessions grading", "I'll hand you the next prompt
  from the session". The verdict was never missing from the data — the
  engine composed it (`composeSpokenTurn`, issue #351) and handed it to the
  model in the tool result's `say` — and the recording is its own tell: the
  model spoke `next_question`'s `say` faithfully throughout and summarised
  `grade_answer`'s away every time, because the session prompt said "say
  back what it returns" and nothing named the field, the order, or the
  requirement to speak all of it. Four changes: (1) the prompt now names
  `say`, says every line must be spoken in order and word for word, and
  states plainly that those lines are the only way a learner is told
  whether they were right; (2) a new prompt rule forbids narrating tool use
  and naming the application's own vocabulary at all, and states the
  positive half too — silence while waiting on a tool is correct; (3) every
  honoured tool result now carries an `instruction` of its own, a single
  constant identical for a right answer, a wrong one, a skip and a
  mishearing, because a refusal has carried one since #354 and an honoured
  result carried none; (4) a `grade_answer` naming the wrong question — or
  no question, which is what the first answer of every session produced,
  since the opening turn is served by the browser and never reaches the
  model as a tool result — is now refused with the outstanding question
  named, so the model re-sends silently instead of having the coach read
  the whole question out again.

- **#399's nothing-heard guard could refuse a real answer because the
  transcription had not arrived yet (issue #403).** The guard measured
  "did the learner say anything this turn" on
  `conversation.item.input_audio_transcription.*`, which is a separate,
  slower pipeline than the speech-to-speech model's own understanding of
  the audio — the model does not wait for it, so a `grade_answer` for a
  genuine answer can be decided while the answer to that question is still
  "not yet". `input_audio_buffer.speech_started`/`speech_stopped` — the
  turn detector's own events, raised the moment the microphone crosses the
  threshold — now count as the same evidence, so the guard is measuring an
  affirmative report that the learner spoke rather than the absence of a
  report that may simply be late. The protection is unchanged: some
  evidence is still required, the guard still fails open on a deployment
  that reports neither kind, and the coach-echo guard is untouched.

- **The question on screen and the question the coach spoke were different
  (issue #402).** Over the same recording the screen showed four questions
  the coach never asked, and the question the coach *did* ask first never
  appeared at all. Not a race: two independent draws. The page rendered
  `GET /api/practice/sessions/:id`'s `nextQuestion`, which
  `mastery/selector.ts` produces with real, unseeded randomness on every
  read — correct for the typed path, where the screen is the thing doing
  the asking, and wrong the moment a coach is speaking, because the engine
  serves and remembers its own draw and grades the answer against that one.
  The realtime tool result now carries the whole prompt-only question the
  coach was handed, the relay publishes it, and the voice surface renders
  it outright while a live session is running — not "the engine's, falling
  back to the page's", because falling back is precisely how a question
  nobody is asking gets on screen. The field is stripped before the result
  reaches the model: it already has the words and the id, and all the
  object would add is a question number a speech-to-speech model could read
  out loud. Nothing was ever mis-graded — the attempt was always recorded
  against the question the learner actually heard — but the screen was
  lying about which question was outstanding.

- **The coach's own voice could return through the microphone and be graded
  as the learner's answer, advancing questions faster than a learner could
  possibly respond (issue #399).** A live realtime practice session never
  asked the provider to transcribe the learner's own input audio, so nothing
  anywhere could compare what the model *claimed* it heard against what the
  microphone actually picked up — on a full-duplex, always-on microphone,
  browser echo cancellation is best-effort and fails routinely at volume,
  and a model that heard its own question return through the loudspeaker was
  believed all the way into a `practice_attempts` row for an answer nobody
  gave. Four fixes: (1) the mint now asks for input transcription
  (`openai.provider.ts`), restated in the browser's own `session.update` so
  the guard below arms whichever way the provider merges that update; (2) a
  `grade_answer` for a turn in which the provider transcribed no learner
  speech at all is refused in `useRealtimePractice.ts` and never posted —
  arming only once a connection has proven this deployment transcribes at
  all, so an older API behind a cached bundle fails open instead of
  refusing every answer of every session; (3) a new `lib/coachEcho.ts`
  refuses a `grade_answer` whose transcript is provenance-matched to the
  coach's own last utterance — an exact match at any length, or a run of at
  least five words in the coach's own order — while never touching a short
  genuine answer that happens to reuse the question's phrasing ("the
  president" inside "who is the president now"); (4) `response.create` is
  now queued rather than dropped while a response is already active,
  released on `response.done` with a bounded force-release valve, which
  also fixed a real regression along the way: a multi-line spoken opening
  was silently losing its second line to exactly this collision. The
  provider-error notice also now clears on the next honoured tool result
  instead of outliving the single turn it described. See
  `docs/specs/realtime-practice.md`, and the release checklist note at the
  top of this file — a manual pass against a real deployment and a real
  microphone is still owed before this ships, per that checklist.
- **The dev service worker was unreachable in the one environment this app
  is actually exercised in (issue #397).** `VITE_ENABLE_SW` was declared by
  issue #359 and read in two places, but never plumbed through
  `infra/compose`, so every containerised dev deployment took the disabled
  branch and served the self-destroying placeholder worker unconditionally:
  not installable, no offline shell, a dead update handshake, and nothing
  anywhere reporting a disabled feature. The flag, the opt-in, and the
  placeholder branch are now gone entirely — `/sw.js` always serves the real
  worker in development and the client registers it everywhere except the
  test suite, where MSW's `fetch` patch would otherwise compete with the
  worker's own cache. What makes always-on safe was already true of the
  worker's own policy (network-first navigations, no interception of
  `/src/**` or the HMR client, nothing under `/api` ever cached); the one
  gap — a fixed dev build id that would have let a container rebuild serve
  stale `public/` bytes forever — is closed by giving the dev build id a
  value volatile per process (`dev-${Date.now()}`), so every restart and
  rebuild retires the previous run's caches on `activate`.
- **Audio the learner pressed for made no sound on a phone (issue #389).**
  A mobile browser plays audio only through an element that was itself
  started during a user gesture, and every premium-voice surface here
  synthesizes over the network first — so the `<audio>` element built after
  that round trip was one the press never touched, and Android Chrome and
  iOS Safari rejected its `play()` silently. Issue #383 had fixed exactly
  one screen; the same bug was still live on **`/settings/coach`**, where
  the Hear button simply did nothing at all, and on **`QuestionAudio`'s
  press-to-play path**, where the browser-voice fall-through hid it — the
  learner heard the question in the free voice while paying their own key
  for the premium one. The ordering rule now has one home,
  `apps/web/src/lib/audioUnlock.ts`, used by all three call sites instead
  of being restated (or quietly undone) at each. `/settings/coach` also
  gains #383's second half: a refused `play()` no longer runs the same
  handler a finished sample runs, so "your browser blocked this" and "you
  have just heard it" are no longer the same silence. **`QuestionAudio`'s
  autoplay path deliberately primes nothing** — when
  `voice.readQuestionsAloud` starts a question with no tap there is no
  gesture to prime from, and the browser-voice fall-through is the correct
  design there (`docs/specs/voice.md` §1, §5.2).
- **The installer and the API's own documentation pointed at a different
  repository.** `install.sh` defaulted to cloning `marinoscar/EnterpriseAppBase`
  and the OpenAPI contact and external-docs URLs pointed there too. That
  repository is live and has diverged, so `curl … | bash` installed the
  upstream template rather than this application.
- **Several identifiers had opted out of their own derivation scheme**, so
  renaming the binary would have left them stale with no error: the deploy
  state filename and version field, the journal filename prefix and its
  retention regex, and the nginx vhost ownership marker. All now derive from
  `CLI_NAME`.
- `trace.decorator.ts` hardcoded the OpenTelemetry service name and ignored
  `OTEL_SERVICE_NAME`, so configuring the name renamed the service everywhere
  except that tracer's instrumentation scope.

### Removed

- `apps/web/test-results.json`, a committed Vitest report holding absolute
  paths from another machine and references to deleted test files.

## [1.1.0] - 2026-06-10

### Changed

- **Dependencies**: Major upgrade across the stack — React 19, MUI 9, react-router 7, Vite 8, TypeScript 6 (web); Prisma 7 (now using the `@prisma/adapter-pg` driver adapter), zod 4 + nestjs-zod 5, Jest 30, @fastify/multipart 10, and OpenTelemetry updates (API). class-validator bumped to 0.15.1. NestJS remains on 11.x. Runtime is Node.js 22.

### Removed

- **CLI Tool**: Removed the `tools/app` cross-platform CLI and the `tools/*` workspace.

## [1.0.1] - 2026-01-24

### Added

- **CLI Storage Commands**: New storage commands for interacting with the storage API
  - File upload support with `storage upload` command
  - Interactive storage menu for browsing and managing files
- **CLI Sync Feature**: Full folder synchronization functionality
  - Sync database layer with better-sqlite3 for local state tracking
  - Sync engine for bidirectional folder synchronization
  - Sync commands (`sync push`, `sync pull`, `sync status`)
  - Interactive sync menu for easy sync management
- **API Improvements**: DatabaseSeedException for better seed-related error handling

### Fixed

- **Authentication**: Enhanced OAuth callback error logging for easier debugging
- **Authentication**: Improved error handling for missing database seeds
- **API**: Fixed metadata casting to `Prisma.InputJsonValue` in processing service
- **API**: Fixed metadata casting to `Prisma.InputJsonValue` in objects service
- **API**: Handle unknown error types in S3 storage provider
- **CLI**: Use ESM import for `existsSync` in sync-database module
- **Tests**: Convert ISO strings to timestamps for date comparison

### Changed

- **Database**: Squashed migrations into single initial migration
- **Infrastructure**: Added AWS environment variables to compose file

### Dependencies

- Added AWS SDK dependencies for S3 storage provider
- Added better-sqlite3 and related dependencies for CLI sync feature

### Documentation

- Added storage and folder sync documentation to CLI README

## [1.0.0] - 2026-01-24

### Initial Release

Enterprise Application Foundation - A production-grade full-stack application foundation built with React, NestJS, and PostgreSQL.

### Features

#### Authentication
- Google OAuth 2.0 with JWT access tokens and refresh token rotation
- Short-lived access tokens (15 min default) with secure refresh rotation
- HttpOnly cookie storage for refresh tokens

#### Device Authorization (RFC 8628)
- Device Authorization Flow for CLI tools, mobile apps, and IoT devices
- Secure device code generation and polling
- Device session management and revocation

#### Authorization
- Role-Based Access Control (RBAC) with three roles:
  - **Admin**: Full access, manage users and system settings
  - **Contributor**: Standard capabilities, manage own settings
  - **Viewer**: Least privilege (default), manage own settings
- Flexible permission system for feature expansion

#### Access Control
- Email allowlist restricts application access to pre-authorized users
- Pending/Claimed status tracking for allowlist entries
- Initial admin bootstrap via `INITIAL_ADMIN_EMAIL` environment variable

#### User Management
- Admin interface for managing users and role assignments
- User activation/deactivation controls
- Allowlist management UI at `/admin/users`

#### Settings Framework
- System-wide settings with type-safe Zod schemas
- Per-user settings with validation
- JSONB storage in PostgreSQL

#### API
- RESTful API built with NestJS and Fastify (2-3x better performance than Express)
- Swagger/OpenAPI documentation at `/api/docs`
- Health check endpoints (liveness and readiness probes)
- Input validation on all endpoints

#### Frontend
- React 18 with TypeScript
- Material-UI (MUI) component library
- Theme support with responsive design
- Protected routes with role-based access
- Vite build tool with hot module replacement

#### CLI Tool
- Cross-platform CLI (`app`) for development and API management
- Device authorization flow for secure CLI authentication
- Interactive menu-driven mode and command-line interface
- Support for multiple server environments (local, staging, production)

#### Infrastructure
- Docker Compose configurations:
  - `base.compose.yml`: Core services (api, web, db, nginx)
  - `dev.compose.yml`: Development overrides with hot reload
  - `prod.compose.yml`: Production overrides with resource limits
  - `otel.compose.yml`: Observability stack
- Nginx reverse proxy for same-origin architecture
- PostgreSQL 16 with Prisma ORM
- Automated database migrations and seeding

#### Observability
- OpenTelemetry instrumentation for traces and metrics
- Uptrace integration for visualization (UI at localhost:14318)
- Pino structured logging
- OTEL Collector configuration included

#### Testing
- Backend: Jest + Supertest for unit and integration tests
- Frontend: Vitest + React Testing Library
- CI pipeline with GitHub Actions

### API Endpoints

#### Authentication
- `GET /api/auth/providers` - List enabled OAuth providers
- `GET /api/auth/google` - Initiate Google OAuth
- `GET /api/auth/google/callback` - OAuth callback
- `POST /api/auth/refresh` - Refresh access token
- `POST /api/auth/logout` - Logout and invalidate session
- `GET /api/auth/me` - Get current user

#### Device Authorization
- `POST /api/auth/device/code` - Generate device code
- `POST /api/auth/device/token` - Poll for authorization
- `GET /api/auth/device/sessions` - List device sessions
- `DELETE /api/auth/device/sessions/:id` - Revoke device session

#### Users (Admin only)
- `GET /api/users` - List users (paginated)
- `GET /api/users/:id` - Get user by ID
- `PATCH /api/users/:id` - Update user

#### Allowlist (Admin only)
- `GET /api/allowlist` - List allowlisted emails
- `POST /api/allowlist` - Add email to allowlist
- `DELETE /api/allowlist/:id` - Remove from allowlist

#### Settings
- `GET /api/user-settings` - Get user settings
- `PUT /api/user-settings` - Update user settings
- `GET /api/system-settings` - Get system settings
- `PUT /api/system-settings` - Update system settings (Admin)

#### Health
- `GET /api/health/live` - Liveness probe
- `GET /api/health/ready` - Readiness probe

### Technical Stack
- **Backend**: Node.js + TypeScript, NestJS with Fastify adapter
- **Frontend**: React + TypeScript, Material-UI (MUI)
- **Database**: PostgreSQL with Prisma ORM
- **Auth**: Passport strategies (Google OAuth)
- **Testing**: Jest, Supertest, Vitest, React Testing Library
- **Observability**: OpenTelemetry, Uptrace, Pino
- **Infrastructure**: Docker, Docker Compose, Nginx

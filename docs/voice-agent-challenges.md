# The voice agent, on a real phone: what went wrong, why, and what it taught us

This is a field guide, not a spec. `docs/specs/realtime-practice.md`,
`docs/specs/conversation-mode.md`, `docs/specs/voice-hands-free.md`,
`docs/specs/voice.md`, `docs/specs/coach-personality.md` and
`docs/specs/realtime-interview.md` describe the realtime voice path as
**designed**. This document is about the ten-day stretch (issues #383–#389,
then #399–#406) where the product owner tested that design on his own phone
and found where it disagreed with reality — what the recordings showed, what
the first diagnosis got wrong, what actually fixed it, and what is still
fragile. Where this document and a spec's own text describe the same fix in
different words, the spec is the more precise source; this document exists
for the argument and the evidence a spec strips out to stay durable.

Two readers, one document. If you are about to touch the realtime voice
path, the "Read this first" section below is the five things most likely to
bite you again — read it before you read anything else, including the code.
If you want to understand what is genuinely hard about this class of system,
read the whole thing in order: it is written chronologically within each
section because the sequence — hypothesis, evidence, correction — is itself
the lesson.

Every claim below names the issue, the PR, and the file. Where a root cause
is stated, the evidence that established it is stated next to it. Two device
recordings did almost all of the real work here — a 71-second one for
#402/#403 (2026-09-06 23:03) and a 77-second one for #385/#386/#387/#388
(the same evening) — and both are reproduced as tables rather than summarized,
because "the screen said X, the speaker said Y" is more convincing read as
data than as prose.

## Read this first

Five things a future change to this path is likeliest to get wrong again,
each expanded in its own section below:

1. **Never trust a value the model reports about the world outside the
   conversation** — what it heard, what question was asked, whether a tool
   succeeded — **without a structural check.** `grade_answer`'s `transcript`
   field was the model's own claim about what the microphone picked up, and
   for months nothing compared it to anything (#399, §A below). A prompt
   telling the model to behave correctly is not a check; it is a request the
   model can and does ignore under load, exactly like the two guards in §A
   exist to catch, and exactly like the narration bug in §A shows a model
   choosing to paraphrase a field it was told to speak verbatim.
2. **Never let the screen and the coach resolve the same fact
   independently.** The practice-session selector shuffles with real,
   unseeded randomness on every read (`mastery/selector.ts`'s own header
   says so as the reason it exists). If two code paths each ask "what
   question is next?" instead of one deciding and the other following, they
   *will* disagree, not might — see §B.
3. **`response.create` collisions are the ordinary case on this transport,
   not a race to shrug off.** A function call arrives *inside* a response;
   the tool result answering it is sent while that response is still
   running, virtually every time. Any code that assumes "no response is
   active when I want to send one" is wrong by default — see §C.
4. **Full duplex means the coach's own voice is real input audio.** Browser
   echo cancellation is best-effort and fails routinely on a phone at
   volume. Any guard reasoning about "did the learner say anything" must
   assume some of what arrives is the coach's own words returning, and must
   check provenance, not just presence — see §A and `coachEcho.ts`.
5. **A fake speech queue going empty is not the same fact as a spoken turn
   ending**, and jsdom cannot exercise a real device at all. Two bugs
   (#377/#403's drain bug, and the near-total absence of live-device
   verification across every PR in this document) both come from treating
   an observable proxy as the real thing — see §E.

## A. The deepest theme: the model is not the authority over what happened

Everything in this section is one argument, repeated at three layers of the
same stack: **the realtime model is a narrator, not a witness.** It is
extremely good at producing plausible, fluent language about what just
happened. It is not, and structurally cannot be made, a reliable source of
truth about what the microphone recorded, what the engine decided, or what
its own tool result contained — because every one of those is a fact
*outside* its own generation, and a language model reports facts outside
itself by paraphrase, the same mechanism whether the paraphrase happens to
be accurate or not.

### A.1 Grading the coach's own voice (#399)

A device recording (47s, Android Chrome, `oathpath.dev.marin.cr`,
2026-09-06 21:34) showed a live hands-free session advancing through three
questions in a way that made no sense if the learner were actually answering
them:

| t | State |
|---|---|
| ~08s | "The voice connection hit a snag" appears — and stays for the rest of the session |
| 10–34s | Q120 — status flips Speaking↔Listening repeatedly |
| 35–42s | Q76 — **7 seconds total** |
| 43s+ | Q86 |

Seven seconds is not enough time for the coach to ask a question, the
learner to answer, and the answer to be graded. The session was advancing
on its own.

The root cause (`apps/web/src/hooks/useRealtimePractice.ts`, before #401):
the hook received the provider's real transcription of the learner's own
microphone input
(`conversation.item.input_audio_transcription.*` → `onApplicantSpeech` →
`learnerSpeech`) and discarded it. The code's own comment, quoted verbatim
because it names the defect precisely: *"DISPLAY ONLY. It is not compared
to anything, not stored, and not sent anywhere — what reaches the engine is
the transcript the MODEL reports on its own `grade_answer` call."* And
`toPracticeToolCallInput` passed that model-reported string straight to the
grading engine: *"NOTHING IS INVENTED and nothing is inspected."*

So whatever the model said the learner said became a `practice_attempts`
row. When the model heard its own question returning through the phone's
speaker — full duplex means the microphone never closes — it graded that,
and the engine faithfully recorded an answer nobody gave.

**A second, worse finding surfaced underneath the first: input transcription
had never been enabled at the mint.** `runRealtimeSession`
(`apps/api/src/ai/providers/openai.provider.ts`) minted sessions with
`audio: { output: { voice } }` and no `audio.input.transcription`, so the
provider never emitted the transcription events the guard needed in the
first place. `onApplicantSpeech`/`setHeard` — the "heard" display the app
had shipped — had never fired in production. The fix the app needed was not
merely unused; it was **unavailable**. This is the sharpest instance of the
lesson in this whole document: a piece of client code can look completely
correct — narrowly typed, well-commented, unit-tested — while depending on
server behavior that was never actually configured, and nothing in the
client can tell the difference between "the provider sent nothing this
turn" and "the provider was never asked to send this at all."

The fix (PR #401), in order:

1. **`fix(api)` — request `audio.input.transcription`** at the mint, on
   `whisper-1`, chosen **for availability, not price**: a transcription
   model the deployment's account cannot reach turns a safety check into a
   mint failure that takes the whole spoken feature down, which is worse
   than the defect it replaces.
2. **`fix(web)` — restate the same request in the client's own
   `session.update`**, so the check does not depend on which of deep-merge
   or wholesale-replace the provider applies to the mint's settings — a
   belt-and-braces restatement specifically because the failure mode it
   guards against (a session that silently never transcribes) is invisible:
   no error, no rejected event.
3. **`fix(web)` — refuse `grade_answer` when the microphone heard nothing
   this turn** (`heardThisTurnRef` / `speechEvidenceSeenRef` in
   `useRealtimePractice.ts`). Nothing is posted, so no row is written; the
   model is asked to repeat the question. **Fails open** until the
   connection has observed transcription at least once, which also covers a
   deployment where transcription stops mid-session.
4. **`fix(web)` — refuse `grade_answer` whose transcript is the coach's own
   words** (`apps/web/src/lib/coachEcho.ts`, new).

### A.2 Two guards, and why neither is redundant

Item 3 and item 4 above look like the same idea from two angles. They are
not, and the distinction is the actual content of this subsection, not a
footnote to it.

`nothing_heard` (item 3) answers *"did the microphone pick up anything at
all this turn?"* It catches **fabrication from silence** — a model that
calls `grade_answer` with an invented transcript when no one spoke.

`coachEcho.ts` (item 4) answers a completely different question: *"are
these particular words the coach's own, coming back?"* **Echo IS real
input audio.** The provider transcribes it faithfully, because acoustically
it is exactly what it claims to be — sound that arrived at the microphone.
So the first guard cannot catch it: something was heard, just not something
the learner said. `coachEcho.ts`'s own header states this as the reason the
module exists at all: *"THIS IS A PROVENANCE CHECK, NOT A GRADING ONE... it
does not know what a right answer is... its entire output is a boolean
about where a string came from."*

The check is deliberately blunt — no fuzzy matching, no edit distance, no
library (`ECHO_MIN_CONTAINED_WORDS = 5` in the same file): refuse an exact
match at any length, or a run of five or more words appearing, in the
coach's own order, inside the coach's last utterance. Five, not fewer,
because a learner's genuine answer is occasionally a short run of words the
question also contains — "the president" inside "who is the president
now" — and refusing those would discard real evidence of a real (if wrong)
answer. The false-positive cases (an answer longer than or different from
the question; reordered words) got as much test coverage as the true
positives, because this is the one guard that can silently discard a
learner's *correct* answer, and a strict test suite is the only thing
standing between "blunt" and "wrong."

### A.3 The verdict the model composed and never spoke (#403)

Even with both guards landed and correctly exonerating themselves — see §F
for how that exoneration was established — the coach still never told a
learner whether an answer was right. The same 71-second recording used for
§B below transcribed every turn:

| t | Speaker | Words |
|---|---|---|
| 0–14s | coach | "What group of people was taken and sold as slaves?" |
| 14–17s | learner | "African Americans." |
| 17–22s | coach | *"Alright, let me check that response against the sessions grading."* |
| 22–27s | coach | "What group of people was taken and sold as slaves?" — **the same question again** |
| 27–30s | learner | "African Americans." |
| 30–35s | coach | *"Okay, let me check that answer with the session before we continue. Let's keep moving and I'll hand you the next prompt from the session."* |
| 35–42s | coach | "Thomas Jefferson is famous for many things. Name one." |
| 42–45s | learner | "He's an inventor." |
| 45–50s | coach | *"Let me check that with the sessions grading before we move on. Alright, let's move forward with the next prompt from the session."* |
| 50–57s | coach | "The American Revolution had many important events. Name one." |
| 57–59s | learner | "The Civil War." |
| 59–65s | coach | *"Let me check that answer with the session and see what it says. Okay, I'll continue with the next prompt from the session."* |
| 65–71s | coach | "James Madison is famous for many things. Name one." |

Four answers. Zero verdicts. "The Civil War" for *the American Revolution*
went uncorrected. And every turn narrates the application's own plumbing —
"the session," "the sessions grading," "the next prompt from the
session" — vocabulary nobody authored for a learner to hear.

Tracing end to end (PR #405) showed the mechanism was never broken:
`recordAttempt` → `composeSpokenTurn` (`apps/api/src/practice/spoken-turn.ts`)
composes an **unconditional** verdict line into `say`, and `say` is relayed
to the model verbatim. There is no path where an honoured `grade_answer`
returns a `say` without a verdict. **The recording is its own control**:
the model spoke `next_question`'s `say` verbatim four times in the same
session, and summarised `grade_answer`'s away four times. A question is
obviously the thing to say aloud; a graded result, to the model, was
apparently something to describe rather than recite. That asymmetry cannot
be a guard misfiring — a refused call returns no `say` at all — it is a
model **choosing which fields of a returned object to voice**, in a session
whose instructions said only "call `grade_answer` … and then say back what
it returns."

The fix (PR #405) works at two levels, because a prompt alone was judged
insufficient after this evidence:

- The verbatim instruction now **names the `say` field** explicitly,
  requires every line in order and word for word, and states outright that
  those lines are the only way a learner learns whether they were right.
- `PracticeRealtimeToolOk` gained an **`instruction` field**,
  `SPEAK_VERBATIM_INSTRUCTION` — one constant, **byte-identical** across a
  right answer, a wrong one, a skip, a mishearing, a repeat, and the end of
  the session. An instruction that varied by outcome would put a verdict
  back in a field the design's own proof (`realtime-practice.md` §4)
  declares must never carry one.
- The narration was forbidden by name: no announcing tool calls, no "let me
  check," no reference to "the session," "the application," or "the
  grading" — **and its positive half was stated too**, because a model told
  only what not to say fills the silence with something else: *while a tool
  call is in flight, saying nothing is correct.*

**The PR author's own note in #405 is worth reproducing rather than
paraphrasing, because it is the honest state of this fix today:** *"The
prompt fix is probabilistic and I want that on the record. The `instruction`
field and the named-`say` rule are strong, but nothing structurally forces
the model to speak the verdict — the engine cannot make it. If it still
paraphrases, the next lever is speaking `say` locally through `speakNudge`
on the grade turn... at the cost of double-speaking when the model does
comply."* Treat "the coach speaks the verdict" as **probabilistic, not
guaranteed**, until it has been watched fail (or hold) on a device over
enough sessions to say which. §G returns to this.

### A.4 The general lesson

**A prompt is an instruction, not a contract.** Every defect in this section
is, underneath its specific mechanics, the same failure: something the
model was *told* to do (speak verbatim, report only what it truly heard)
and something the model was structurally *prevented* from doing otherwise
were treated as equivalent, and they are not. The fixes that actually held —
the two guards, the byte-identical instruction constant, the `questionId`
now carried explicitly — all work by removing the model's ability to choose
wrong, not by asking it more clearly. The one fix that could not be made
structural (§A.3's verdict) is the one this document flags as still
probabilistic. When a future change touches this path, ask which category
the new behavior falls into before shipping it: *"the model will not do
this"* is a hope; *"the code cannot do this"* is the property this whole
epic has been converging on since #399.

## B. Two sources of truth: the screen and the coach asked different questions

The same 71-second recording (2026-09-06 23:03) that exposed the missing
verdict also exposed something that looked, at first, like the audio simply
running behind the display:

| t | ON SCREEN | SPOKEN BY THE COACH |
|---|---|---|
| 06–07s | Q86 "George Washington is famous for many things." | — |
| 08–34s | **Q79 "When was the Declaration of Independence adopted?"** | **"What group of people was taken and sold as slaves?"** (0–14s, again 22–27s) |
| 35–48s | **Q80 "The American Revolution had many important events. Name one."** | **"Thomas Jefferson is famous for many things. Name one."** (35–42s) |
| 49–63s | **Q83 "The Federalist Papers supported the passage of the U.S. Constitution…"** | **"The American Revolution had many important events. Name one."** (50–57s) |
| 64–72s | Q88 "James Madison is famous for many things. Name one." | "James Madison is famous for many things. Name one." (65–71s) |

At 50–57s the coach speaks the exact question the screen showed at
35–48s — the audio reads roughly one question behind the display — and
"What group of people was taken and sold as slaves?" never appears on
screen at any point in the recording.

**It was not a lag, and it was not a race. It was two independent random
draws of one fact.** `PracticeSessionPage` renders
`GET /api/practice/sessions/:id`'s `nextQuestion`, which resolves through
`mastery/selector.ts` → `shuffleRandomly` — real, unseeded randomness, **on
every read**, by design (`mastery/selector.ts`'s own header: "determinism
where it matters is bought by injecting the shuffle, not by seeding it").
The coach, meanwhile, speaks whatever `practice-realtime-asked.ts`'s ledger
remembers it was told to say. Two reads of the selector a second apart
legitimately name two different questions with nothing wrong in either
one — the screen and the loudspeaker disagree **by construction, not
occasionally**. The two-second Q86→Q79 flicker at 06–08s is the initial
load being immediately re-rolled by the page's first `refresh()`; "the
audio runs one question behind" was coincidence over a small candidate
pool, not an off-by-one anywhere.

This mattered for more than cosmetics: **the learner answers what they
hear**, and the engine grades against whatever question `grade_answer`
names. If the screen shows a different question than the one asked, either
the grading is against a question the learner never knowingly answered, or
the screen is misrepresenting what is outstanding. It turned out to be the
second — nothing was ever mis-graded, because the attempt is always
recorded against the ledger's question, which is the spoken one — but that
is not something the recording could tell you on its own, and it directly
undercuts an argument used earlier in this same investigation (see §F).

**The fix (PR #405) makes the ledger the single source of truth and the
screen a follower, not a second resolver.** `practice-realtime-asked.ts`
now stores the whole `PracticeQuestion`, not just an id and a prompt; an
honoured tool result carries it as `question`; and `PracticeSessionPage`
renders that value outright while a live session is running —
**deliberately not** `realtime.question ?? question`, a fallback which
would silently reintroduce the second, independent draw the moment the
ledger's value is momentarily absent. The field is stripped before reaching
the model (`forModel`): the model already has the words in `say` and the id
in `questionId`, and the only thing the full object would add is a question
*number*, which the system prompt is deliberately kept free of for the same
reason §A.4 states generally — a fact the model can voice on its own is a
fact it eventually will.

Full detail, including the compile-time proof that a `PracticeQuestion`
can never carry an answer (so widening the tool result by this field widens
nothing the grading boundary protects), is
[`docs/specs/realtime-practice.md`](specs/realtime-practice.md) §6.2 — read
that section rather than re-deriving this fix from the issue.

## C. Protocol, transport, and the picture that hid the protocol bug

Four bugs (#385, #386, #387, #388) were found on one 77-second device
recording the same evening, fixed together in one PR (#390), and are worth
reading as one story rather than four: **two of the four are UI bugs whose
actual damage was making the other two impossible to diagnose from the
screen.**

### C.1 Duplicate tool calls and the silent turn (#385)

The recording: Q1 was read aloud; **Q3 and Q5 were not** — 17.0s and 15.2s
of dead air with the question rendered on screen and the surface reading
"Listening." The question text rendering at all is the diagnostic:
`next_question` had **succeeded** and returned its lines, so the API half
worked. The model received the lines and stayed silent.

Root cause: `handleProviderEvent`
(`apps/web/src/services/realtimeConnection.ts`) treated **two different
provider events** as the same tool call, with no de-duplication —
`response.function_call_arguments.done` and a `function_call`-shaped
`response.output_item.done`. The second had been added under the theory
that it was *"the same call, on the shape some model versions emit
instead"* — but the current Realtime API emits **both**, for the same
call. Every tool call was relayed twice; `sendToolResult` therefore sent
`conversation.item.create` and `response.create` twice; the second
`response.create` landed on top of a response the first had already
started, and the provider rejected it with
`conversation_already_has_active_response`. Nothing recovered, because
`handleProviderEvent` had **no `type === 'error'` branch at all** — the
rejection was parsed, matched by nothing, and dropped with no trace
anywhere.

The fix: a per-connection `RealtimeTurnTracker`
(`realtimeConnection.ts`) is now a **required** third argument to the event
handler, so a future third event shape that skips the guard is a compile
error rather than a silently reintroduced duplicate. It claims each
`call_id` once, bounded at `TOOL_CALL_MEMORY = 64` (oldest evicted — the
duplicate is *adjacent*, milliseconds apart inside one response, so 64 is
dozens of turns of slack over a window that only ever needs to hold one). A
provider error is now surfaced through a **required** `onProviderError` on
the handlers interface — nothing is torn down, since most of these end one
turn and not the whole session, but a notice now reaches the learner and a
console line reaches a developer. And a bounded
`REALTIME_STALL_NUDGE_MS = 6000` nudge fires only if the model was handed a
tool result and never began a response at all, armed by `sendToolResult`
and cancelled by any event that precedes audible speech — deliberately
**excluding** `response.done`, because that event usually ends the response
that *emitted* the call in the first place, and counting it would cancel
the nudge for exactly the turn it exists to catch.

**This path is shared with the realtime mock interview** (`useRealtimeInterview`
relays through the identical function), which had the identical defect and
got its own test coverage in the same PR.

### C.2 The picture that hid it (#386)

Sampled every 2 seconds across the same 77-second recording: **38 of 38
frames read "Listening"** — including the roughly 30 seconds the coach was
audibly talking. `realtimeStageAsPhase`
(`apps/web/src/pages/PracticeSessionPage.tsx`) collapsed `live` →
`listening`, on the argument that a full-duplex session's microphone is
open for the whole of it, so it is always the learner's turn. **The premise
is true and the conclusion does not follow** — it conflates "the microphone
is open" with "the coach is currently speaking," and `useRealtimePractice`
had been publishing `isCoachSpeaking` the entire time; the surface simply
never read it.

This is the reason to read C.1 and C.2 together: **a turn where the coach
talked for seventeen seconds and a turn where it said nothing for seventeen
seconds were pixel-identical on screen.** A learner not looking at the
screen had no cue either way, and one who was looking was actively told
they were being listened to when nothing at all was happening. The state
visual's own bug is what turned #385 from "sometimes silent" into
"undiagnosable from the UI" — worth remembering the next time a realtime
surface's state indicator looks like a cosmetic concern.

The fix restores the distinction (barge-in itself is untouched — no gate
added, `TURN_DETECTION` unchanged): the picture now describes what the
**coach** is doing, and "Live. Talk to the coach whenever you are ready."
still sits beside it.

### C.3 The remounting timer that under-reported cost (#387)

Read directly off frames of the same recording: at 12s the elapsed timer
read 0:09; at 68s — nearly six times later in the session — it read 0:11.
The clock was resetting on nearly every question.

This is not decoration. `docs/specs/realtime-practice.md` (§10, cost
bounds) makes the elapsed timer a **cost guardrail** — realtime billing runs
on the learner's own AI key, by the minute, and the timer is the only thing
on screen telling them what they are spending. A clock that resets
systematically **under-reports spend**, and the longer the real session, the
worse the under-report gets.

The root cause was worse than the symptom suggested: `VoiceSurface` starts
its clock at component mount (`const startedAtRef = useRef(Date.now())`),
on the explicit assumption that the surface is entered once, by the session
starting, and left once, by it stopping — so there was assumed to be no
separate "session started at" fact that could disagree with the mount time.
The recording proved the assumption false: the surface was being
**remounted on every question** — `usePracticeSession.refresh()` sets
`isLoading` on every re-read, the page re-read on every question, and
`if (isLoading)` returned a spinner in place of the whole page. This was a
**full-screen flash mid-session**, not merely a clock artifact; the reset
timer was simply the most visible symptom of a bug that was throwing away
the entire mounted tree, including the surface's focus-on-entry effect,
every question.

The fix hardens on two levels: `isLoading && !detail` (a refresh with
something already rendered is a background read, not a loading state), and,
independently, the clock takes the session's real start and keeps the
earliest value it has ever seen — a re-mint does not reset it (a
reconnect is still one billed session); only an explicit retry does. A
source-reading test now pins the surface's `<section>` as the **same DOM
node** across a question change, which fails the moment the remount comes
back.

### C.4 `response.create` collisions are the ordinary case, not a race

Read alongside §A.1's fix list: item 4 there — never send `response.create`
while a response is active — deserves restating on its own, because the
instinct to treat it as an edge case is exactly backwards. `TURN_DETECTION`
sets `create_response: true`, so the **server** creates a response the
moment it detects the learner stopped speaking. `sendToolResult` **also**
sends an unconditional `response.create` after every tool result, because a
tool result genuinely does need one — the provider does not auto-continue
after a `function_call_output`, and without it the coach holds the answer
and says nothing. Neither sender is wrong to exist; **neither one checked
whether a response was already active**, and a function call routinely
arrives *inside* a response the server already started. The collision this
produces — `conversation_already_has_active_response` — is not a rare
interleaving to shrug off; it is the ordinary shape of a tool call on a
full-duplex, server-VAD-driven connection.

The fix is a single queue owned by the connection
(`realtimeConnection.ts`), not a lock that drops the second request:
a `response.create` that arrives while one is active is **queued and
released one entry per `response.done`**, never dropped — dropping would
reintroduce the exact silent-coach failure the explicit `response.create`
exists to prevent — with a 10-second valve against a `response.created`
that never resolves, and teardown emptying the queue so nothing survives
into the next session. Along the way this surfaced a bug nobody had
reported: `speakVerbatim` (the out-of-band call that delivers the opening
turn — see C.5) was **colliding with itself**, so a two-line opening turn
silently lost its second line. No shipped fixture happened to have a
multi-line opening, which is the only reason it went unnoticed until this
fix's own tests exercised the collision deliberately.

### C.5 The opening turn has no id, and every session's first answer pays for it

`#403`'s repeated question at 22–27s (§A.3's table) was, for a while,
misdiagnosed as the `nothing_heard` guard firing on a legitimate answer —
see §F for how that hypothesis was disproven. **The actual cause is a gap
in the protocol, not a false-positive guard:** the session's opening turn
is delivered out-of-band. `useRealtimePractice.openingTurn` relays
`repeat_question` and then `next_question` with `callId === null` — there
is no tool call to answer, so no tool result ever reaches the model, and
the first question arrives to it purely as words to speak
(`speakVerbatim`, an out-of-band `response.create` carrying `instructions`
only, not a conversation item). **The model is never given the first
question's id.** On the very first answer of every session it must name an
id it was never handed; it omits one or invents one; both outcomes land on
`wrong_question`, whose only recovery path was `repeat_question` — reading
the whole question aloud again, to a learner who had already answered it
correctly. The behavior is self-healing from the second question onward,
which is exactly what the rest of the #403 recording shows.

The fix does not close the underlying gap — an opening turn that opened in
silence while the model waited for a tool round trip was judged worse than
one recoverable retry — it makes the recovery **silent instead of spoken**:
`wrong_question`'s instruction now names the outstanding question id
explicitly, and the browser's own `malformed_arguments` refusal does the
same, so the model's retry succeeds on the id it should have had from the
start without the question being read aloud a second time.

## D. The browser, the device, and the physical world

Every defect in this section shares one shape: it is invisible on a laptop
and real on a phone, because the browser policies involved — autoplay
gating, permission one-shots, screen wake — exist specifically to protect a
mobile user from exactly the behavior a naive implementation produces. Four
issues (#383, #389, #384, #388) map to three mechanisms.

### D.1 Audio built after the `await` never gets to play (#383, #389)

Pressing **Preview** on `/settings/voice` produced no sound on Android
Chrome and said nothing about why — every button greyed out for the length
of the round trip and came back, and that was the entire observable
outcome. Three defects combined to produce total silence, and understanding
all three matters more than knowing which one to fix first, because two of
them hide the third's evidence:

1. **`play()` ran outside the user-activation window.** `previewVoice`
   constructed `new Audio(url)` and called `.play()` in the *continuation*
   after `await synthesizeSpeech(...)` — not inside the click handler
   itself. Mobile autoplay policy requires the element that calls `play()`
   to have been created or already played **during** the gesture; an
   element built after an `await` was never touched by the click at all, so
   `play()` is silently refused. Desktop has no such policy and worked
   fine, which is precisely why this shipped undetected.
2. **A blocked `play()` was routed to the same callback as a clip that
   finished.** `void Promise.resolve(audio.play()).catch(() => ctx.onEnd())`
   sent a rejected promise to `onEnd`, which reset state to `idle` —
   indistinguishable from success. The one state a learner most needed
   named was the one state that rendered nothing.
3. **The status region was below the fold.** With eleven voices on a
   phone screen, a single status box after the whole list sat several
   screens below the pressed button, so even messages that *did* render
   were never seen — and `preview.kind === 'preparing'` disabled all eleven
   buttons at once, pointing at no particular one.

The fix (PR #392) splits the click handler: `beginPreview` runs
synchronously in `onClick` and calls `acquireAndPrimeAudio` **before any
`await`**, priming one reused element with an inline silent-`data:` URI
(not a network request); `playSample` later only swaps `src`. A rejection
now renders in the pressed voice's own row: *"Your browser blocked the
sample from playing. Check that your phone is not muted, then press
Preview again."* Only the pressed button goes busy.

**Two more call sites had the identical shape** (issue #389, found while
fixing #383, deliberately left for its own issue rather than guessed at):
`CoachSettings.tsx`'s persona preview (same severity — silent, blocked
playback collapsed into the same callback as a finished clip) and
`QuestionAudio.tsx`'s premium question audio (lower severity, because it
already falls through to the browser's own `speechSynthesis` on failure —
so the learner still hears the question, just never in the premium voice
they are paying their own key for, and the failure is silent rather than
visible). Rather than fix two more copies of a subtle ordering rule, PR
#394 extracted it into `apps/web/src/lib/audioUnlock.ts` — the one module
`VoiceSettings.tsx`, `CoachSettings.tsx`, and `QuestionAudio.tsx` all now
call, so "the play path never primes" is structural (`acquireAudioElement`
is the only thing `playAudioSample` calls) rather than a convention to
remember at a fourth site.

**`QuestionAudio`'s autoplay path (`voice.readQuestionsAloud`) is
deliberately not primed, and must never be** — the design record in
`docs/specs/voice.md` §5.2 states why: when a question starts speaking with
no tap at all, there is no gesture to prime from, and falling through to
the browser's own voice is the correct behavior there, not a bug to
"fix" by finding a way around the browser's own rule. A test pins this by
asserting priming never appears outside the button's own handler.

Full detail, including two bugs the mutation-checked tests caught along the
way (a shared audio fake that misfired `onplay` on the *silent prime*
resolving, and a test that had been latently flaky by waiting on element
construction instead of playback), is in PR #394's own body and
`docs/specs/voice.md` §5.2 — not repeated here.

### D.2 A permission denial is effectively permanent (#384)

No bug here, but a constraint worth stating plainly because it shapes
everything else in this section: browsers penalize gestureless prompts
(Chrome's quieter UI auto-blocks origins that prompt without engagement,
Firefox requires a gesture outright, Safari has required one for
`Notification.requestPermission()` since 16.4, and `getUserMedia` on load
simply fails on iOS Safari), and **a denial cannot be undone by the
application** — only the user can, buried in browser site settings, and the
app cannot even detect that they have. A prompt spent on someone who has
not yet been given a reason to say yes loses that coin flip **forever** for
that person and that feature.

`/settings/device` (`apps/web/src/components/settings/DevicePermissions.tsx`)
exists to give a learner somewhere to grant microphone, notification, and
sound access **deliberately and early**, on an explicit click, rather than
mid-session — without taking the one-shot decision out of their hands by
prompting automatically. This rule generalizes past this one screen:
`CLAUDE.md`'s "Asking for a device permission" section states it as a
standing pattern, and any new microphone/notification/`AudioContext` call
site anywhere in `apps/web` inherits it.

### D.3 The wake lock was never requested on the realtime path (#388)

The phone screen turned off after the normal display timeout mid-session,
suspending it. The wake lock mechanism (`useWakeLock`, from E13) was not
broken — **it was never called on this path at all.** Its one call site
lived inside the request/response driver (`useConversationSession.ts`),
gated on *that driver's own phase*; on the realtime transport that driver
sits idle, its phase never leaves `idle`, and the lock is never acquired.
`useRealtimePractice` had zero wake-lock references.

The nastiest part was the affordance that should have revealed this: the
"this browser can't keep the screen awake" footnote was **explicitly
suppressed on the realtime path** — `!surfaceIsRealtime && …` — so the one
transport where the screen genuinely would not stay awake was the one
transport that said nothing about it.

`useWakeLock`'s own header states the stakes in terms worth quoting: *"The
screen going dark does not dim a session. It suspends it. … timers are
throttled to a crawl or stopped, `MediaRecorder` stops delivering, audio
output is cut. The loop does not slow down, it stops, mid-question, having
given no warning. From the learner's side that is identical to the app
crashing."* A realtime session is more exposed than the request/response
loop's, not less: it is a metered WebRTC connection on the learner's own
key, so a suspended tab can keep billing while nothing useful happens.

The fix moves the lock above both transports, keyed on
`voiceSessionIsUnderWay` — literally the same boolean that opens the voice
surface, so the two structurally cannot drift apart — with the driver's own
call site **removed**, not merely neutralized, so there is exactly one
`useWakeLock` call in the application (a source-reading test pins the
caller list). A fallback from realtime to the request/response loop
mid-session is one release and one re-acquire, never an overlap; a wake-lock
test fake counts *simultaneously held* sentinels rather than requests, and
peak concurrency is asserted to be 1 across that fallback.

**Two honest limits are worth stating rather than glossing over, because a
future "fix" might otherwise reintroduce a worse bug to chase them:**

- **The `<video>` fallback for browsers without the Wake Lock API was
  considered and rejected.** The deciding reason: a realtime session
  already holds a WebRTC `<audio>` element and possibly `speechSynthesis`;
  a third permanently-decoding element risks the audio route on exactly the
  mobile browsers this feature targets. A fix for a dark screen that can
  silence the coach is worse than the screen going dark.
- **The Wake Lock API only holds while the document is visible.** It is
  released automatically when the tab is hidden or the phone is locked. It
  keeps the screen on while the learner is looking at the page; it
  **cannot** make practice continue with the phone locked or the app
  backgrounded, the way a real phone call does. A test asserts the
  footnote's copy contains none of *background* / *locked* / *pocket* /
  *keeps running* / *like a call* — no positive copy ships for a guarantee
  the platform does not make.

## E. Testing a voice agent

There is no live provider, no real microphone, and no real browser anywhere
in this repository's CI. Every assertion about model behavior in every PR
referenced in this document is a **prompt-and-contract argument** — "the
instructions say X, the tool contract shapes Y" — never an observation of a
real session. That is stated outright in more than one PR body in this
series (#390, #405), and it is worth internalizing as a standing limit
rather than a gap to feel bad about: a suite that could observe a real
model's compliance with a prompt does not exist and, short of running a
live provider in CI, cannot.

### E.1 The speech-drain bug: an empty queue is not the same fact as a finished turn

A spoken turn is composed of several utterances — acknowledgement, verdict,
reason, accepted answer, coach line — spoken **one at a time**, each
awaited before the next is queued. A test helper that returns the first
time it observes an empty speech queue therefore returns **mid-turn**,
because the queue is legitimately empty for a moment between every pair of
lines — the gap spans a render, an effect, and a short chain of awaits
inside it (line N ending resolves the driver's `say`, which calls
`speech.speak`, which sets React state and remounts `QuestionAudio` under a
new `key`, whose own autoplay effect is what eventually queues line N+1).

**This is old and was invisible for a specific reason: before #403 the
coach said one line about an answer, so there were no gaps to mistake for
the end.** #403 made the turn carry the verdict, the reason, and the
accepted answer — three or four utterances where there had been one — and
every additional line is one more gap a single-observation drain can stop
in. It surfaced under a loaded full test-suite run and not in an isolated
file, for the ordinary reason that load changes when already-scheduled work
runs relative to `act`'s flush — it changes **which** gap gets observed,
not whether the gaps exist. It is the same class of defect PR #377 hit
earlier, where a single drain pass ended line 1 of a multi-line turn and
left the loop standing where it was.

The fix, `drainSpokenTurn` (`apps/web/src/__tests__/utils/fake-speech.ts`):
**quiet across several settles, not quiet once.** `QUIET_PASSES = 3`
consecutive empty observations, each separated by a real `settle()` (which
lets React's own work loop, its effects, and any zero-delay timer they
scheduled actually run — not a fixed sleep, and lengthening a sleep would
not have fixed this class of bug). One is the bug; two is one settle's
worth of evidence; three costs nothing measurable while covering a gap that
spans a render, an effect, and the effect's own awaits. `MAX_PASSES = 60` is
a safety net against a driver that queues forever, not an expected count —
a helper that spun here would hang the suite instead of failing it, and a
hung suite is one nobody can read.

### E.2 A flaky assertion is not a flaky feature (#393)

A separate, unrelated flake in `PracticePage.test.tsx` surfaced in this same
window — not a voice-path defect at all, but worth including because the
diagnosis matters: `await delay(50)` then `findByRole('status', …)` races a
real wall-clock timer against Testing Library's own polling interval, so on
a loaded machine the loading state can appear and disappear **between two
polls**. The fix replaces the timer with a promise the test itself
releases, so the response cannot have arrived before the test says it can;
the loading state's presence becomes a fact rather than a bet. Included
here as a reminder that a test suite growing (as this one did, from the
device-bug PRs landing in the same stretch) is often what tips an
already-fragile assertion over, not evidence the new code broke something.

### E.3 A guard that fails open passes every existing test silently

Every new guard in §A and §C — `nothing_heard`, `coachEcho`, the
`response.create` queue — shares a property worth stating as a rule for the
next one: **a guard that fails open by default will pass every test that
does not deliberately exercise the condition it exists to catch**, because
the pre-existing fixtures never emitted the event the guard reasons about
(no fixture in this codebase emitted `response.done` at all before #401's
tests started driving a real `response.created → response.done` lifecycle
on the existing harness, which is exactly why nothing went red on its own
when the collision bug shipped). A new guard needs tests that actively
produce the condition it refuses, not merely tests that exercise the happy
path around it — otherwise the guard's own test suite proves nothing about
whether the guard exists.

**Mutation-checking is what separates a real guard test from a decorative
one**, and every PR in this series records exactly this check: disable the
guard (or loosen its threshold, or revert the fix), confirm the *intended*
test — and only that test — goes red, then restore the change. From #401:
disabling `isLikelyCoachEcho` failed 6 tests; disabling only its
containment branch failed 3; loosening the five-word floor to `>5` failed
2 (the exact-boundary case); neutralizing the nothing-heard guard failed its
primary test and no others; disabling the response queue failed 5 of 6 of
its own tests. From #390: keying the wake lock back onto the conversation
driver failed 5 of 9 new tests; restoring the suppressed footnote failed 2.
A change that fails a *different* set of tests than the one it targets is
telling you your test coverage is entangled in a way worth understanding
before you trust it.

## F. Diagnosis discipline

This section is included because the corrections in it are, by the product
owner's own framing of this task, among the most valuable content here —
more valuable than the bugs themselves, because the pattern of *how* a wrong
hypothesis gets formed and disproven generalizes past this codebase.

**Every item below is a case where a plausible causal story, stated with
real confidence, turned out to be wrong once checked against the code or a
device.** None of the corrections were caught by review; all of them were
caught by either re-reading the actual source or by a second recording that
contradicted the first explanation.

- **"The `nothing_heard` guard is refusing legitimate answers, and that is
  why the first question got repeated."** This was the leading hypothesis
  when #403 was filed — *"most likely by #399's own `nothing_heard`
  guard... This is the prime suspect and it would be a regression I
  introduced."* It was wrong, and the way it was disproven is worth
  reading: `heardSomethingThisTurn()` is
  `heardThisTurnRef.current || !speechEvidenceSeenRef.current` — **both
  flags are set by the same event**. The only state in which the guard
  actually refuses is "a transcription arrived in some earlier turn, and
  none has arrived in this one" — which is **unreachable on a connection's
  first `grade_answer`**, because there is no earlier turn to have set
  either flag. Turn 1 fails open by construction, provably, from reading
  the two lines that define the guard. **The real cause was §C.5's missing
  question id** — a completely different mechanism the guard hypothesis had
  no way to surface, because the guard was never in the failure's path.
- **"Double TTS — the browser's own `speechSynthesis` is racing the
  realtime coach's audio."** Raised and checked (not merely assumed) while
  investigating #399: `PracticeSessionPage.tsx` returns the `VoiceSurface`
  early whenever a realtime session is under way, so the inline
  `QuestionAudio` component — the only thing that would call
  `speechSynthesis` — never mounts during a realtime session. Ruled out by
  reading the render branch, not by listening harder to a recording.
- **"The screen advanced through four questions in order, so the grades
  behind them must have been honoured."** This argument was used, while
  investigating #399, to help exonerate the guard logic — if the visible
  session progressed cleanly, presumably nothing was silently mis-grading.
  **It turned out to be worthless**, and not merely unproven: #402 showed
  the screen was drawing its own question independently of the ledger the
  coach and the grading engine actually used (§B). The screen advancing
  says nothing about what was graded underneath it, because the screen was
  never reading the same fact as the grading engine in the first place. The
  #405 PR body states this directly: *"that invalidates the counter-argument
  I used to exonerate #399's guard."*

**The general lesson, stated once rather than per-item:** in a system with
this many independently asynchronous parties — a speech-to-speech model
deciding what to say on its own schedule, a separate slower transcription
pipeline, a randomized question selector re-drawn on every read, a
provider-side response lifecycle with its own event ordering — a plausible
causal story is cheap to construct and easy to believe, because each one
individually sounds like it explains the evidence. The only thing that
actually settles a hypothesis here is reading the code path the story
depends on, line by line, or a second recording that the first story cannot
explain. Every correction above was made that way; none was made by feeling
more confident.

## G. What is still open, and what remains fragile

**#400 — the mock interview has the identical unvalidated-`grade_answer`
hole #399 fixed for practice, with worse consequences, and it is currently
being worked on.** `useRealtimeInterview.ts` passes the model's claimed
transcript straight through, exactly as `useRealtimePractice.ts` did before
#401 — type-narrowing only, nothing compared to anything. Because a spurious
interview attempt writes a `practice_attempts` row with `source:
mock_interview`, moves `mock_interviews.civics_asked`/`civics_correct` (the
tally behind `passed_civics`), and feeds the readiness recompute triggered
at `POST /api/interviews/{id}/complete`, an echoed or fabricated answer here
does not just corrupt a practice statistic — it can tell a learner they
passed or failed a rehearsal on words they never said, and the number
persists in their readiness history. #401 already carries the mint-level
transcription request and the `response.create` queue into the interview
path for free (both hooks share `realtimeConnection.ts`); what does **not**
carry over automatically is either guard, and porting them deliberately
raises interview-specific questions #399's own fix did not have to answer —
how a provenance check interacts with `withholdOfficerRef` and the English
dictation phase's rule of withholding the officer's own text, and what the
refusal should look like against a tool contract (`next_question` /
`grade_answer` / `end_phase`) that has no `repeat_question` equivalent to
fall back on. **Do not treat this as unstarted work** — check the current
state of #400 before assuming the hole is still open, rather than
re-deriving a fix from scratch.

**Whether the model reliably speaks the verdict is still probabilistic**,
not solved, per §A.3's direct quote from the fixing PR. The named next lever
if paraphrasing recurs is speaking `say` locally through `speakNudge` on the
grade turn — the same mechanism `endSession` already uses for the closing
line — accepting the cost of double-speaking on the sessions where the model
does comply. Anyone touching the realtime practice prompt should treat "the
coach announces right/wrong" as something to watch on a device, not
something the ship date already proved.

**`semantic_vad`'s emission of `input_audio_buffer.speech_started` could not
be confirmed against a live session** when §C.5's fix started reading VAD
events as evidence of speech. If that assumption is wrong on some
deployment, the consequence is stated plainly rather than hidden: the guard
silently reverts to transcription-only evidence — no regression, but also
none of the benefit that VAD's earlier timing was meant to buy.

**`unfiltered`'s reaction bank — 525 of the 648 total lines added by #352 —
has never been read end to end by a human.** `reaction-lines.ts`'s own
header states this as an attestation, not a reassurance: every line was
written and self-reviewed by an AI agent against `COACH_INVARIANT_FLOOR`,
which the same header calls *"worth something and NOT an independent
review."* PR #406 put more of this copy in front of learners' ears (the
persona now reaches both practice transports, including the session's
closing line) without changing that fact. A human read is recommended
before this reaches a public release.

**Device verification is still the only way to confirm most of the claims
in this document actually hold.** Nearly every PR referenced here — #390,
#392, #394, #401, #405, #406 — states in its own testing section that the
fix is verified against fakes and jsdom only, and explicitly flags what a
real Android Chrome or iOS Safari session would need to confirm: that
`play()` actually starts audibly, that a WebRTC connection actually
survives a fallback, that a two-line closing turn is actually spoken in
full. Treat every "fixed" claim in sections A–D as "fixed against the
contract, pending a device check" until someone has watched it work on a
phone — the entire discovery process this document describes started
because that check was missing the first time.

## Where the design lives, and where this document stops

This document does not restate the intended design of any mechanism it
discusses — it exists to record where reality disagreed with it, and how.
For the design itself, read:

- [`docs/specs/realtime-practice.md`](specs/realtime-practice.md) — the
  realtime practice transport this document's §A, §B, §C and most of §G
  concern; §6.1/§6.2 carry the same #402/#403 amendments in the spec's own
  voice, §11 the echo-suppression design §A.2 summarizes, and §4 the
  four-mechanism proof that an invented verdict is structurally impossible
  on the grading side (as distinct from §A.3's spoken side, which is not).
- [`docs/specs/realtime-interview.md`](specs/realtime-interview.md) — the
  realtime mock interview transport #400 (§G) concerns, and the manual
  device-verification checklist referenced by `CHANGELOG.md`'s release
  note for any change touching this code.
- [`docs/specs/conversation-mode.md`](specs/conversation-mode.md) — the
  request/response transport referenced throughout §E and §D.3.
- [`docs/specs/voice-hands-free.md`](specs/voice-hands-free.md) and
  [`docs/specs/voice.md`](specs/voice.md) — the degradation ladder, the
  device-permission pattern (§D.2) and the audio-unlock pattern (§D.1) in
  full, at §5.1 and §5.2 respectively.
- [`docs/specs/coach-personality.md`](specs/coach-personality.md) — the
  persona mechanism §A.3 and §G's `unfiltered` note touch, including §10's
  list of surfaces the persona is deliberately excluded from.

## Issue and PR index

| Issue | What | PR | Section |
|---|---|---|---|
| [#383](https://github.com/marinoscar/oathpath/issues/383) | Voice preview plays no sound on mobile | [#392](https://github.com/marinoscar/oathpath/pull/392) | D.1 |
| [#384](https://github.com/marinoscar/oathpath/issues/384) | Device & permissions settings screen | [#391](https://github.com/marinoscar/oathpath/pull/391) | D.2 |
| [#385](https://github.com/marinoscar/oathpath/issues/385) | Duplicate tool call relay, silent turns | [#390](https://github.com/marinoscar/oathpath/pull/390) | C.1 |
| [#386](https://github.com/marinoscar/oathpath/issues/386) | State visual always reads "Listening" | [#390](https://github.com/marinoscar/oathpath/pull/390) | C.2 |
| [#387](https://github.com/marinoscar/oathpath/issues/387) | Elapsed timer resets via remount | [#390](https://github.com/marinoscar/oathpath/pull/390) | C.3 |
| [#388](https://github.com/marinoscar/oathpath/issues/388) | Wake lock never requested on realtime | [#390](https://github.com/marinoscar/oathpath/pull/390) | D.3 |
| [#389](https://github.com/marinoscar/oathpath/issues/389) | Coach preview / question audio, same await-ordering bug | [#394](https://github.com/marinoscar/oathpath/pull/394) | D.1 |
| [#399](https://github.com/marinoscar/oathpath/issues/399) | Spoken practice grades the coach's own voice | [#401](https://github.com/marinoscar/oathpath/pull/401) | A.1, A.2, C.4 |
| [#400](https://github.com/marinoscar/oathpath/issues/400) | Same hole in the mock interview — **in progress** | — | G |
| [#402](https://github.com/marinoscar/oathpath/issues/402) | Screen and coach ask different questions | [#405](https://github.com/marinoscar/oathpath/pull/405) | B |
| [#403](https://github.com/marinoscar/oathpath/issues/403) | Coach never speaks the verdict; narrates plumbing | [#405](https://github.com/marinoscar/oathpath/pull/405) | A.3, C.5 |
| [#404](https://github.com/marinoscar/oathpath/issues/404) | Coach persona missing from spoken practice | [#406](https://github.com/marinoscar/oathpath/pull/406) | G |
| — | Speech-drain helper (earlier instance) | [#377](https://github.com/marinoscar/oathpath/pull/377) | E.1 |
| — | Practice-queue test flake | [#393](https://github.com/marinoscar/oathpath/pull/393) | E.2 |

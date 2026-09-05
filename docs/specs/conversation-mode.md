# Design Spec: Conversation mode — hands-free spoken practice (E13, epic #304)

This is the durable design for E13. Read `docs/specs/voice.md` and
`docs/specs/voice-hands-free.md` first; this document extends their
contracts rather than restating them, and assumes E9's audio-capture and
playback foundation and E12's auto-submit default exactly as they already
exist. Nothing here touches the realtime transport (`docs/specs/realtime-interview.md`)
at all — conversation mode is built entirely on the request/response speech
surface E9 shipped and E12 made the default.

Today, spoken practice is per-question and hand-driven: even after E12, the
loop costs four deliberate hand actions per question (pick Speak, press
play on the question, hold the mic while answering, tap Next). `VISION.md`
names the gap in its own words: the learner should feel like they are
"speaking with a patient human coach, not operating a voice command
interface" (line 230), and should be able to "interrupt naturally" (line
226 — stated there specifically for realtime conversations, and extended
here, deliberately, to barge-in over request/response TTS playback, which
is the same user expectation applied to a different transport). E13 removes
the four-tap-per-question cost: a learner starts a session with **one
tap** and walks, while the app reads the question, hears the answer, grades
it, speaks the accepted answer, and moves on.

Source of truth for every claim below, verified by reading the files
rather than assumed from the epic text:

- `apps/web/src/pages/PracticeSessionPage.tsx` (`answerMode` state, line
  401, initialised to `'text'` on every mount and never persisted; the
  `QuestionAudio` mount, lines 1171-1187, which passes `premiumVoice`,
  `voice`, `rate` and `onPlayed` but no `autoPlay`; `hasUserGesture`, line
  450, set only inside `submitAttempt`, line 706-707) — §7 states precisely
  what changes here and what does not.
- `apps/web/src/components/voice/QuestionAudio.tsx` (full file; `onPlayed`,
  line 233, documented as firing "when audio starts, not when a button is
  pressed"; `autoPlay`, lines 232-251, already wired end to end — `false`
  by default, honoured at the effect on lines 484-488 — so bug 1 below is a
  **caller** gap, not a missing prop; the internal `utterance.onend` at line
  374 and `playBlob`'s `onEnd` at line 433 are both private to the
  component, which is bug 2) — §8 states both bugs against these exact
  lines.
- `apps/web/src/hooks/useAudioCapture.ts` (full file; `AudioCaptureProblemCode`,
  the closed six-value union, lines 71-83; the bare `getUserMedia({ audio:
  true })` call, line 388; `start`'s no-op guard,
  `if (recorderRef.current || streamRef.current) return;`, line 352) — §2
  and §9 build directly on this file, extending it rather than forking it.
- `apps/api/src/ai/ai.types.ts` (`ASR_CONFIDENCE_THRESHOLD = 0.6`, line
  606) — §3's "one named constant per file" rule cites this as the house
  model for a tunable that must never be an inline literal.
- `apps/api/src/common/schemas/user-settings-namespaces.schema.ts` (the
  `voice` namespace, lines 258-419, its own "CRITICAL: NO `.default()`
  ANYWHERE" file header, lines 34-38; `voiceSchema`, line 368;
  `voicePatchSchema`, line 395 — both currently six fields:
  `autoSubmitSpoken`, `preferPremiumVoice`, `preferredVoice`, `speechRate`,
  `readQuestionsAloud`, `readAnswersAloud`) — §6 adds a seventh,
  `conversationMode`, on the identical pattern.
- `apps/api/src/settings/user-settings/user-settings.service.ts`
  (`mergeVoice`, lines 457-507, the field-wise null-delete/value-set
  pattern `mergeStudy` and `mergeNavigation` already establish) — §6 adds
  one more field block to this method, on the identical shape as its six
  neighbours.
- `apps/web/src/hooks/useVoicePrefs.ts` (full file; `resolveVoicePreferences`,
  line 146; the `VoicePreferences` interface, lines 86-101; the "ABSENT
  MEANS THE BUILT-IN DEFAULT, AND A DEFAULT IS NEVER WRITTEN BACK" header,
  lines 10-24) — §6 adds one more resolved field and one more mirrored
  default constant, on the identical pattern.
- `apps/web/src/types/index.ts` (`VoiceSettings`, line 99;
  `VoiceSettingsPatch`, line 125, `{ [K in keyof VoiceSettings]?:
  VoiceSettings[K] | null }`) — §6's seventh field is added to both.
- `apps/web/src/components/settings/VoiceSettings.tsx` (`writeFor`, line
  128, the null-delete-restores-default reducer every switch on this page
  uses; the "Answering out loud" card, lines 327-364, holding the
  `autoSubmitSpoken` switch today) — §6 places the `conversationMode`
  switch in this existing card, reusing `writeFor` rather than local form
  state.
- `apps/api/prisma/schema.prisma` (`PracticeSession`, line 1369, carries no
  mode or voice column of any kind; `PracticeAttempt.inputMode`, line
  1443, `@default(typed)`, the per-row column) — §7 states precisely why
  the session-wide picker adds nothing here.
- `apps/api/src/practice/practice.service.ts` (`requireRetryTarget`, lines
  1153-1183 — a target must exist, must not itself already be a retry, and
  must not already have a retry pointing at it; three conditions enforcing
  "superseded once, never twice," which is what makes a retry budget of
  exactly one per question a fact this guard already holds server-side, not
  a client promise alone) — §5 and §10 rely on this unchanged.
- `docs/specs/voice.md` §1 (`textModelRoles()`/`systemReady`, the
  degradation rule this document's §10 restates only where a matrix row
  differs), §2 (browser `speechSynthesis` as the unconditional default —
  unweakened here), §3/§3.1/§3.2/§3.3 (confirm-before-grade, its E12
  amendment, supersession, and the relaxed one-attempt-per-question rule —
  all inherited unchanged), §5 (the section this document's own companion
  edit amends — see §7 below and the amendment itself), §8 (`transcript`,
  `asrConfidence`, `retryOfAttemptId` — read, never written to, by anything
  in this document), §9 (`POST /api/ai/speech/transcribe`/`synthesize`, the
  two endpoints this document's web-only work calls exactly as shipped),
  §10 (RBAC — §11 below follows without modification), §11 (`Decisions
  locked` — row 6, "Voice is always optional," is quoted directly in §7).
- `docs/specs/voice-hands-free.md` §1 (auto-submit as the default —
  conversation mode's `processing` state, §4 below, is this same
  mechanism, driven without a hand on the Submit button), §2
  (`recomputeMasteryForQuestion` — unmodified and untouched by this epic;
  §5 below states plainly that nothing here calls it differently), §5 (the
  `voice` namespace's six-field pattern this document's §6 extends to
  seven), §6 (the degradation matrix §10 below builds on rather than
  restates), §9 (`Decisions locked` row 1 — the amendment idiom this
  document's own companion edit to `voice.md` §5 follows).
- `VISION.md` lines 220-230 (the six voice requirements, quoted above and
  in §1, §4, §9 below).
- `ROADMAP.md` §3 (the epic table this document's own E13 row extends) and
  §9 (the Decision log — this document's companion `ROADMAP.md` edit adds
  the dated entry recording the `voice.md` §5 amendment).
- `CLAUDE.md`'s RBAC section (the reused-permissions argument §11 below
  restates in one paragraph rather than at length).

**Nothing described past this line exists yet.** `grep -rn
"conversationMode\|useVoiceActivity\|useConversationSession\|useWakeLock\|
earcons" apps/api/src apps/web/src` returns nothing except this document's
own citations above; `voiceSchema`/`voicePatchSchema` have six fields, not
seven; `useAudioCapture.ts` opens one stream per `start()` call, not one
per session; `QuestionAudio.tsx` has no `onFinished` prop and no `stop()`
handle. Every path cited above resolves today exactly as described; every
contract below is what this epic's child issues build *against*. A child
issue is free to find a better answer to a specific sub-problem as long as
it keeps the contracts this document promises to the pieces around it: no
API change (`Decisions locked` #6), the six named `AudioCaptureProblemCode`
cases unchanged, and `voice.md` §5's three preserved constraints (§7 below).

---

## 1. The slice, restated

**DB.** One field, `conversationMode: boolean`, on the *existing* `voice`
user-settings namespace — not a new namespace. Four files change, not the
eight a new namespace would touch (§6).

**API.** None. E12's server contract — auto-submit, the retry guard, the
audio cache — is sufficient as-is. If a child issue finds it needs an API
change, it stops and the epic is re-planned (`Decisions locked` #6).

**Web.** All of the work: a persistent microphone stream (§2), a calibrated
voice-activity detector (§3), a state machine that drives the loop end to
end (§4), synthesised earcons (§5), a wake lock (§8), the two live-bug
fixes (§8, restated from the epic), and the settings switch (§6).

## 2. One microphone stream per session, not per answer

E9's `useAudioCapture` opens a fresh `getUserMedia` stream on every
`start()` call and tears it down on `stop()` (lines 340-471) — correct for
per-question, hand-driven spoken practice, where a stream that outlives one
answer has nothing left to do. Conversation mode needs a stream that
outlives every answer in the session, for two reasons that do not apply to
the per-question case:

- **Barge-in needs the mic listening while the app is speaking.** The
  learner interrupting the question requires an already-open input path at
  the moment `speakingQuestion` starts (§4) — there is no time to request
  a device mid-interrupt.
- **Per-answer churn costs a device round-trip per question.** A fresh
  `getUserMedia` call is a real, user-visible latency and, on some
  browsers, a re-prompt risk; paying it once per session instead of once
  per question is the difference between a walk and a series of stops.

**The fix is an opt-in mode on `useAudioCapture`, not a fork of it.** The
hook's six named `AudioCaptureProblemCode` cases (lines 71-83), its
MIME-type picking, and its stale-hold guard (the `holdRef`/`isCurrent()`
mechanism, lines 349-362) all stay exactly where they are and apply
identically to a persistent stream — a device denial is a device denial
whether the stream lives for one answer or for a whole session, and a
consumer that already switches exhaustively over the six causes needs no
new case to handle this mode. What differs is only the stream's lifetime:
opened once, on entering Voice mode, kept alive across every
`speakingQuestion → listening → processing → speakingAnswer → advancing`
cycle (§4), and released only on Stop or an unrecoverable capture error.

**The bare `{ audio: true }` constraint (line 388) gains the three ordinary
echo/noise constraints** — `echoCancellation`, `noiseSuppression`,
`autoGainControl` — appropriate for a stream that stays open through the
app's own TTS playback, not merely through a learner's own recording
window.

**`MediaRecorder` starts only on detected speech onset, never during
playback.** The persistent stream and its permanent `AnalyserNode` (§3)
listen continuously, including while `speakingQuestion` is playing — that
is what makes barge-in detection possible at all — but `MediaRecorder`
itself is armed only once the VAD reports onset, in the `listening` state.
**This, not echo cancellation, is what structurally prevents the app from
transcribing its own TTS.** Echo cancellation reduces how much of the
device's own output bleeds into the input signal; it does not guarantee
zero bleed, and a `MediaRecorder` running continuously through playback
would be recording *some* fraction of the question being read, confidence
and correctness of the eventual transcript be damned. Gating recording on
onset instead means the recorder is simply not running while the only
audio in the room is the app's own voice — there is nothing to bleed into
a stream that has not started.

## 3. The calibrated VAD

**Calibrate, don't hard-code.** A fixed dB cutoff fails on a windy street —
exactly the setting this epic targets, per `VISION.md`'s framing of
accented, real-world speech recognition. On arming (entering Voice mode,
before the first question plays), the detector samples the ambient noise
floor for **~300 ms** over the `AnalyserNode` §2's persistent stream
already exposes, and sets the onset threshold **relative to that floor**
rather than to an absolute level. A quiet room and a noisy street each get
a threshold that means the same thing — "louder than what's already here"
— rather than the same raw number meaning two different things.

- **Onset window ~8 s.** If the learner never starts speaking within this
  window after `listening` begins, the driver treats it as a timeout, not
  a graded silence: a spoken nudge (§9) and a re-listen, never a recorded
  empty attempt.
- **Hangover ~1.5 s.** Once speech has started, ~1.5 s of sustained
  sub-threshold audio ends the turn and stops the recorder — long enough
  to survive an ordinary mid-sentence pause, short enough not to make the
  learner wait through dead air after they have finished.
- **Hard cap stays 120 s**, mirroring the server's own transcription
  duration cap (`docs/specs/voice.md` §9's "10 MB, 120 seconds").
  Matching the two caps means a recording the client ever allows to
  complete is a recording the server was always going to accept on length
  grounds, rather than one that the client permits and the server then
  rejects.
- **Barge-in is a second, stricter threshold**, armed **~500 ms into
  playback** (never from the first instant `speakingQuestion` starts — a
  learner has not yet had a chance to want to interrupt a question that
  has not finished its first half-second), requiring louder and more
  sustained speech than ordinary onset detection. This is the honest
  mitigation for a phone speaker outdoors, not a promise that barge-in is
  always intentional: making interruption deliberate — louder, longer —
  is what keeps ambient noise from cancelling every question read aloud.

**Every tunable is a named exported constant in one file**, never an
inline literal — the same rule `ASR_CONFIDENCE_THRESHOLD`
(`apps/api/src/ai/ai.types.ts`, line 606) already sets for the server side
of this codebase's confidence handling, reused here for the client side:
a value like "how many milliseconds of silence ends a turn" is a product
decision a reviewer should be able to find and change in one place, not a
number that could drift between two call sites that each typed `1500`.
`useVoiceActivity.ts` (§4) is that one file.

## 4. The state machine

Reproduced from epic #304 verbatim — this is the contract every hook in
this epic builds toward, not a paraphrase of it:

```
idle
 └─ Start tapped ──► arms autoplay, takes the wake lock, opens the stream
speakingQuestion    TTS plays; VAD armed for barge-in after ~500 ms
 ├─ TTS ends ───────────────────────────► listening
 └─ barge-in detected ─► cancel TTS ────► listening   (recorder starts here)
listening           onset window, then hangover; earcon on open
 └─ stop ───────────────────────────────► processing
processing          transcribe → auto-submit → grade; soft "working" pulse
 └─ graded ─────────────────────────────► speakingAnswer
speakingAnswer      the accepted answer (with E14, the reaction line first)
 ├─ correct ────────────────────────────► advancing
 └─ wrong/misheard AND no retry used ───► "say that again" ──► listening (retry)
advancing           short pause, then handleNext()
```

**Any tap — Stop, Type instead, Next — exits or pauses the loop
immediately.** The loop never holds the learner hostage: every state above
has a manual escape that does not wait for the state machine's own timers
or thresholds to fire first.

`useConversationSession.ts` owns this machine, as a sibling to
`PracticeSessionPage.tsx` rather than logic folded into it —
`PracticeSessionPage.tsx` is already 1,717 lines (this document's own
source list), and a state machine this shaped belongs in its own hook the
same way `useAudioCapture` and `useVoicePrefs` already are their own
hooks rather than inline `PracticeSessionPage` state.

**`processing` is E12's auto-submit, driven without a hand on Submit.**
Nothing about grading changes: the transcript that comes back from
`POST /api/ai/speech/transcribe` is submitted through the identical path
`autoSubmitSpoken: true` already drives (`docs/specs/voice-hands-free.md`
§1) — `transcript: heard`, `asrConfidence: result.confidence`, `inputMode:
'spoken'` — and grades through the identical ladder. Conversation mode is
a driver *on top of* that mechanism, not a second one: the same auto-submit
plumbing that lets a hands-on learner skip a tap is what lets a walking
learner skip it too.

## 5. Earcons: synthesised, not shipped as audio files

`OscillatorNode` through the `AudioContext` the VAD already needs (§3), not
a set of cached `.mp3`/`.ogg` files:

- a rising two-tone cue when `listening` opens;
- a falling two-tone cue when a turn is accepted ("got it");
- a soft, repeating pulse while `processing` runs.

**Why synthesise rather than ship files, stated plainly:** a synthesised
tone has no asset, makes no network request, has nothing to cache and no
first-play latency — it beats a cached audio file at that file's *own*
goal, because there is nothing to load in the first place. `lib/earcons.ts`
is ~20 lines; call sites take a **descriptor** (which cue, not a hard-coded
oscillator configuration), so a later swap to designed sounds — a real
audio asset replacing the synthesised tone — changes the implementation
inside `earcons.ts`, never the call sites that ask for "the listening cue"
today.

**The `processing` pulse matters more than it sounds.** The grade path can
include an AI grader call on a miss (`docs/specs/ai-evaluation.md`'s
dispatch door, reused unchanged here) — several seconds of silence during
that call is normal, and, hands-free with the phone in a pocket or a hand
at one's side, indistinguishable from a crash without an audible signal
that something is still happening.

## 6. The `voice.conversationMode` preference

**One field on the existing `voice` namespace — no new namespace, no
`.default()`, therefore no migration.** The four files, verified against
the real code rather than assumed from the epic text:

1. **`apps/api/src/common/schemas/user-settings-namespaces.schema.ts`** —
   `conversationMode: z.boolean().optional()` added to `voiceSchema` (line
   368) and, with `.nullable()`, to `voicePatchSchema` (line 395), plus a
   `DEFAULT_VOICE_CONVERSATION_MODE = false` constant beside the other six
   `DEFAULT_VOICE_*` constants (lines 297-345). **No `.default()`
   anywhere** — the file's own header rule (lines 34-38): absent must mean
   "use the built-in default, resolved at read time," never a value
   materialised into storage the first time a learner touches an unrelated
   preference. The namespace's own "Six independent scalar preferences"
   comment (line 262) becomes seven.
2. **`apps/api/src/settings/user-settings/user-settings.service.ts`** —
   one more `null → delete / value → set` block inside `mergeVoice` (lines
   457-507), on the identical shape as the six blocks already there for
   `autoSubmitSpoken`, `preferPremiumVoice`, `preferredVoice`,
   `speechRate`, `readQuestionsAloud`, `readAnswersAloud`.
3. **`apps/web/src/hooks/useVoicePrefs.ts`** — one more field on
   `VoicePreferences` (lines 86-101), one more `DEFAULT_VOICE_*` mirrored
   constant (matching the existing six, lines 54-80), and one more line in
   `resolveVoicePreferences` (line 146) resolving it with
   `resolveBoolean`.
4. **`apps/web/src/types/index.ts`** — `conversationMode?: boolean` added
   to `VoiceSettings` (line 99); `VoiceSettingsPatch` (line 125) needs no
   separate edit, because it is already a mapped type over every key of
   `VoiceSettings` — the seventh field is picked up automatically.

**Default `false`.** Unlike `autoSubmitSpoken` (which defaults `true`,
because the confirm step it replaces was optional friction most learners
do not need), conversation mode changes *what the session looks like on
screen and who holds the phone* — a learner who has never touched this
preference should land on the ordinary per-question flow, and opt into
walking mode deliberately, not be defaulted into a microphone that opens
itself the first time they start a session.

**The settings-page switch** lives in `apps/web/src/components/settings/VoiceSettings.tsx`'s
existing "Answering out loud" card (lines 327-364, currently holding only
the `autoSubmitSpoken` switch), bound with that file's own `writeFor(next,
DEFAULT)` null-delete reducer (line 128) — never local component state,
for the identical reason every other switch on that page already uses it:
a learner who toggles `conversationMode` off should fall back to the
built-in default the next time this file's own default changes, not to a
value frozen into their document the moment they touched the switch.

## 7. `voice.md` §5's amendment, summarised here for context

`docs/specs/voice.md` §5 previously stated the picker between voice and
text was per-question, "not a session-wide mode lock." This epic ships a
session-wide mode, so that sentence is formally amended — the amendment
itself lives in `voice.md` §5 (this document's companion edit), not
duplicated here in full. The three constraints the amendment preserves,
briefly, because every section above depends on them:

- **`Decisions locked` #6 — "Voice is always optional" — locks
  optionality, not the granularity of the picker.** A session-wide mode is
  still a choice the learner makes, still reversible, and still not the
  only way to answer.
- **No session-level flag is added to `practice_sessions`**
  (`schema.prisma` line 1369 carries no such column, and none is added by
  this epic). Conversation mode is client UI state plus the per-*user*
  `voice.conversationMode` preference (§6) — `PracticeAttempt.inputMode`
  (line 1443) stays the only per-row record of how a given attempt was
  answered, exactly as it already is for a hand-driven spoken attempt.
- **The text path ("Type instead") stays reachable on every question, at
  every phase of the loop** (§4's "any tap... exits or pauses the loop
  immediately").

## 8. Staying awake, and the platform constraint it does not fix

`navigator.wakeLock` is acquired on entering Voice mode and released on
exit (`useWakeLock.ts`, new). **This is a mitigation, stated as a PLATFORM
CONSTRAINT, not a defect this epic is failing to fully solve:** a phone
locked in a pocket — screen off, app backgrounded — suspends timers,
audio playback, and `MediaRecorder` alike, on every mobile browser this
product runs on. No web application escapes that suspension; the wake
lock's entire job is to keep the screen on and the tab foregrounded so the
suspension never triggers in the first place, not to make the loop survive
a locked screen it was never going to survive. `docs/runbooks/` should
state this plainly to an operator or a learner reading a "why did my
session stop" report, rather than let it be discovered as a bug.

**The two live bugs this epic fixes as a side effect**, both real on
`main` today and verified above rather than assumed from the epic text:

1. **`voice.readQuestionsAloud` is resolved but never read.**
   `resolveVoicePreferences` (`useVoicePrefs.ts`, line 146) resolves it
   correctly, and `QuestionAudio`'s `autoPlay` prop is fully wired end to
   end (`QuestionAudio.tsx`, lines 232-251, 484-488) — the missing piece is
   entirely at the call site: `PracticeSessionPage.tsx`'s `QuestionAudio`
   mount (lines 1171-1187) passes `premiumVoice`, `voice`, `rate` and
   `onPlayed`, but never `autoPlay`, so a learner who turned this
   preference on gets silence regardless. E13's `Text | Voice` control
   (§9) wires `autoPlay={readQuestionsAloud}` at that mount as part of
   landing the top-level control, closing the gap in the same commit
   rather than as a separate fix.
2. **`QuestionAudio` has no completion callback.** `onPlayed` (line 233)
   fires when playback **starts** ("fired when audio starts, not when a
   button is pressed" — the component's own doc comment). End-of-audio is
   private to the component: `utterance.onend` (line 374) for the browser
   path and `playBlob`'s `onEnd` (line 433) for the premium path, neither
   exposed. The "read the question, then now listen" chain the
   `speakingQuestion → listening` transition (§4) depends on has nothing
   to hang the transition on today. E13 adds an `onFinished` callback prop
   and a `stop()` handle (for barge-in, §2's cancel path) to
   `QuestionAudio`, firing `onFinished` from both `utterance.onend` and
   `playBlob`'s `onEnd` — the two paths that already exist internally,
   simply surfaced.

## 9. Edge cases the loop must survive, each spoken

A walking learner is not reading the screen — every one of these must be
**spoken**, not merely rendered:

- **Empty transcript.** `docs/specs/voice-hands-free.md` §1: never
  auto-submitted, on either setting. A VAD that stops on silence
  (hangover, §3) will produce these routinely — a learner who paused too
  long, or whose "onset" was a cough. Re-listen once with a spoken nudge
  ("I didn't catch that — go ahead"); never grade silence.
- **`failed` transcription** — a spoken "that didn't work, let's try
  again," then re-listen.
- **`unavailable`** — caught at Start (§10), never mid-walk. A learner
  already mid-session with `transcribe` bound does not discover it
  becoming unavailable partway through; the check that matters is the one
  gating entry into Voice mode at all.
- **The six named `AudioCaptureProblemCode` cases**
  (`useAudioCapture.ts`, lines 71-83) — `permission_denied`,
  `permission_dismissed`, `no_device`, `device_in_use`,
  `insecure_origin`, `unsupported`. The driver does not invent a seventh
  case or collapse the six into a generic failure; it exits the loop
  cleanly and speaks the same message text the hand-driven flow already
  renders for each, so a walking learner hears the specific, actionable
  reason rather than a generic "something went wrong."
- **A retry budget of exactly one per question**
  (`Decisions locked` #2, §304; `requireRetryTarget`,
  `practice.service.ts` lines 1153-1183, already enforces this
  server-side — a target that is itself already a retry, or that already
  has a retry pointing at it, is a `ConflictException`). The driver's own
  state machine (§4) offers the "say that again" retry edge at most once
  per question for the identical reason the server would refuse a second
  one: a failing microphone must not be able to trap a learner in a loop.
- **`start()` is a no-op while already recording**
  (`useAudioCapture.ts`, line 352:
  `if (recorderRef.current || streamRef.current) return;`). The driver
  respects this rather than fighting it — it never calls `start()`
  speculatively to "make sure" recording is running; it tracks its own
  `listening` state and calls `start()` exactly once per turn.

## 10. Degradation matrix

Built on `docs/specs/voice-hands-free.md` §6's matrix — the two roles that
matrix already covers (`transcribe`, `speak`) are not restated in full
here; only the row this epic actually changes is given below, because
conversation mode adds a *third* axis (the preference itself) on top of
the same two roles.

| `transcribe` | Conversation mode offerable? | Behaviour |
|---|---|---|
| Bound | Yes | The `Text \| Voice` control renders `Voice` as a real option; `voice.conversationMode` governs whether starting a session in Voice mode also arms the persistent-stream, one-tap loop (§4), or leaves the existing per-question hand-driven flow (`docs/specs/voice-hands-free.md` §1's default, `autoSubmitSpoken` still deciding whether each answer needs a manual submit within a single turn). |
| Unbound | **No — caught at Start, never mid-walk.** | `Decisions locked` #4 (§304): with `transcribe` unbound, Voice mode is not offerable at all — the `Text \| Voice` control does not render `Voice` as a choice (`docs/specs/voice.md` §1's "hidden, not disabled" rule, reused unchanged), so there is no state in which a learner starts walking and then discovers, mid-session, that the loop cannot record them. This is the same posture `voice-hands-free.md` §6's own unbound-`transcribe` row already takes for spoken practice generally, applied to the mode-selection moment specifically. |

`speak` unbound changes nothing about conversation mode's *availability* —
exactly as `voice-hands-free.md` §6 already states for the hand-driven
loop, the browser's own `speechSynthesis` reads every question and every
accepted answer at whatever `speechRate` the learner has set, so
`speakingQuestion` and `speakingAnswer` (§4) both still run; only the
premium-voice upgrade is absent, silently, per §2's "not a degraded state"
rule.

## 11. Cost

**STT is per-call on the learner's own key and is not cached** — only TTS
is, via the content-addressed cache #284 shipped
(`docs/specs/voice-hands-free.md` §4). A re-listen after a wrong or
low-confidence answer (§9's retry edge) means up to **two** transcription
calls for that one question. Worth stating in the runbook rather than
discovered from a bill: Conversation mode costs roughly **1-2× a typed
session's STT spend**, while its TTS is nearly free after the first
learner to hear a given civics question or answer has warmed the cache —
every learner after them, walking or not, reads the cached bytes.

## 12. RBAC

**Nothing new.** No permission string, no API route — this epic adds none
of either (`Decisions locked` #6, §304). Every mechanism conversation mode
drives — `POST /api/ai/speech/transcribe`, `POST /api/ai/speech/synthesize`,
`POST /api/practice/sessions/{id}/attempts` — is an existing, already-
`@Auth()`-with-no-permissions route, and no route accepts a user id: every
authenticated learner already practises with their own voice, on their
own key, and grades their own attempts, exactly as `CLAUDE.md`'s RBAC
section and `docs/specs/voice.md` §10 already state for the surfaces this
epic reuses without extending. There is no "walk while practising"
privilege in this product's authorization model, for the identical reason
there is no "use voice" one.

## 13. Decisions locked

All six, from epic #304, restated with the reasoning that makes each one
load-bearing rather than a preference:

| # | Decision | Reasoning |
|---|---|---|
| 1 | **Session-wide mode, and `voice.md` §5 is formally amended to allow it — not silently contradicted.** | A shipped session-wide mode next to a spec that still says "per-question, not a session-wide mode lock" is two sources of truth disagreeing about the same flow, the identical failure `ROADMAP.md` §1 forbids and E12 already set the amendment idiom for. §7. |
| 2 | **Retry budget is exactly one per question.** | A failing microphone, or a genuinely hard-to-transcribe accent, must not be able to trap a walking learner in an endless "say that again" loop — one retry is a real second chance without being an unbounded one. §9. |
| 3 | **Empty transcripts are never graded** (`voice-hands-free.md` §1, unchanged). | Auto-submitting silence would record an attempt for a question the learner never actually answered — the identical harm §1's own reasoning already names for the hand-driven case, unaffected by whether a hand or a VAD triggered the submit. §9. |
| 4 | **`transcribe` unbound ⇒ Voice mode is not offerable at all, caught at Start, never mid-walk.** | The alternative — discovering mid-session that recording cannot happen — is strictly worse than never offering the mode: a learner who has already committed to walking and talking has no good recovery from a loop that stops working under them. §10. |
| 5 | **Earcons are synthesised, not assets.** | No asset, no network request, nothing to cache, no first-play latency — a synthesised tone beats a cached audio file at the cached file's own goal, because there is nothing to load. §5. |
| 6 | **No API change.** A child issue that believes it needs one stops and the epic is re-planned. | E12's server contract (auto-submit, the retry guard, the content-addressed cache) already has every mechanism a hands-free driver needs; this epic is a **driver** on top of existing server behaviour, not a new server surface, and treating "I need a new endpoint" as a stop-and-replan signal keeps that boundary honest rather than eroding it one convenience change at a time. §1, §12. |

## 14. Rejected alternatives

| Alternative | Why it lost |
|---|---|
| **A fixed, hard-coded VAD threshold** | Fails on a windy street or in a noisy room — precisely the real-world setting this epic targets — because a single dB cutoff means something different in a quiet room than outdoors. Calibrating against a ~300 ms ambient sample (§3) makes the threshold mean the same thing ("louder than what's already here") regardless of the environment. §3. |
| **Opening a fresh `getUserMedia` stream per answer, as the hand-driven flow already does** | Reintroduces the exact per-answer device round-trip and re-prompt risk §2 exists to remove, and forecloses barge-in entirely — there is no mic open to detect an interruption against while the question is playing if the stream does not exist yet. §2. |
| **Recording continuously, relying on echo cancellation alone to keep the app's own TTS out of the transcript** | Echo cancellation reduces bleed; it does not guarantee zero bleed, and "reduces the chance of a wrong transcript" is a materially weaker guarantee than "the recorder was not running." Gating `MediaRecorder` on VAD onset (§2) is structural, not probabilistic. §2. |
| **Shipping earcons as cached audio files** | A cached file still has a network request the first time, a cache-miss latency, and an asset to version — a synthesised `OscillatorNode` tone has none of the three, and is simpler code besides. §5. |
| **A single, universal VAD threshold for both onset and barge-in** | Barge-in needs to be a *deliberate* interrupt, not an accidental one triggered by the same sensitivity that (correctly) catches a soft "the President" at the start of a turn. A second, stricter threshold, armed only after the question has had ~500 ms to establish itself, is the honest mitigation for a phone speaker outdoors; a shared threshold would either miss real interruptions or fire on ambient noise during every question. §3. |
| **Defaulting `conversationMode` to `true`** | Unlike `autoSubmitSpoken` (a default that only changes *when* grading happens), this preference changes what the whole session looks like and who is expected to be holding the phone — a learner who has never opted in should not find their microphone opening itself the first time they start a session. §6. |
| **A session-level `mode` column on `practice_sessions`** | Would let the mode of a session disagree with the per-row `PracticeAttempt.inputMode` a learner's actual answering behaviour already records faithfully, and would need a migration and a reconciliation rule for a mid-session switch to Text that E9's per-row column already handles for free. §7. |
| **A `useConversationSession` state machine folded into `PracticeSessionPage.tsx` directly** | The page is already 1,717 lines; a state machine with six named states and multiple timer-driven transitions is exactly the kind of self-contained logic `useAudioCapture` and `useVoicePrefs` already demonstrate belongs in its own hook, testable against synthetic inputs without mounting the whole page. §4. |

## 15. Out of scope (deliberately)

- **The realtime transport (E11).** Conversation mode is built on the
  request/response speech surface E9 shipped and E12 made the default; a
  realtime-backed hands-free mode is a different transport with its own
  session lifecycle (`docs/specs/realtime-interview.md`) and a later
  epic's scope, not this one's.
- **Background or screen-locked operation.** §8 names this as a platform
  constraint the wake lock mitigates, not one this epic fixes — a phone
  locked in a pocket suspends timers, audio, and `MediaRecorder` on every
  mobile browser this product runs on, and no web application escapes
  that.
- **Conversation mode for the English reading and writing segments, and
  for the mock interview.** This epic's slice is practice sessions only —
  `/practice/reading`, `/practice/writing`, and `/interviews/*` are
  untouched by anything in this document.
- **Server-side enforcement of the `!revealed` gate on corrections.**
  Still client-only after E12, and unchanged here: `requireRetryTarget`
  (`practice.service.ts`, lines 1153-1183) has no opinion on whether the
  accepted answer has already been revealed to the learner before a retry
  is offered. Carried forward as a known follow-up, not fixed by this
  epic.

## 16. Testing limits, stated honestly

**VAD calibration and barge-in detection cannot be exercised against real
audio in CI.** There is no microphone, no ambient noise, and no human
voice in a CI runner — every claim in §3 about how the calibrated
threshold behaves against a windy street is a claim about physical audio
this repository's automated suites structurally cannot reproduce.

**What CI *can* verify: the state machine, driven by synthetic levels.**
`useVoiceActivity`'s onset/hangover/barge-in logic is a pure function of an
`AnalyserNode`-shaped level stream and the calibrated threshold it
computes — a unit test can feed it a synthetic sequence of levels (a flat
ambient floor, then a spike, then a return to floor) and assert the
correct state transitions fire at the correct offsets, exactly as the
epic's own acceptance criteria describe doing against
`AI_PROVIDER_FAKE=true` and "a synthetic level source for the VAD." That
is a real, valuable test of the *logic*; it is not a test of whether a
real ambient-floor calibration actually copes with a real windy street.

**The acoustic behaviour itself belongs in the manual checklist**, where
`docs/specs/voice.md` §11's own reasoning already places spoken practice
generally: some claims in a voice-driven product can only be verified by a
person speaking to a real device in a real environment, and pretending
otherwise — asserting a synthetic-level unit test proves the calibration
works outdoors — would be a false confidence a reviewer should not be
given. The manual checklist this epic's own tests-and-docs child issues
add should include, at minimum: starting a session outdoors or with
background noise present, deliberately interrupting a question mid-read,
and letting the onset window lapse with no answer at all.

## 17. Suggested phasing (non-binding)

Not the actual issue list — the epic owns that — but the dependency order
the modules impose:

1. This document, and the `voice.md` §5 / `ROADMAP.md` §9 amendment (this
   document's companion edits) — no dependency on anything else here.
2. The `voice.conversationMode` field (§6's four-file change) — no
   dependency on anything else in this list.
3. `useAudioCapture.ts`'s persistent-stream mode and the three added
   media constraints (§2) — depends on nothing above.
4. `useVoiceActivity.ts` (§3) — depends on 3 for the `AnalyserNode` a
   persistent stream exposes.
5. `earcons.ts` and `useWakeLock.ts` (§5, §8) — depend on nothing above;
   independently landable in parallel with 3-4.
6. `QuestionAudio.tsx`'s `onFinished`/`stop()` addition and the
   `readQuestionsAloud` autoPlay wiring (§8's two bug fixes) — depends on
   nothing above; independently landable.
7. `useConversationSession.ts` (§4) — depends on 3, 4, 5, 6.
8. The top-level `Text | Voice` control, the Start tap, and the settings
   switch (§6, §9) — depends on 2 and 7.
9. Tests: unit coverage for the state machine against synthetic levels,
   and the one-tap Playwright journey extending `tests/e2e/specs/voice.spec.ts`
   (§16) — depends on 7, 8.
10. Documentation: `CLAUDE.md` gains a pointer to this document;
    `docs/runbooks/configuring-voice.md` gains the foreground-only wake-
    lock limit and the cost note (§8, §11); the learner-facing page names
    the one-tap flow.

/**
 * The realtime practice relay decides nothing — read from the source itself.
 *
 * Issue #355, epic #345 / E15.
 *
 * =============================================================================
 * WHY A SOURCE-READING TEST, WHEN THE BEHAVIOUR SUITE ALREADY EXISTS
 * =============================================================================
 *
 * `useRealtimePractice.test.tsx` proves the relay behaves correctly against the
 * fixtures it is given. It cannot prove the ABSENCE of a second opinion, and
 * the absence is the property this epic is organised around: a hook that
 * quietly counted correct answers, compared a transcript to an accepted answer,
 * or held a pass mark would pass every behavioural test written against a
 * fixture that happens to agree with it, and would be wrong on the day it
 * disagreed — on a live, per-minute-billing connection, in front of a learner.
 *
 * `docs/specs/realtime-practice.md` §12 asks for exactly this kind of check on
 * the API side ("a source-reading test enforces §5's dependency direction and
 * §4's absences"); this is its client half, and issue #355's first acceptance
 * criterion by name.
 *
 * COMMENTS AND JSDOC ARE STRIPPED BEFORE ANY ASSERTION RUNS. The file is
 * heavily documented precisely because these rules are easy to break by
 * accident, and a test that failed on the word "answered" inside a sentence
 * explaining why nothing is compared would teach exactly the wrong lesson.
 *
 * =============================================================================
 * ISSUE #399 MOVED ONE COMPARISON OUT OF THIS FILE'S SCOPE, DELIBERATELY
 * =============================================================================
 *
 * `lib/coachEcho.ts`'s `isLikelyCoachEcho` reads two transcripts and decides
 * whether one is the other coming back through a loudspeaker — a word-level
 * comparison that would, on its face, look exactly like the "compares
 * nothing" test just below forbids. It is not a second opinion on grading
 * (its own header argues why at length), but the decision worth recording
 * explicitly is where its CONTRACT is tested.
 *
 * IT IS NOT ADDED HERE. The invariant this file polices was never "no file
 * anywhere compares two strings" — it is "this hook, the one thing every
 * tool call on a live connection passes through, decides nothing about
 * correctness itself". That invariant survives #399 exactly as stated: the
 * hook still only ASKS `isLikelyCoachEcho` a yes/no question and acts on the
 * answer, which is what `useRealtimePractice.test.tsx`'s integration tests
 * confirm. Reading `coachEcho.ts`'s source from THIS file would conflate two
 * modules' contracts in one test, which is the opposite of what a
 * source-reading test is for — the point is to bind one file's promises to
 * that file, not to grow into a registry of every absence anywhere in the
 * feature.
 *
 * `coachEcho.test.ts` carries the equivalent contract for its OWN file: a
 * "this module is a provenance check, not a grading one" section that reads
 * `coachEcho.ts`'s source the same way this file reads `useRealtimePractice.ts`'s
 * — one door, one file, one test, the same shape `personas.spec.ts` and
 * `reaction-lines.spec.ts` already keep separate on the coach-persona axis.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));

/** The hook's own source, with every comment removed. Code only. */
function hookCode(): string {
  return readFileSync(resolve(here, '../..', 'hooks/useRealtimePractice.ts'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

describe('the realtime practice hook is a relay: it decides nothing', () => {
  it('reads no answer, no verdict, no score and no pass mark', () => {
    const code = hookCode();

    // Every field name a client-side verdict would have to travel in. None of
    // them exists on `PracticeRealtimeToolOk` — the API carries a compile-time
    // proof of that — so a match here means somebody added a second source of
    // truth on the way to the screen.
    const forbidden: RegExp[] = [
      /\bacceptedAnswers\b/,
      /\.outcome\b/,
      /\.correct\b/,
      /\bisCorrect\b/,
      /\.score\b/,
      /\.passed\b/,
      /\bpassMark\b/i,
      /\bPASS_THRESHOLD\b/,
      /\bfailureCause\b/,
      /\bgradeDeterministic\b/,
      /\.revealed\b/,
      /\basrConfidence\b/,
    ];

    for (const pattern of forbidden) {
      expect(code, `${pattern} must not appear in the relay`).not.toMatch(pattern);
    }
  });

  it('compares nothing — no normalisation, no matching, no equality on words', () => {
    const code = hookCode();

    // The grading ladder is `PracticeService.recordAttempt`'s, on the server,
    // and `realtime-practice.md` §5's single-`recordAttempt` rule is what keeps
    // it the only one. These are the shapes a client-side second ladder would
    // start as — a lowercase here, a trim there — long before anybody would
    // call it grading.
    const forbidden: RegExp[] = [
      /\.toLowerCase\(/,
      /\.normalize\(/,
      /localeCompare/,
      /\btranscript\b\s*===/,
      /===\s*\btranscript\b/,
      /\.includes\(\s*transcript/,
    ];

    for (const pattern of forbidden) {
      expect(code, `${pattern} is a comparison this relay must not make`).not.toMatch(
        pattern,
      );
    }
  });

  it('counts nothing about the session — the only counter is the reconnect bound', () => {
    const code = hookCode();

    // Not "there is no arithmetic" — there is exactly one piece, and it is
    // about the TRANSPORT (how many times a dropped connection has been
    // re-minted), never about the session. Anything else incrementing would be
    // a tally of questions, answers or correct answers kept in a browser, which
    // is the thing the summary screen and the readiness engine would then be
    // free to disagree with.
    const increments = code.match(/[^\s;{}()]+\s*\+=\s*1/g) ?? [];
    expect(increments.length).toBeGreaterThan(0);
    for (const increment of increments) {
      expect(increment).toMatch(/reconnectsRef\.current/);
    }

    expect(code).not.toMatch(/\bcorrectCount\b/);
    expect(code).not.toMatch(/\basked\b\s*\+/);
    expect(code).not.toMatch(/\.answered\b/);
    expect(code).not.toMatch(/\bplannedCount\b/);
  });

  it('selects no question and writes no attempt', () => {
    const code = hookCode();

    // The selector is `mastery/selector.ts`', server-side and deliberately
    // non-deterministic; the attempt row is written by the tool-call route
    // inside the engine's own transaction. A client reaching for either would
    // be a second question sequence and a second row.
    expect(code).not.toMatch(/recordPracticeAttempt/);
    expect(code).not.toMatch(/\bnextQuestion\b/);
    expect(code).not.toMatch(/getCivicsQuestion/);
    expect(code).not.toMatch(/\bselectQuestion\b/);
  });

  it('reads only `status`, `say`, `then`, `questionId` and `question` off a tool result', () => {
    const code = hookCode();

    // The positive form of the first assertion, and the stronger one: rather
    // than listing the fields that must not be read, this enumerates every
    // field that IS read and checks the set. A verdict-shaped field added to
    // the wire tomorrow is caught here even though no test knows its name yet.
    //
    // `question` JOINED THE SET IN #402, and it is worth saying why that is not
    // a widening of what this hook may know. It is the whole prompt-only
    // `PracticeQuestion` the engine served — the same object
    // `GET /api/practice/sessions/:id` returns as `nextQuestion` — carried on
    // the tool result so the SCREEN can render the question the coach was
    // actually handed instead of drawing one of its own from an unseeded
    // shuffle. It carries no answer and cannot: the API's
    // `PRACTICE_QUESTION_CARRIES_NO_ANSWER` proof fails the build if anybody
    // adds one. The hook does nothing with it but publish it; every assertion
    // above still holds unchanged.
    const allowed = new Set(['status', 'say', 'then', 'questionId', 'question']);
    const reads = [...code.matchAll(/\b(?:result|first|next)\.(\w+)/g)].map(
      (match) => match[1],
    );

    expect(reads.length).toBeGreaterThan(0);
    for (const field of reads) {
      expect(allowed, `a tool result's \`${field}\` is read`).toContain(field);
    }
  });
});

describe('no MediaRecorder, no voice-activity detector, no earcons', () => {
  it('names none of the three', () => {
    const code = hookCode();

    // Issue #355 states the trap this guards: reusing `useConversationSession`
    // with a realtime port runs `useVoiceActivity`'s hangover-window turn
    // detection alongside the provider's own `semantic_vad`, which is two
    // independent opinions about when a turn ended — gating a `MediaRecorder`
    // that must not exist on a full-duplex path at all. The earcons covered a
    // `processing` state this transport does not have (§8.1).
    expect(code).not.toMatch(/MediaRecorder/);
    expect(code).not.toMatch(/useVoiceActivity/);
    expect(code).not.toMatch(/earcon/i);
    expect(code).not.toMatch(/useConversationSession/);
  });
});

describe('the microphone is borrowed, never opened and never touched', () => {
  it('calls no `getUserMedia` and stops, mutes or replaces no track', () => {
    const code = hookCode();

    // `realtimeConnection.ts`'s header: a track that is disabled, muted or
    // replaced is "a half-duplex design wearing a different name". The page
    // owns exactly one microphone; this hook takes it as a port and gives it
    // back through the owner's own `release`.
    expect(code).not.toMatch(/getUserMedia/);
    expect(code).not.toMatch(/getTracks|getAudioTracks/);
    expect(code).not.toMatch(/\.enabled\s*=/);
    expect(code).not.toMatch(/replaceTrack/);
    expect(code).not.toMatch(/\.muted\s*=/);

    // And the positive half: the ONE way this file ever ends a microphone.
    expect(code).toMatch(/microphone\.release\(\)/);
  });
});

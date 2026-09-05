/**
 * `/practice/reading` and `/practice/writing` INHERIT the capture fixes —
 * issue #347, epic #345.
 *
 * Issue #347 changed three shared modules: the speech threshold and the shared
 * `AudioContext` (`hooks/useVoiceActivity.ts`), the pre-roll and the seventh
 * named problem (`hooks/useAudioCapture.ts`), and the click-to-toggle gesture
 * (`components/voice/PushToTalkButton.tsx`). Its acceptance criteria require the
 * two English screens to pick all of that up WITH NO CHANGE TO THEIR OWN CODE.
 *
 * That is a claim about structure, so it is asserted structurally: the reading
 * screen holds no capture machinery of its own to have needed changing — no
 * `getUserMedia`, no `MediaRecorder`, no `AudioContext`, no hand-written
 * problem message, no second copy of the hold gesture — it renders the shared
 * component over the shared hook, and the writing screen never touches capture
 * at all (its dictation is `speechSynthesis`, and its answer is typed).
 *
 * A behavioural test cannot make this claim: it would pass just as happily
 * against a screen that had quietly forked the button, which is exactly the
 * drift worth catching. The idiom — read the source, strip the comments, assert
 * an ABSENCE — is `earcons.test.ts`'s ("earcons — nothing is loaded").
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

/** Vitest runs with the web workspace as its root, so this resolves from there. */
function sourceOf(relativePath: string): string {
  const source = readFileSync(resolve(process.cwd(), relativePath), 'utf8');
  // A moved file fails loudly here rather than quietly asserting nothing.
  expect(source.length).toBeGreaterThan(0);
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const READING = sourceOf('src/pages/ReadingPracticePage.tsx');
const WRITING = sourceOf('src/pages/WritingPracticePage.tsx');

describe('/practice/reading takes its microphone from the shared modules', () => {
  it('renders the shared button over the shared hook', () => {
    expect(READING).toMatch(/from '\.\.\/hooks\/useAudioCapture'/);
    expect(READING).toMatch(/useAudioCapture\s*\(\s*\)/);
    expect(READING).toMatch(/from '\.\.\/components\/voice\/PushToTalkButton'/);
    expect(READING).toMatch(/<PushToTalkButton/);
  });

  it('owns no capture machinery that #347 would have had to fix twice', () => {
    expect(READING).not.toMatch(/getUserMedia/);
    expect(READING).not.toMatch(/new\s+MediaRecorder/);
    expect(READING).not.toMatch(/new\s+\w*AudioContext\w*\s*\(/);
    // No second copy of the hold gesture, which is where the click-to-toggle
    // fix lives.
    expect(READING).not.toMatch(/onPointerDown/);
    expect(READING).not.toMatch(/setPointerCapture/);
  });

  it('writes none of the failure copy itself', () => {
    // Every message and remedy comes from `describeCaptureProblem`, so the
    // seventh code arrived here as text the moment the table gained it.
    expect(READING).not.toMatch(/device_in_use/);
    expect(READING).not.toMatch(/recording_too_short/);
    expect(READING).not.toMatch(/busy with another application/i);
  });
});

describe('/practice/writing never touches capture at all', () => {
  it('has no microphone, no recorder and no detector', () => {
    // Its dictation is the browser's own `speechSynthesis` and its answer is
    // typed (`docs/specs/english-test.md` §4), so it inherits #347 by having
    // nothing of #347's to inherit.
    expect(WRITING).not.toMatch(/useAudioCapture/);
    expect(WRITING).not.toMatch(/useVoiceActivity/);
    expect(WRITING).not.toMatch(/PushToTalkButton/);
    expect(WRITING).not.toMatch(/getUserMedia/);
    expect(WRITING).not.toMatch(/new\s+MediaRecorder/);
    expect(WRITING).not.toMatch(/new\s+\w*AudioContext\w*\s*\(/);
  });
});

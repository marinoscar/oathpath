/**
 * The realtime path makes no cue sounds, and only one module may.
 *
 * Issue #357, epic #345 — locked decision 5. The spoken (realtime) interview
 * has NO multi-second silent `processing` state for a cue to cover: the model
 * is talking, and the officer's own voice is the "still here" signal that the
 * request/response loop has to synthesise a pulse for. Adding cues there would
 * put tones over a conversation, which is worse than the silence they were
 * invented to fill.
 *
 * That is an easy decision to lose. The cue module is one import away from any
 * file in this bundle, the sound only happens on a real device with a real
 * microphone, and nothing else in the suite would fail. So it is asserted
 * structurally, twice over:
 *
 *   1. NO REALTIME MODULE IMPORTS A CUE AT ALL.
 *   2. `lib/conversationCues.ts` IS THE ONLY MODULE IN THE APPLICATION THAT
 *      IMPORTS ONE — everywhere else, `lib/earcons.ts` may be imported only
 *      for the shared `AudioContext` accessors and the learner's switch. That
 *      is the stronger claim and the one that keeps the "derived from the
 *      phase, never sprinkled at call sites" property true as a fact about the
 *      tree rather than a habit.
 *
 * Note what is NOT forbidden: `getSharedAudioContext` (the voice-activity
 * detector needs the one shared context, #347) and `peekSharedAudioContextState`
 * (the readiness preflight, #349). Neither makes a sound; both would be
 * strictly worse re-implemented per feature.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = resolve(process.cwd(), 'src');

/** Every source file in the application, tests excluded. */
function sourceFiles(dir = SRC): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = resolve(dir, entry);
    if (statSync(path).isDirectory()) {
      return entry === '__tests__' ? [] : sourceFiles(path);
    }
    return /\.tsx?$/.test(entry) ? [path] : [];
  });
}

const FILES = sourceFiles().map((path) => ({
  path,
  relative: path.slice(SRC.length + 1),
  code: readFileSync(path, 'utf8'),
}));

/** Names that MAKE A SOUND. Importing one is what this file is about. */
const SOUNDING_EXPORTS = [
  'playEarcon',
  'playListeningEarcon',
  'playCapturedEarcon',
  'playSessionStartEarcon',
  'playQuestionEarcon',
  'playAdvancingEarcon',
  'playSessionEndEarcon',
  'playSessionFailedEarcon',
  'startPulse',
  'startProcessingPulse',
  'stopProcessingPulse',
];

/** The names imported from `lib/earcons` or `lib/conversationCues` by one file. */
function cueImports(code: string): string[] {
  const names: string[] = [];
  // Both spellings: `../lib/earcons` from a hook, and `./earcons` from the cue
  // module's own neighbour import.
  const pattern =
    /import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+'[^']*\b(?:earcons|conversationCues)'/g;
  for (const match of code.matchAll(pattern)) {
    for (const raw of match[1].split(',')) {
      const name = raw.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0];
      if (name) names.push(name);
    }
  }
  return names;
}

describe('the sound-making exports have exactly one caller (#357)', () => {
  it('is `lib/conversationCues.ts`, and nothing else', () => {
    const callers = FILES.filter((file) =>
      cueImports(file.code).some((name) => SOUNDING_EXPORTS.includes(name)),
    ).map((file) => file.relative);

    // A second entry here is a cue placed at a call site — the exact shape
    // this issue removed, and the shape that leaves a transition undecided.
    expect(callers).toEqual(['lib/conversationCues.ts']);
  });

  it('leaves the non-sounding accessors freely importable', () => {
    // Stated so the assertion above is not read as "nothing may touch
    // earcons.ts". The shared context and the switch are the sanctioned uses.
    const importers = FILES.filter((file) =>
      cueImports(file.code).length > 0,
    ).map((file) => file.relative);

    expect(importers).toContain('hooks/useVoiceActivity.ts');
    expect(importers).toContain('hooks/useVoicePrefs.ts');
  });
});

describe('no cue fires on the realtime path (locked decision 5)', () => {
  const realtimeFiles = FILES.filter((file) => /realtime/i.test(file.relative));

  it('finds the realtime modules to check', () => {
    // A rename that emptied this list would make every assertion below vacuous.
    expect(realtimeFiles.length).toBeGreaterThanOrEqual(3);
    expect(realtimeFiles.map((file) => file.relative)).toContain(
      'hooks/useRealtimeInterview.ts',
    );
  });

  it.each(
    FILES.filter((file) => /realtime/i.test(file.relative)).map((file) => ({
      name: file.relative,
      code: file.code,
    })),
  )('$name imports no cue module', ({ code }) => {
    expect(cueImports(code)).toEqual([]);
  });

  it.each(
    FILES.filter((file) => /realtime/i.test(file.relative)).map((file) => ({
      name: file.relative,
      code: file.code,
    })),
  )('$name calls no cue, by any route', ({ code }) => {
    // Comments stripped: this file's own prose, and theirs, is allowed to
    // discuss the cues it must not play.
    const stripped = code
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1');

    for (const name of [...SOUNDING_EXPORTS, 'applyConversationCue']) {
      expect(stripped).not.toContain(`${name}(`);
    }
  });
});

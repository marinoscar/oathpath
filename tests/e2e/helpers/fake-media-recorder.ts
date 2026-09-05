import { type Page } from '@playwright/test';

// =============================================================================
// fake-media-recorder.ts — the `MediaRecorder` stub, extracted (issue #149,
// epic #59 / E10 "Reading and writing tests")
// =============================================================================
//
// `voice.spec.ts` (issue #114, epic #58 / E9) is where this stub was written
// and proven out first, and its own header documents the reasoning behind it
// in full: Chromium's `--use-fake-device-for-media-stream` produces a real
// but SILENT `MediaStream`, so `MediaRecorder` would encode it into real
// (silent) opus/webm bytes carrying no marker `FakeAiProvider.runTranscription`
// could read. `english.spec.ts` (this epic) drives the identical
// `POST /api/ai/speech/transcribe` surface for a reading attempt — a new
// CALLER of E9's transcription endpoint, not a second implementation of it —
// so it needs the identical stub for the identical reason.
//
// This is a deliberate, byte-for-byte extraction rather than a re-derivation:
// `voice.spec.ts` defines its own copy of this function locally rather than
// importing it (it predates this file, and this issue's brief is to work only
// under `tests/e2e/**` without editing specs that already merged), so for now
// there are two copies of one small function. Both are the same on purpose —
// a change to one that is not made to the other is a real drift risk, and
// whichever spec is touched next should consider promoting `voice.spec.ts`'s
// copy to import this one instead of leaving a second inline definition to
// rot.
//
// See `voice.spec.ts`'s own header, section "NO API KEY, NO REAL
// MICROPHONE — HOW" and "THE MARKER CONVENTION", for the full argument this
// file does not restate.
// =============================================================================

/**
 * Install the fake `MediaRecorder`. Call via `page.addInitScript(...)` before
 * any navigation — an init script re-applies itself on every subsequent
 * navigation on the same `page`, so one call serves an entire test.
 */
export function installFakeMediaRecorder(): void {
  class FakeMediaRecorder extends EventTarget {
    static isTypeSupported(): boolean {
      return true;
    }

    stream: MediaStream;
    state: 'inactive' | 'recording' = 'inactive';
    mimeType = 'audio/webm';
    ondataavailable: ((event: { data: Blob }) => void) | null = null;
    onstop: (() => void) | null = null;
    onerror: (() => void) | null = null;

    constructor(stream: MediaStream) {
      super();
      this.stream = stream;
    }

    start(): void {
      this.state = 'recording';
    }

    stop(): void {
      if (this.state === 'inactive') return;
      this.state = 'inactive';

      const win = window as unknown as { __oathpathVoiceMarker?: string };
      // A safe, confident, non-empty default so a test that forgets to set
      // the marker gets a real (if generic) transcript rather than a
      // zero-byte blob `useAudioCapture` would report as `device_in_use`.
      const marker = win.__oathpathVoiceMarker ?? 'TRANSCRIPT:the constitution';
      const blob = new Blob([marker], { type: 'audio/webm' });

      this.ondataavailable?.({ data: blob });
      this.onstop?.();
    }
  }

  (window as unknown as { MediaRecorder: unknown }).MediaRecorder = FakeMediaRecorder;
}

/** Set the marker the NEXT recording will produce. See `voice.spec.ts`'s header. */
export async function setVoiceMarker(page: Page, marker: string): Promise<void> {
  await page.evaluate((m) => {
    (window as unknown as { __oathpathVoiceMarker: string }).__oathpathVoiceMarker = m;
  }, marker);
}

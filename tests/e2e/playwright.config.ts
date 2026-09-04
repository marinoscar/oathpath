import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './specs',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: 'html',
  use: {
    baseURL: process.env.BASE_URL || 'http://localhost:3535',
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        // -------------------------------------------------------------------
        // A FAKE MICROPHONE, ALWAYS — issue #114, epic #58 / E9 "Voice
        // foundation"
        // -------------------------------------------------------------------
        //
        // `voice.spec.ts` drives `getUserMedia`/`MediaRecorder` through the
        // real `useAudioCapture` hook, and this suite runs with no audio
        // device attached (a CI container, most developers' machines with the
        // mic permission untouched). Two flags make that irrelevant instead
        // of a hang or a permission-denied failure:
        //
        //   --use-fake-device-for-media-stream   `getUserMedia({ audio: true })`
        //     resolves with a synthetic, silent audio track instead of
        //     enumerating (and failing to find) real hardware.
        //   --use-fake-ui-for-media-stream        the permission prompt Chrome
        //     would otherwise show for a first capture is skipped and
        //     auto-accepted, so no test has to drive a native browser dialog
        //     Playwright cannot see into.
        //
        // The stream itself is silent, so `voice.spec.ts` does not rely on it
        // for content — it stubs `window.MediaRecorder` at the page level
        // instead (see that file's own header for the marker convention that
        // drives `FakeAiProvider.runTranscription` deterministically). These
        // two flags exist only to get a real `MediaStream` far enough for
        // that stub's constructor to receive one; no other spec in this
        // directory touches the microphone, so this project-wide change is a
        // no-op everywhere else.
        //
        // `--autoplay-policy=no-user-gesture-required` because `QuestionAudio`
        // can call `window.speechSynthesis.speak()` from a plain click rather
        // than a "real" user gesture chain in some flows, and Chrome's default
        // autoplay policy can otherwise block audio playback started that way
        // in an automated context. Harmless for every spec that never touches
        // speech synthesis.
        launchOptions: {
          args: [
            '--use-fake-device-for-media-stream',
            '--use-fake-ui-for-media-stream',
            '--autoplay-policy=no-user-gesture-required',
          ],
        },
      },
    },
  ],
  // Start local dev server if not running
  webServer: process.env.CI ? undefined : {
    command: 'cd ../../infra/compose && docker compose -f base.compose.yml -f dev.compose.yml up',
    url: 'http://localhost:3535/api/health/live',
    reuseExistingServer: true,
    timeout: 120000,
  },
});

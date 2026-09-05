/**
 * The offline app shell (issue #359, epic #345).
 *
 * WHAT THIS IS FOR, STATED HONESTLY. Nothing in this epic builds offline
 * practice, and nothing about this application could: every question, every
 * attempt and every grade is a call to `/api`, and the service worker is
 * forbidden from caching any of it (see `service-worker.js`'s policy header).
 * So the correct offline experience is not the SPA booting into a screen of
 * failed requests — it is one page that says what is actually true.
 *
 * It is deliberately a STANDALONE document rather than a React route:
 *
 *   - It has to render with the network down and no JavaScript bundle
 *     available, which is exactly what a route inside the bundle cannot
 *     promise.
 *   - Its whole job is to say "you are offline". A React route would boot the
 *     app, mount the providers, fire `/api/auth/me`, and only then decide it
 *     could not — showing an error screen on the way to showing the offline
 *     message.
 *
 * The styles are inline because there is no second request to spend on a
 * stylesheet here, and `csp.conf`'s default policy allows `style-src 'self'
 * 'unsafe-inline'` already (MUI/emotion needs it), so this adds no CSP
 * surface. There is NO SCRIPT — the page reloads by user action only, which
 * keeps it working under `script-src 'self'` with nothing inline to allow.
 *
 * Colours are the same two surfaces `config/webManifest.ts` names, with the
 * dark pair behind `prefers-color-scheme` so the page matches the app on both.
 */

import { APP_NAME } from '@oathpath/shared';

export function renderOfflineShell(appName: string = APP_NAME): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
    <meta name="theme-color" content="#ffffff" media="(prefers-color-scheme: light)" />
    <meta name="theme-color" content="#1e1e1e" media="(prefers-color-scheme: dark)" />
    <link rel="icon" type="image/svg+xml" href="/icons/icon.svg" />
    <title>Offline — ${appName}</title>
    <style>
      :root { color-scheme: light dark; }
      body {
        margin: 0;
        min-height: 100vh;
        display: flex;
        align-items: center;
        justify-content: center;
        background: #f5f5f5;
        color: rgba(0, 0, 0, 0.87);
        font-family: "Inter", "Roboto", "Helvetica", "Arial", sans-serif;
        /* The same treatment every full-bleed surface in this app gets. */
        padding: calc(24px + env(safe-area-inset-top)) calc(24px + env(safe-area-inset-right))
                 calc(24px + env(safe-area-inset-bottom)) calc(24px + env(safe-area-inset-left));
        box-sizing: border-box;
      }
      @supports (min-height: 100dvh) { body { min-height: 100dvh; } }
      main { max-width: 26rem; text-align: center; }
      img { width: 64px; height: 64px; }
      h1 { font-size: 1.5rem; font-weight: 600; margin: 1.25rem 0 0.5rem; }
      p { margin: 0 0 1.5rem; line-height: 1.6; color: rgba(0, 0, 0, 0.6); }
      a.retry {
        display: inline-block;
        padding: 0.625rem 1.25rem;
        border-radius: 8px;
        background: #1976d2;
        color: #fff;
        text-decoration: none;
        font-weight: 600;
      }
      @media (prefers-color-scheme: dark) {
        body { background: #121212; color: #fff; }
        p { color: rgba(255, 255, 255, 0.7); }
        a.retry { background: #90caf9; color: rgba(0, 0, 0, 0.87); }
      }
    </style>
  </head>
  <body>
    <main>
      <img src="/icons/icon.svg" alt="" />
      <h1>You're offline</h1>
      <p>
        ${appName} keeps your questions, answers and progress on the server, so
        practice needs a connection. Nothing has been lost — reconnect and pick
        up exactly where you left off.
      </p>
      <a class="retry" href="/">Try again</a>
    </main>
  </body>
</html>
`;
}

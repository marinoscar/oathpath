/**
 * Turns the committed service worker source into the file that ships
 * (issue #359, epic #345).
 *
 * `src/sw/service-worker.js` is written as valid, standalone JavaScript with
 * two placeholder literals in it. This module is the ONE place those
 * placeholders are filled in, and it is shared by the two things that need to
 * do it:
 *
 *   - `pwa()` in `vite.config.ts`, which emits `dist/sw.js`;
 *   - `src/__tests__/sw/service-worker.test.ts`, which evaluates the result to
 *     assert the caching policy holds.
 *
 * Sharing it is the point. A test that built its own copy of the shipped file
 * would be asserting against a paraphrase, and the thing being asserted here —
 * "no API response is ever written to a cache" — is exactly the kind of
 * invariant a paraphrase quietly loses.
 */

/** Placeholders as they appear, verbatim, in `service-worker.js`. */
export const BUILD_ID_PLACEHOLDER = "'__SW_BUILD_ID__'";
export const PRECACHE_PLACEHOLDER = "['__PRECACHE_MANIFEST__']";

export interface ServiceWorkerBuildOptions {
  /** Suffixes both cache names; changing it is what retires the old caches. */
  buildId: string;
  /** Root-relative URLs precached as the app shell. */
  precacheUrls: string[];
}

export function buildServiceWorkerSource(
  source: string,
  { buildId, precacheUrls }: ServiceWorkerBuildOptions,
): string {
  if (!source.includes(BUILD_ID_PLACEHOLDER) || !source.includes(PRECACHE_PLACEHOLDER)) {
    throw new Error(
      'service-worker.js no longer contains both build placeholders — the emitted worker would ship with a literal placeholder as its build id or precache list',
    );
  }
  return source
    .replace(BUILD_ID_PLACEHOLDER, JSON.stringify(buildId))
    .replace(PRECACHE_PLACEHOLDER, JSON.stringify(precacheUrls));
}

/**
 * The app-shell entries that are not build output — everything else in the
 * precache list is discovered from the bundle at build time.
 *
 * `/offline.html` is first because it is the one entry whose absence would be
 * felt: it is what a navigation falls back to, so an install that could not
 * fetch it must fail loudly (`addAll` is atomic) rather than leave the worker
 * serving a browser error page offline.
 */
export const STATIC_SHELL_URLS = [
  '/offline.html',
  '/',
  '/manifest.webmanifest',
  '/icons/icon.svg',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon-maskable-512.png',
  '/icons/apple-touch-icon-180.png',
  '/icons/favicon-32.png',
  '/fonts/inter.css',
];

/**
 * The worker served in development and in any build that has not opted in.
 *
 * A NO-OP WOULD NOT BE ENOUGH. Anyone who once ran the app with a real worker
 * registered keeps that worker until something replaces it, and a stale worker
 * intercepting a dev server is a genuinely confusing failure — edits that do
 * not appear, fixtures answered from cache. So the dev worker actively
 * uninstalls itself and drops every cache it finds, which is the standard
 * "self-destroying service worker" and the only reliable way back out.
 */
export const SELF_DESTROYING_SERVICE_WORKER = `// Development placeholder worker (issue #359).
// The real worker is emitted only for a production build; see \`pwa()\` in
// vite.config.ts and \`registerServiceWorker.ts\` for the registration gate.
// This one exists to UNINSTALL any worker a previous run left behind.
self.addEventListener('install', function () {
  self.skipWaiting();
});
self.addEventListener('activate', function (event) {
  event.waitUntil(
    (async function () {
      const names = await caches.keys();
      await Promise.all(names.map(function (name) { return caches.delete(name); }));
      await self.registration.unregister();
      const clientList = await self.clients.matchAll({ type: 'window' });
      clientList.forEach(function (client) { client.navigate(client.url); });
    })(),
  );
});
`;

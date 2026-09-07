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
 * The dev server's build id, fixed for the life of THIS PROCESS and different
 * in the next one.
 *
 * See `buildDevServiceWorkerSource` below for why that volatility is the
 * property the whole always-on dev worker rests on.
 */
const DEV_BUILD_ID = `dev-${Date.now()}`;

/**
 * The `/sw.js` body a DEV SERVER serves — always the real worker (issue #397).
 *
 * There is no longer a flag, an opt-in, or a placeholder branch. The dev
 * middleware in `pwa()` (`vite.config.ts`) serves this to every dev stack, and
 * the client registers it everywhere except the test suite.
 *
 * It lives here, beside the emit path, rather than inline in `pwa()`'s
 * middleware, for the same reason `buildServiceWorkerSource` is shared with the
 * worker's own suite (see this file's header): a test that re-implemented the
 * substitution would assert against a paraphrase of the shipped file rather
 * than the file itself, and the alternative — booting a Vite server inside
 * vitest — would reach it through an HTTP stack that has nothing to do with it.
 *
 * TWO PROPERTIES THIS FUNCTION IS THE SINGLE SITE OF:
 *
 *   - `precacheUrls` is `STATIC_SHELL_URLS` and NOTHING ELSE. In dev there is
 *     no bundle: the "shell" is a module graph Vite rewrites on every edit, and
 *     precaching any of it would be precaching a URL that stops existing the
 *     moment a file is saved. `addAll` is atomic, so that is not a stale entry,
 *     it is an install that fails outright.
 *   - `buildId` is VOLATILE PER PROCESS (`DEV_BUILD_ID` above) — stable for one
 *     server run, different in the next. THIS IS THE PROPERTY THAT REPLACES THE
 *     FLAG, so it is worth saying plainly what it closes.
 *
 *     Everything else about serving the real worker in development was already
 *     safe, by the worker's own policy: navigations are network-first (they are
 *     classified before the precache is consulted, so an edited `index.html` is
 *     never stale), `/src/**`, `/@vite/client` and `/@react-refresh` are
 *     classified `other` and never intercepted at all (HMR is untouched),
 *     nothing under `/api` is ever cached, and the worker never passes
 *     `ignoreSearch`, so Vite's `?v=`/`?t=` versioning makes a changed module a
 *     different cache key.
 *
 *     The ONE place staleness could genuinely have bitten was a FIXED build id.
 *     `PRECACHE_NAME`/`RUNTIME_NAME` are suffixed with it, and the precached
 *     `public/` entries — the icons, `fonts/inter.css`, `offline.html` — are
 *     cache-first with no version in their URLs. With a constant id like
 *     `'dev'` those cache names never changed, so a container rebuild shipping
 *     new bytes for any of them would have gone on serving the old ones
 *     forever, with nothing a refresh could do about it.
 *
 *     A volatile id closes exactly that: every dev-server restart and every
 *     container rebuild produces new cache names, and the worker's own
 *     `activate` handler deletes the caches that do not match — which is
 *     precisely the deploy boundary production gets from hashing the precache
 *     list.
 */
export function buildDevServiceWorkerSource(source: string): string {
  return buildServiceWorkerSource(source, {
    buildId: DEV_BUILD_ID,
    precacheUrls: STATIC_SHELL_URLS,
  });
}

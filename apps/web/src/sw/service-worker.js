/* eslint-disable no-restricted-globals */
// =============================================================================
// OathPath service worker  (issue #359, epic #345)
// =============================================================================
//
// -----------------------------------------------------------------------------
// CACHING POLICY — READ THIS BEFORE ADDING A ROUTE
// -----------------------------------------------------------------------------
//
//   ** NO API RESPONSE IS EVER WRITTEN TO ANY CACHE. **
//
// Every `/api/` response in this application carries LEARNER DATA: the answers
// someone typed, the questions they got wrong, their readiness score, their
// interview transcript, their email address, their access token. A Cache
// Storage entry is a plain, unencrypted, origin-scoped file that survives sign
// out, survives an account switch, and is readable by anyone who later picks up
// the device — so caching one is not a performance decision, it is a disclosure.
//
// The rule is therefore absolute rather than balanced against a latency win:
//
//   1. `/api/**` is NEVER cached — not stale-while-revalidate, not
//      network-first-with-fallback, not "just the harmless GETs". There is no
//      harmless GET here; `/api/civics/questions` is the closest thing to
//      shared content in the product and its answers are resolved per learner.
//   2. Only GET, only same-origin, only the classes enumerated in
//      `classifyRequest` below. Everything else — cross-origin, non-GET,
//      unrecognised — is passed straight through to the network with no
//      `respondWith` at all, so the service worker is not even in the path.
//   3. `putInCache` is THE ONLY place `cache.put` is called, and it re-checks
//      the API rule itself. That check is deliberately redundant with
//      `classifyRequest`: a future route added to the classifier cannot leak an
//      API response into storage without also deleting a line here, which is a
//      thing a reviewer sees.
//
// Consequence, stated so nobody is surprised by it: THERE IS NO OFFLINE
// PRACTICE, and this epic does not build any. Offline gets an honest shell
// (`/offline.html`) that says practice needs a connection.
//
// -----------------------------------------------------------------------------
// STRATEGY PER REQUEST CLASS
// -----------------------------------------------------------------------------
//
//   api          `/api/**`            → NEVER CACHED. Not intercepted at all.
//   cross-origin any other origin     → not intercepted. Covers the realtime
//                                       provider's WebRTC handshake and Google
//                                       avatars; neither is ours to cache.
//   navigate     document requests    → NETWORK-FIRST, falling back to the
//                                       precached `/offline.html`. Network
//                                       first because a navigation is how a
//                                       learner picks up a new deployment, and
//                                       serving a cached `index.html` for it
//                                       would hand a stale bundle to a fresh
//                                       API — the exact failure the update flow
//                                       below exists to prevent.
//   precached    the shell manifest   → CACHE-FIRST. Every entry is either
//                                       content-hashed by Vite or re-precached
//                                       under a new cache name on each
//                                       deployment, so "first" is never stale.
//   asset        hashed build output, → CACHE-FIRST, populating the runtime
//                fonts, icons          cache on a miss. Same-origin, immutable
//                                      by URL, and carrying no personal data.
//   other        anything else        → not intercepted (network).
//
// -----------------------------------------------------------------------------
// UPDATE FLOW
// -----------------------------------------------------------------------------
//
// `install` does NOT call `skipWaiting()`. A new worker precaches and then
// WAITS, the page keeps running the bundle it started with, and the client is
// told an update is ready (`registerServiceWorker.ts` watches
// `registration.waiting`). `skipWaiting()` runs only when the learner presses
// "Reload" and the page posts `{ type: 'SKIP_WAITING' }` — so a new deployment
// reaches an installed client without anyone clearing site data, and without
// swapping the JavaScript out from under a half-finished practice session.
//
// The cache names are suffixed with the build id, and `activate` deletes every
// cache that is not the current pair. That is what keeps a superseded shell
// from being served after an update, with no manual invalidation anywhere.
//
// NOTE FOR DEPLOYMENT: `apps/web/nginx.conf` must serve `/sw.js` with
// `Cache-Control: no-cache`. Its `\.(js|...)$` rule would otherwise stamp this
// file `immutable` for a year, and a browser that never re-fetches the worker
// can never learn there is a new one.
// =============================================================================

/**
 * Substituted at build time by `pwa()` in `vite.config.ts`.
 * The literals here are the honest dev-time defaults, so this file is valid,
 * runnable JavaScript exactly as committed — which is what lets the test suite
 * evaluate the SHIPPED SOURCE rather than a paraphrase of it.
 */
const BUILD_ID = '__SW_BUILD_ID__';
const PRECACHE_URLS = ['__PRECACHE_MANIFEST__'];

const PRECACHE_NAME = 'oathpath-shell-' + BUILD_ID;
const RUNTIME_NAME = 'oathpath-assets-' + BUILD_ID;
const OFFLINE_URL = '/offline.html';

/** File extensions that are safe, impersonal, same-origin static assets. */
const ASSET_EXTENSIONS = [
  '.js',
  '.css',
  '.woff',
  '.woff2',
  '.ttf',
  '.otf',
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.svg',
  '.webp',
  '.ico',
  '.webmanifest',
];

/**
 * THE API RULE, in one predicate.
 *
 * Prefix-matched on the PATH and anchored, so `/apifoo` is not an API request
 * and `/api` and `/api/...` both are — the same segment-boundary care
 * `config/destinations.ts` takes with its own prefixes, and for the same
 * reason: a `startsWith('/api')` that matched `/apiary` would be a bug in the
 * permissive direction here, but one that matched nothing would be a bug in
 * the disclosing direction.
 */
function isApiRequest(url) {
  return url.pathname === '/api' || url.pathname.startsWith('/api/');
}

function isSameOrigin(url) {
  return url.origin === self.location.origin;
}

function hasAssetExtension(pathname) {
  return ASSET_EXTENSIONS.some(function (extension) {
    return pathname.endsWith(extension);
  });
}

/**
 * Sorts one request into exactly one of the classes documented above.
 *
 * Returns `'api'`, `'cross-origin'`, `'navigate'`, `'precached'`, `'asset'` or
 * `'other'`. Only `navigate`, `precached` and `asset` are ever answered from
 * the service worker; the other three mean "get out of the way".
 */
function classifyRequest(request, url) {
  if (isApiRequest(url)) return 'api';
  if (!isSameOrigin(url)) return 'cross-origin';
  if (request.method !== 'GET') return 'other';
  if (request.mode === 'navigate') return 'navigate';
  if (PRECACHE_URLS.indexOf(url.pathname) !== -1) return 'precached';
  if (hasAssetExtension(url.pathname)) return 'asset';
  return 'other';
}

/**
 * THE ONLY WRITE PATH INTO CACHE STORAGE.
 *
 * Refuses an API URL itself rather than trusting `classifyRequest` to have
 * done it — see rule 3 of the policy header. Also refuses anything that is not
 * a complete, same-origin, successful response: an opaque cross-origin
 * response has an unreadable status, and a 206 or a redirect is not something
 * we want served back from storage later.
 */
async function putInCache(cacheName, request, response) {
  const url = new URL(request.url);
  if (isApiRequest(url)) return;
  if (!isSameOrigin(url)) return;
  if (!response || !response.ok || response.type === 'opaque') return;
  const cache = await caches.open(cacheName);
  await cache.put(request, response.clone());
}

/** Network-first: the network's answer, or the honest offline shell. */
async function handleNavigate(request) {
  try {
    const response = await fetch(request);
    return response;
  } catch (error) {
    const offline = await caches.match(OFFLINE_URL);
    if (offline) return offline;
    // Only reachable if the precache itself failed to install. The shell is
    // the second-best honest answer; a thrown error would be a browser error
    // page, which says nothing useful about this application.
    const shell = await caches.match('/');
    if (shell) return shell;
    throw error;
  }
}

/** Cache-first, populating `cacheName` on a miss. */
async function handleCacheFirst(request, cacheName) {
  const cached = await caches.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  await putInCache(cacheName, request, response);
  return response;
}

self.addEventListener('install', function (event) {
  // NO `skipWaiting()` HERE. See the update-flow section of the header: the
  // learner decides when the new bundle takes over.
  event.waitUntil(
    (async function () {
      const cache = await caches.open(PRECACHE_NAME);
      // `addAll` is atomic — one 404 fails the whole install, which is what we
      // want: a half-precached shell that falls back to a missing offline page
      // is worse than no service worker.
      await cache.addAll(PRECACHE_URLS);
    })(),
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    (async function () {
      const names = await caches.keys();
      await Promise.all(
        names
          .filter(function (name) {
            return name !== PRECACHE_NAME && name !== RUNTIME_NAME;
          })
          .map(function (name) {
            return caches.delete(name);
          }),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', function (event) {
  const request = event.request;
  const url = new URL(request.url);
  const requestClass = classifyRequest(request, url);

  // `api`, `cross-origin` and `other` deliberately fall through with NO
  // `respondWith`, which takes this worker out of the request path entirely.
  if (requestClass === 'navigate') {
    event.respondWith(handleNavigate(request));
  } else if (requestClass === 'precached') {
    event.respondWith(handleCacheFirst(request, PRECACHE_NAME));
  } else if (requestClass === 'asset') {
    event.respondWith(handleCacheFirst(request, RUNTIME_NAME));
  }
});

self.addEventListener('message', function (event) {
  // The user pressed "Reload" on the update affordance. This is the only thing
  // that promotes a waiting worker.
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

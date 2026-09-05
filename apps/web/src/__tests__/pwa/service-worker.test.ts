import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import {
  buildServiceWorkerSource,
  STATIC_SHELL_URLS,
} from '../../sw/buildServiceWorker';

// =============================================================================
// The service worker's caching policy  (issue #359, epic #345)
// =============================================================================
//
//   ** NO API RESPONSE IS EVER WRITTEN TO ANY CACHE. **
//
// That is the acceptance criterion, and it is a DISCLOSURE property, not a
// performance one: a Cache Storage entry is an unencrypted, origin-scoped file
// that survives sign out and is readable by whoever picks the device up next,
// and every `/api/` response in this application carries a learner's answers,
// scores, transcript or email address.
//
// This suite runs THE SHIPPED SOURCE. `src/sw/service-worker.js` is committed
// as valid standalone JavaScript with two build placeholders, and
// `buildServiceWorkerSource` — the same function `vite.config.ts` calls to emit
// `dist/sw.js` — fills them in. The file is then evaluated in a sandbox with a
// fake `self`, a fake `caches` and a fake `fetch`, and its own predicates and
// handlers are exercised directly. A test that re-implemented the routing rules
// would be asserting against a paraphrase, which for an invariant of this kind
// is the same as not asserting it.
// =============================================================================

const SOURCE_PATH = resolve(__dirname, '..', '..', 'sw', 'service-worker.js');
const rawSource = readFileSync(SOURCE_PATH, 'utf8');

const ORIGIN = 'https://oathpath.example';

interface FakeResponse {
  ok: boolean;
  type: string;
  body: string;
  clone: () => FakeResponse;
}

function fakeResponse(body: string, { ok = true, type = 'basic' } = {}): FakeResponse {
  const response: FakeResponse = {
    ok,
    type,
    body,
    clone: () => response,
  };
  return response;
}

/** Only the three fields the worker actually reads off a Request. */
function fakeRequest(path: string, { method = 'GET', mode = 'no-cors' } = {}) {
  return { url: `${ORIGIN}${path}`, method, mode };
}

interface SandboxOptions {
  precacheUrls?: string[];
  /** Pre-seeded cache contents, keyed by the URL the worker will `match` on. */
  cached?: Record<string, FakeResponse>;
  /** `undefined` makes `fetch` reject, which is how "offline" is simulated. */
  network?: (request: { url: string }) => FakeResponse | undefined;
}

/**
 * Evaluates the shipped worker with stubs in place of the service worker
 * globals, and hands back its internals plus every spy worth asserting on.
 */
function instantiateWorker({
  precacheUrls = [...STATIC_SHELL_URLS],
  cached = {},
  network = () => fakeResponse('from network'),
}: SandboxOptions = {}) {
  const listeners = new Map<string, ((event: unknown) => void)[]>();
  const put = vi.fn(async () => undefined);
  const cacheDelete = vi.fn(async () => true);
  const addAll = vi.fn(async () => undefined);
  const openedCaches: string[] = [];

  const caches = {
    open: vi.fn(async (name: string) => {
      openedCaches.push(name);
      return { put, addAll };
    }),
    match: vi.fn(async (requestOrUrl: string | { url: string }) => {
      const key =
        typeof requestOrUrl === 'string'
          ? requestOrUrl
          : new URL(requestOrUrl.url).pathname;
      return cached[key];
    }),
    keys: vi.fn(async () => ['oathpath-shell-old', 'oathpath-assets-old', 'oathpath-shell-test']),
    delete: cacheDelete,
  };

  const fetchImpl = vi.fn(async (request: { url: string }) => {
    const response = network(request);
    if (!response) throw new TypeError('Failed to fetch');
    return response;
  });

  const self = {
    location: { origin: ORIGIN },
    addEventListener: (type: string, handler: (event: unknown) => void) => {
      const existing = listeners.get(type) ?? [];
      existing.push(handler);
      listeners.set(type, existing);
    },
    skipWaiting: vi.fn(),
    clients: { claim: vi.fn(async () => undefined) },
  };

  const source = buildServiceWorkerSource(rawSource, { buildId: 'test', precacheUrls });
  const factory = new Function(
    'self',
    'caches',
    'fetch',
    `${source}
    return {
      isApiRequest: isApiRequest,
      classifyRequest: classifyRequest,
      putInCache: putInCache,
      handleNavigate: handleNavigate,
      handleCacheFirst: handleCacheFirst,
      PRECACHE_NAME: PRECACHE_NAME,
      RUNTIME_NAME: RUNTIME_NAME,
      PRECACHE_URLS: PRECACHE_URLS,
    };`,
  );

  const worker = factory(self, caches, fetchImpl) as {
    isApiRequest: (url: URL) => boolean;
    classifyRequest: (request: unknown, url: URL) => string;
    putInCache: (name: string, request: unknown, response: unknown) => Promise<void>;
    handleNavigate: (request: unknown) => Promise<FakeResponse>;
    handleCacheFirst: (request: unknown, name: string) => Promise<FakeResponse>;
    PRECACHE_NAME: string;
    RUNTIME_NAME: string;
    PRECACHE_URLS: string[];
  };

  /** Fires the worker's own `fetch` listener and reports what it did. */
  async function dispatchFetch(request: ReturnType<typeof fakeRequest>) {
    const respondWith = vi.fn();
    const handlers = listeners.get('fetch') ?? [];
    for (const handler of handlers) handler({ request, respondWith });
    if (respondWith.mock.calls.length > 0) {
      await respondWith.mock.calls[0][0];
    }
    return { respondWith };
  }

  return { worker, caches, put, cacheDelete, addAll, fetchImpl, self, listeners, dispatchFetch, openedCaches };
}

describe('service worker source', () => {
  it('states the no-API-caching policy in its own source', () => {
    // The acceptance criterion asks for the policy to live in the code, not
    // only in the PR. This asserts the sentence is there to be read by whoever
    // opens the file next.
    expect(rawSource).toContain('NO API RESPONSE IS EVER WRITTEN TO ANY CACHE');
    expect(rawSource).toContain('THERE IS NO OFFLINE');
  });

  it('calls cache.put in exactly one place', () => {
    // `putInCache` re-checks the API rule itself. That redundancy is only
    // load-bearing while it is the ONLY write path: a second `cache.put`
    // elsewhere would bypass the check without touching it.
    const putCalls = rawSource.match(/cache\.put\(/g) ?? [];
    expect(putCalls).toHaveLength(1);
  });

  it('refuses to build if a placeholder has been renamed away', () => {
    // Shipping a worker whose build id is the literal string
    // `__SW_BUILD_ID__` would give every deployment the same cache names, so
    // no update would ever retire the old shell. Fail the build instead.
    expect(() =>
      buildServiceWorkerSource('// nothing to substitute', {
        buildId: 'x',
        precacheUrls: [],
      }),
    ).toThrow(/placeholder/i);
  });
});

describe('isApiRequest', () => {
  const { worker } = instantiateWorker();

  it.each(['/api', '/api/', '/api/practice/sessions/1', '/api/auth/me'])(
    'treats %s as an API request',
    (path) => {
      expect(worker.isApiRequest(new URL(`${ORIGIN}${path}`))).toBe(true);
    },
  );

  it.each(['/apiary', '/apifoo', '/', '/assets/api-D5bm9J0D.js', '/icons/icon-192.png'])(
    'does not treat %s as an API request',
    (path) => {
      // Anchored on the segment boundary, exactly as `config/destinations.ts`
      // does with its own prefixes. Over-matching here would disable caching
      // for a static asset; under-matching would cache a learner's data.
      expect(worker.isApiRequest(new URL(`${ORIGIN}${path}`))).toBe(false);
    },
  );
});

describe('classifyRequest', () => {
  const { worker } = instantiateWorker({ precacheUrls: ['/', '/offline.html'] });

  const classify = (path: string, init?: { method?: string; mode?: string }, origin = ORIGIN) => {
    const request = { ...fakeRequest(path, init), url: `${origin}${path}` };
    return worker.classifyRequest(request, new URL(request.url));
  };

  it('classes every /api/ URL as api, whatever its mode or method', () => {
    expect(classify('/api/readiness')).toBe('api');
    expect(classify('/api/practice/sessions', { method: 'POST' })).toBe('api');
    // The important one: a navigation to an API path must NOT be treated as a
    // navigation and answered from the shell cache.
    expect(classify('/api/docs', { mode: 'navigate' })).toBe('api');
  });

  it('classes another origin as cross-origin, whatever the path looks like', () => {
    // The realtime provider's WebRTC handshake and Google avatars both land
    // here; neither is ours to cache.
    expect(classify('/v1/realtime', {}, 'https://api.openai.com')).toBe('cross-origin');
  });

  it('classes a same-origin document request as a navigation', () => {
    expect(classify('/practice/sessions/42', { mode: 'navigate' })).toBe('navigate');
  });

  it('classes a precached URL as precached and a hashed asset as an asset', () => {
    expect(classify('/offline.html')).toBe('precached');
    expect(classify('/assets/index-DilFyHTj.js')).toBe('asset');
    expect(classify('/fonts/inter-latin.woff2')).toBe('asset');
  });

  it('classes a non-GET and anything unrecognised as other', () => {
    expect(classify('/somewhere', { method: 'POST' })).toBe('other');
    expect(classify('/somewhere/without/an/extension')).toBe('other');
  });
});

describe('the fetch handler never touches an API request', () => {
  it('does not call respondWith for /api/, so the worker leaves the path entirely', async () => {
    const { dispatchFetch, put, caches } = instantiateWorker();

    const { respondWith } = await dispatchFetch(
      fakeRequest('/api/practice/sessions/1', { mode: 'navigate' }),
    );

    expect(respondWith).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
    expect(caches.open).not.toHaveBeenCalled();
    expect(caches.match).not.toHaveBeenCalled();
  });

  it.each([
    '/api/auth/me',
    '/api/readiness',
    '/api/interviews/9/turns',
    '/api/ai/usage',
  ])('never writes %s to a cache', async (path) => {
    const { dispatchFetch, put } = instantiateWorker();
    await dispatchFetch(fakeRequest(path));
    expect(put).not.toHaveBeenCalled();
  });

  it('refuses an API URL even when putInCache is called directly', async () => {
    // The structural guarantee: a future route added to `classifyRequest`
    // cannot leak an API response into storage without also deleting the check
    // inside the one write path.
    const { worker, put } = instantiateWorker();

    await worker.putInCache('any-cache', fakeRequest('/api/auth/me'), fakeResponse('secret'));

    expect(put).not.toHaveBeenCalled();
  });

  it('refuses a cross-origin or unsuccessful response too', async () => {
    const { worker, put } = instantiateWorker();

    await worker.putInCache(
      'any-cache',
      { url: 'https://api.openai.com/v1/realtime', method: 'GET', mode: 'cors' },
      fakeResponse('body'),
    );
    await worker.putInCache(
      'any-cache',
      fakeRequest('/assets/app.js'),
      fakeResponse('nope', { ok: false }),
    );
    await worker.putInCache(
      'any-cache',
      fakeRequest('/assets/app.js'),
      fakeResponse('opaque', { type: 'opaque' }),
    );

    expect(put).not.toHaveBeenCalled();
  });
});

describe('strategy per request class', () => {
  it('serves navigations from the network first', async () => {
    const { worker, fetchImpl, caches } = instantiateWorker({
      network: () => fakeResponse('fresh index.html'),
    });

    const response = await worker.handleNavigate(fakeRequest('/', { mode: 'navigate' }));

    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(response.body).toBe('fresh index.html');
    // Network-first means a live navigation must not be answered from cache —
    // that is what stops a stale bundle meeting a new API.
    expect(caches.match).not.toHaveBeenCalled();
  });

  it('falls back to the honest offline shell when the network is gone', async () => {
    const { worker } = instantiateWorker({
      network: () => undefined,
      cached: { '/offline.html': fakeResponse('offline shell') },
    });

    const response = await worker.handleNavigate(fakeRequest('/practice', { mode: 'navigate' }));

    expect(response.body).toBe('offline shell');
  });

  it('serves a precached shell entry from cache without hitting the network', async () => {
    const { worker, fetchImpl } = instantiateWorker({
      cached: { '/offline.html': fakeResponse('cached shell') },
    });

    const response = await worker.handleCacheFirst(
      fakeRequest('/offline.html'),
      worker.PRECACHE_NAME,
    );

    expect(response.body).toBe('cached shell');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('fetches and caches a hashed asset on a miss', async () => {
    const { worker, put, fetchImpl, openedCaches } = instantiateWorker({
      network: () => fakeResponse('bundle'),
    });

    const response = await worker.handleCacheFirst(
      fakeRequest('/assets/index-DilFyHTj.js'),
      worker.RUNTIME_NAME,
    );

    expect(response.body).toBe('bundle');
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(put).toHaveBeenCalledOnce();
    expect(openedCaches).toContain(worker.RUNTIME_NAME);
  });
});

describe('install, activate and the update handshake', () => {
  it('precaches the shell on install and does NOT skipWaiting', async () => {
    const { listeners, addAll, self, worker } = instantiateWorker();
    const waitUntil = vi.fn();

    listeners.get('install')![0]({ waitUntil });
    await waitUntil.mock.calls[0][0];

    expect(addAll).toHaveBeenCalledWith(worker.PRECACHE_URLS);
    // The whole update flow rests on this: a new worker waits, the learner is
    // told, and the swap happens when they say so — never mid-question.
    expect(self.skipWaiting).not.toHaveBeenCalled();
  });

  it('precaches the offline shell, which is what makes offline honest', () => {
    const { worker } = instantiateWorker();
    expect(worker.PRECACHE_URLS).toContain('/offline.html');
    expect(worker.PRECACHE_URLS).toContain('/');
    expect(worker.PRECACHE_URLS).toContain('/manifest.webmanifest');
  });

  it('deletes every cache that is not the current pair on activate', async () => {
    const { listeners, cacheDelete, self } = instantiateWorker();
    const waitUntil = vi.fn();

    listeners.get('activate')![0]({ waitUntil });
    await waitUntil.mock.calls[0][0];

    // `oathpath-shell-test` and `oathpath-assets-test` are this build's names;
    // the two `-old` caches the fake `keys()` returns must go.
    expect(cacheDelete).toHaveBeenCalledWith('oathpath-shell-old');
    expect(cacheDelete).toHaveBeenCalledWith('oathpath-assets-old');
    expect(cacheDelete).not.toHaveBeenCalledWith('oathpath-shell-test');
    expect(self.clients.claim).toHaveBeenCalled();
  });

  it('promotes the waiting worker only on an explicit SKIP_WAITING message', () => {
    const { listeners, self } = instantiateWorker();
    const onMessage = listeners.get('message')![0];

    onMessage({ data: { type: 'SOMETHING_ELSE' } });
    expect(self.skipWaiting).not.toHaveBeenCalled();

    onMessage({ data: { type: 'SKIP_WAITING' } });
    expect(self.skipWaiting).toHaveBeenCalledOnce();
  });

  it('names its caches after the build id, so a new deployment retires the old ones', () => {
    const a = instantiateWorker().worker;
    expect(a.PRECACHE_NAME).toBe('oathpath-shell-test');
    expect(a.RUNTIME_NAME).toBe('oathpath-assets-test');
  });
});

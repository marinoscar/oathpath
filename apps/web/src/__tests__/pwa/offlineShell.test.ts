import { describe, expect, it } from 'vitest';

import { renderOfflineShell } from '../../sw/offlineShell';

// =============================================================================
// The offline shell must be HONEST  (issue #359, epic #345)
// =============================================================================
//
// The issue is explicit: "Do not claim offline practice — nothing in this epic
// builds it." Everything a learner does is a call to `/api`, and the service
// worker is forbidden from caching any of it, so an offline screen that implied
// otherwise would be a promise the application cannot keep — and the learner
// would discover that only after tapping into a session that cannot start.
// =============================================================================

describe('offline shell', () => {
  const html = renderOfflineShell();

  it('says practice needs a connection', () => {
    expect(html).toMatch(/practice needs a connection/i);
    expect(html).toMatch(/you're offline/i);
  });

  it('never claims anything works offline', () => {
    // The phrasings that would be a lie. Kept as an explicit list because the
    // failure this guards against is a well-meaning copy edit, not a bug.
    for (const claim of [
      /practi\w* offline/i,
      /works offline/i,
      /available offline/i,
      /keep practising/i,
      /continue offline/i,
    ]) {
      expect(html, `offline shell claims: ${claim}`).not.toMatch(claim);
    }
  });

  it('reassures rather than alarms, per VISION.md on pressure and fear', () => {
    expect(html).toMatch(/nothing has been lost/i);
  });

  it('carries the product name from @oathpath/shared', () => {
    expect(renderOfflineShell('Renamed')).toContain('Renamed');
  });

  it('has no script at all, so it renders under script-src self with nothing inline', () => {
    expect(html).not.toMatch(/<script/i);
  });

  it('sets viewport-fit=cover and pays the safe-area insets, being full-bleed', () => {
    expect(html).toContain('viewport-fit=cover');
    expect(html).toContain('env(safe-area-inset-bottom)');
  });

  it('guards its own 100vh with the same @supports (100dvh) treatment', () => {
    expect(html).toContain('@supports (min-height: 100dvh)');
  });
});

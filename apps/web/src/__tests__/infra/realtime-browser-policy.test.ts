import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { REALTIME_CALL_URL } from '../../services/realtimeConnection';

// =============================================================================
// The proxy's own headers must let the spoken interview happen at all
// =============================================================================
//
// Issue #159, epic #60 / E11. Three browser policies live in
// `infra/nginx/`, are edited by different people for different reasons, and are
// four directories away from the code that depends on them. Every one of them
// fails the same way when it is wrong: SILENTLY, and only behind the proxy.
//
//   * `Permissions-Policy: microphone=()` denies the microphone to every
//     origin INCLUDING this one, so `getUserMedia` is rejected by policy
//     before a permission prompt is ever shown. The learner sees "your browser
//     is blocking the microphone for this site" having never been asked.
//   * `connect-src 'self'` blocks the WebRTC handshake's SDP POST to the
//     provider. No console error a learner will see, no failed request in the
//     app's own logs — just a connection that never opens and a screen that
//     falls back to text on every attempt.
//
// Neither reproduces in development-by-Vite (port 5173, no proxy in front of
// it), so both are invisible until the compose stack is used — which is
// precisely when §11's manual checklist would be run and would report a
// feature that has never worked anywhere.
//
// This asserts the invariants rather than the strings: the provider host comes
// from the module that actually opens the connection, so changing it in one
// place fails here naming both.
// =============================================================================

const repoRoot = resolve(__dirname, '..', '..', '..', '..', '..');

function read(relativePath: string): string {
  return readFileSync(resolve(repoRoot, relativePath), 'utf8');
}

/** The origin the browser opens its realtime call against. */
const PROVIDER_ORIGIN = new URL(REALTIME_CALL_URL).origin;

/** Every uncommented `default` policy line in one csp map file. */
function defaultPolicy(relativePath: string): string {
  const line = read(relativePath)
    .split('\n')
    .filter((entry) => !entry.trimStart().startsWith('#'))
    .find((entry) => entry.trimStart().startsWith('default '));
  expect(line, `no default policy found in ${relativePath}`).toBeDefined();
  return line!;
}

describe('the microphone is permitted to this origin', () => {
  it('grants microphone to self rather than denying it to everyone', () => {
    const conf = read('infra/nginx/nginx.conf');
    const match = conf
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('#'))
      .join('\n')
      .match(/Permissions-Policy\s+"([^"]+)"/);

    expect(match, 'no Permissions-Policy header found').not.toBeNull();
    const policy = match![1]!;

    // The failure this guards is `microphone=()`, which reads as a tightening
    // and is in fact a feature switch: it turns off push-to-talk (#99) and the
    // spoken interview (#159) at once, behind the proxy only.
    expect(policy).toContain('microphone=(self)');
    expect(policy).not.toContain('microphone=()');
  });

  it('still denies the three capabilities this product does not use', () => {
    // Guards the fix above from being applied with a broom rather than a
    // scalpel: `microphone=(self)` is a considered exception, not a licence to
    // open the rest.
    const conf = read('infra/nginx/nginx.conf');
    const policy = conf.match(/Permissions-Policy\s+"([^"]+)"/)![1]!;
    expect(policy).toContain('camera=()');
    expect(policy).toContain('geolocation=()');
    expect(policy).toContain('payment=()');
  });
});

describe('the CSP lets the browser reach the realtime provider', () => {
  // BOTH FILES, because they are two whole policy strings in two map blocks
  // and nothing but this keeps them agreeing. A spoken interview that worked
  // in production and was blocked in development would be discovered by the
  // person least able to explain it.
  for (const file of ['infra/nginx/csp.conf', 'infra/nginx/csp.dev.conf']) {
    it(`allows the SDP handshake and the officer's audio in ${file}`, () => {
      const policy = defaultPolicy(file);

      // The host is read from `realtimeConnection.ts` rather than retyped, so
      // a change to where the handshake is sent fails here instead of shipping
      // as a feature that never connects.
      expect(policy).toContain(`connect-src 'self' ${PROVIDER_ORIGIN}`);

      // The officer's voice is a live MediaStream attached with `srcObject`.
      // Without its own directive it inherits `default-src 'self'`.
      expect(policy).toContain("media-src 'self' blob: mediastream:");
    });

    it(`keeps the rest of ${file}'s default policy closed`, () => {
      const policy = defaultPolicy(file);
      // The allowance above is exactly one host wide. `https:` here would let
      // any script on the page talk to anything, which is a different policy
      // wearing the same fix.
      expect(policy).not.toContain('connect-src *');
      expect(policy).not.toMatch(/connect-src [^;]*\bhttps:(?!\/)/);
      expect(policy).toContain("object-src 'none'");
      expect(policy).toContain("base-uri 'self'");
    });
  }
});

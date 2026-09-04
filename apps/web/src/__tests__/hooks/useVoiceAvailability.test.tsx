/**
 * `useVoiceAvailability` — the two speech roles, read from the field that
 * already answers the question.
 *
 * Issue #109, epic #58 / E9. The hook is four lines; everything worth testing
 * about it is a decision rather than a computation, so each test below names
 * the decision it pins:
 *
 *   1. It reads `unboundRoles`, so it keeps working with no new API field —
 *      `docs/specs/voice.md` §12 rejected both a `boundRoles` field and a
 *      combined `voiceReady` flag.
 *   2. It does NOT read `systemReady`, which since E9 narrowed to the text
 *      roles and no longer answers a voice surface's question at all. A
 *      deployment with `tutor` and `grader` bound and no voice configuration
 *      is a normal, working deployment.
 *   3. An unknown status resolves to "not bound", which is the direction that
 *      costs a learner nothing.
 *   4. `transcribeUnbound` is not `!transcribeBound`, because while the status
 *      is unknown BOTH are false — the distinction that keeps the notice from
 *      flashing on every page load of a correctly configured deployment.
 */

import { renderHook, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import type { ReactNode } from 'react';

import { AiStatusProvider } from '../../contexts/AiStatusContext';
import { useVoiceAvailability } from '../../hooks/useVoiceAvailability';
import type { AiStatus } from '../../types';
import { server } from '../mocks/server';

function mockStatus(overrides: Partial<AiStatus> = {}) {
  const status: AiStatus = {
    userKeyConfigured: true,
    systemReady: true,
    enabled: true,
    providerConfigured: true,
    unboundRoles: [],
    ...overrides,
  };
  server.use(http.get('*/api/ai/status', () => HttpResponse.json({ data: status })));
}

function withProvider({ children }: { children: ReactNode }) {
  return <AiStatusProvider>{children}</AiStatusProvider>;
}

describe('useVoiceAvailability — reading unboundRoles', () => {
  it('reports both roles bound when neither is listed', async () => {
    mockStatus({ unboundRoles: [] });

    const { result } = renderHook(() => useVoiceAvailability(), {
      wrapper: withProvider,
    });

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.transcribeBound).toBe(true);
    expect(result.current.speakBound).toBe(true);
    expect(result.current.transcribeUnbound).toBe(false);
  });

  it('reports `transcribe` unbound when it is listed, and says nothing about `speak`', async () => {
    mockStatus({ unboundRoles: ['transcribe'] });

    const { result } = renderHook(() => useVoiceAvailability(), {
      wrapper: withProvider,
    });

    await waitFor(() => expect(result.current.transcribeUnbound).toBe(true));
    expect(result.current.transcribeBound).toBe(false);
    // The two roles are independent facts with independent remedies, which is
    // why there is no single `voiceReady` flag (voice.md §12).
    expect(result.current.speakBound).toBe(true);
  });

  it('reports `speak` unbound without touching `transcribe`', async () => {
    mockStatus({ unboundRoles: ['speak'] });

    const { result } = renderHook(() => useVoiceAvailability(), {
      wrapper: withProvider,
    });

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.speakBound).toBe(false);
    expect(result.current.transcribeBound).toBe(true);
    expect(result.current.transcribeUnbound).toBe(false);
  });

  it('IGNORES `systemReady` — a ready system can have no speech recognition', async () => {
    // The state E9 created and the reason this hook exists. `systemReady`
    // narrowed to the text roles (voice.md §1), so an installation with only
    // `tutor` and `grader` bound is normal and working — and its microphone
    // still cannot work.
    mockStatus({ systemReady: true, unboundRoles: ['transcribe', 'speak'] });

    const { result } = renderHook(() => useVoiceAvailability(), {
      wrapper: withProvider,
    });

    await waitFor(() => expect(result.current.transcribeUnbound).toBe(true));
    expect(result.current.transcribeBound).toBe(false);
    expect(result.current.speakBound).toBe(false);
  });

  it('does not treat a NOT-ready system as evidence about the voice roles', async () => {
    // The mirror image: `tutor` unbound takes every AI feature away, but it is
    // not a statement about `transcribe`, and merging the two would make the
    // voice surface report the wrong problem.
    mockStatus({ systemReady: false, unboundRoles: ['tutor'] });

    const { result } = renderHook(() => useVoiceAvailability(), {
      wrapper: withProvider,
    });

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.transcribeBound).toBe(true);
    expect(result.current.transcribeUnbound).toBe(false);
  });
});

describe('useVoiceAvailability — when the answer is unknown', () => {
  it('resolves an unread status to "not bound", and to no notice', async () => {
    // The gate fails open; this fails QUIET. A microphone shown on a guess is
    // a microphone that may do nothing, and a notice shown on a guess claims a
    // deployment is unconfigured on no evidence at all.
    server.use(http.get('*/api/ai/status', () => HttpResponse.error()));

    const { result } = renderHook(() => useVoiceAvailability(), {
      wrapper: withProvider,
    });

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.transcribeBound).toBe(false);
    expect(result.current.speakBound).toBe(false);
    // NOT the negation of `transcribeBound`. This is the field that would
    // otherwise put "speech recognition is not set up" on screen for a
    // deployment that has it.
    expect(result.current.transcribeUnbound).toBe(false);
  });

  it('says nothing while the first response is still in flight', () => {
    mockStatus({ unboundRoles: ['transcribe'] });

    const { result } = renderHook(() => useVoiceAvailability(), {
      wrapper: withProvider,
    });

    expect(result.current.isLoading).toBe(true);
    expect(result.current.transcribeBound).toBe(false);
    expect(result.current.transcribeUnbound).toBe(false);
  });

  it('does not throw with no AiStatusProvider above it', () => {
    // A practice screen's reason to exist has nothing to do with AI. A throw
    // here would blank the whole feature to report that we could not tell
    // whether a microphone was worth showing.
    const { result } = renderHook(() => useVoiceAvailability());

    expect(result.current.transcribeBound).toBe(false);
    expect(result.current.transcribeUnbound).toBe(false);
    expect(result.current.speakBound).toBe(false);
    expect(result.current.isLoading).toBe(false);
  });
});

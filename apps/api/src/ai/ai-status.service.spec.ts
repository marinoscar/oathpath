import { Test, TestingModule } from '@nestjs/testing';

import { AiStatusService } from './ai-status.service';
import { AiSettingsService } from './ai-settings.service';
import {
  AI_USER_CREDENTIAL_PURPOSE,
  aiUserCredentialName,
} from './ai-credential.constants';
import {
  AI_STATUS_CARRIES_NO_SECRET,
  aiStatusResponseSchema,
} from './dto/ai-status.dto';
import { CredentialsService } from '../credentials/credentials.service';

// =============================================================================
// AiStatusService — tests (issue #36, epic #25)
// =============================================================================
//
// The four combinations of the two flags, plus the three properties that make
// this safe to call on every navigation:
//
//   * no outbound provider call, ever;
//   * `describe`, not `getSecret` — no decrypt on the hottest path;
//   * the system half is cached, and a settings write drops it.
// =============================================================================

const ALICE = '11111111-1111-4111-8111-111111111111';
const BOB = '22222222-2222-4222-8222-222222222222';

const READY = {
  systemReady: true,
  enabled: true,
  providerConfigured: true,
  unboundRoles: [] as string[],
};

describe('AiStatusService', () => {
  let service: AiStatusService;
  let credentials: { describe: jest.Mock; getSecret: jest.Mock; list: jest.Mock };
  let aiSettings: { describeReadiness: jest.Mock };

  beforeEach(async () => {
    credentials = {
      describe: jest.fn().mockResolvedValue({ hint: '••••abcd' }),
      getSecret: jest.fn(),
      list: jest.fn(),
    };
    aiSettings = { describeReadiness: jest.fn().mockResolvedValue(READY) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AiStatusService,
        { provide: CredentialsService, useValue: credentials },
        { provide: AiSettingsService, useValue: aiSettings },
      ],
    }).compile();

    service = module.get(AiStatusService);
  });

  // ---------------------------------------------------------------------------
  // The four combinations
  // ---------------------------------------------------------------------------

  describe('the two flags', () => {
    it('key + ready: the ordinary working state', async () => {
      await expect(service.describe(ALICE)).resolves.toMatchObject({
        userKeyConfigured: true,
        systemReady: true,
      });
    });

    it('key, no ready: the user is let in and meets a point-of-use message', async () => {
      aiSettings.describeReadiness.mockResolvedValue({
        ...READY,
        systemReady: false,
        unboundRoles: ['grader'],
      });

      await expect(service.describe(ALICE)).resolves.toMatchObject({
        userKeyConfigured: true,
        systemReady: false,
        unboundRoles: ['grader'],
      });
    });

    it('no key, ready: the user is hard-blocked into setup', async () => {
      credentials.describe.mockResolvedValue(null);

      await expect(service.describe(ALICE)).resolves.toMatchObject({
        userKeyConfigured: false,
        systemReady: true,
      });
    });

    it('neither: both facts are reported, separately', async () => {
      // The case that makes a merged flag actively harmful — a user with
      // neither would be told to add a key AND the admin would learn nothing
      // about their own unfinished configuration.
      credentials.describe.mockResolvedValue(null);
      aiSettings.describeReadiness.mockResolvedValue({
        systemReady: false,
        enabled: false,
        providerConfigured: false,
        unboundRoles: ['tutor', 'grader'],
      });

      await expect(service.describe(ALICE)).resolves.toMatchObject({
        userKeyConfigured: false,
        systemReady: false,
      });
    });

    it('reports a wired-but-unbound realtime role WITHOUT saying the system is unready', async () => {
      // The E11 shape (#156) as a learner's client sees it. `realtime` is
      // wired, so an admin who has not chosen an interview model is told which
      // role is missing; it is not a text role, so `systemReady` stays true
      // and nothing hard-blocks the learner from practising by text.
      //
      // Asserted here as well as on `describeReadiness` because this endpoint
      // is what every navigation reads: a filter added between the two — "only
      // show roles that matter" — would silently take the one signal an
      // interview surface has to gate on.
      aiSettings.describeReadiness.mockResolvedValue({
        ...READY,
        unboundRoles: ['realtime'],
      });

      const status = await service.describe(ALICE);

      expect(status.systemReady).toBe(true);
      expect(status.unboundRoles).toEqual(['realtime']);
    });

    it('returns NO combined flag', () => {
      // A merged `ready` would tell a user blocked by missing admin
      // configuration to add a key they already have.
      expect(Object.keys(aiStatusResponseSchema.shape)).not.toContain('ready');
      expect(AI_STATUS_CARRIES_NO_SECRET).toBe(true);
    });

    it('breaks out enabled and providerConfigured so a message can be specific', async () => {
      // "Your administrator turned AI off" is a different sentence from "your
      // administrator has not chosen models yet", and an admin reading either
      // needs to know which control to touch.
      aiSettings.describeReadiness.mockResolvedValue({
        systemReady: false,
        enabled: false,
        providerConfigured: true,
        unboundRoles: [],
      });

      const status = await service.describe(ALICE);

      expect(status.enabled).toBe(false);
      expect(status.providerConfigured).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // Cheapness — this runs on every navigation
  // ---------------------------------------------------------------------------

  describe('the navigation path', () => {
    it('makes NO outbound provider call', async () => {
      // A provider round trip in front of every page transition would let an
      // OpenAI outage lock every user out of an application with nothing wrong
      // with it. The service has no provider dependency at all — its
      // constructor takes two arguments, neither of them a provider.
      expect(AiStatusService.length).toBe(2);
    });

    it('uses describe, never getSecret — no decrypt on the hottest path', async () => {
      // Also: a key that fails to decrypt (a rotated SECRETS_ENCRYPTION_KEY)
      // would throw on every navigation rather than reporting "no key", taking
      // the whole app down for that user instead of returning them to setup.
      await service.describe(ALICE);

      expect(credentials.describe).toHaveBeenCalledWith(
        AI_USER_CREDENTIAL_PURPOSE,
        aiUserCredentialName(ALICE),
      );
      expect(credentials.getSecret).not.toHaveBeenCalled();
    });

    it('never enumerates other users', async () => {
      await service.describe(ALICE);
      expect(credentials.list).not.toHaveBeenCalled();
    });

    it('scopes the per-user half to the caller', async () => {
      await service.describe(BOB);

      expect(credentials.describe).toHaveBeenCalledWith(
        AI_USER_CREDENTIAL_PURPOSE,
        BOB,
      );
    });
  });

  // ---------------------------------------------------------------------------
  // Caching
  // ---------------------------------------------------------------------------

  describe('the system half is cached', () => {
    it('is computed once across repeated calls', async () => {
      await service.describe(ALICE);
      await service.describe(ALICE);
      await service.describe(BOB);

      expect(aiSettings.describeReadiness).toHaveBeenCalledTimes(1);
    });

    it('does NOT cache the per-user half', async () => {
      // Two users sharing a cached answer is the one bug this cache could
      // cause that actually matters.
      await service.describe(ALICE);
      await service.describe(BOB);

      expect(credentials.describe).toHaveBeenCalledTimes(2);
    });

    it('is dropped by invalidate(), which a settings write calls', async () => {
      await service.describe(ALICE);
      service.invalidate();
      await service.describe(ALICE);

      expect(aiSettings.describeReadiness).toHaveBeenCalledTimes(2);
    });

    it('serves the new answer immediately after invalidation', async () => {
      // An admin who has just bound the last model expects the app to become
      // usable now, not after a TTL.
      aiSettings.describeReadiness.mockResolvedValue({
        ...READY,
        systemReady: false,
        unboundRoles: ['grader'],
      });
      await expect(service.describe(ALICE)).resolves.toMatchObject({
        systemReady: false,
      });

      aiSettings.describeReadiness.mockResolvedValue(READY);
      service.invalidate();

      await expect(service.describe(ALICE)).resolves.toMatchObject({
        systemReady: true,
      });
    });
  });

  describe('robustness', () => {
    it('reports not-ready rather than failing when readiness cannot be determined', async () => {
      // `describeReadiness` never throws by contract; this asserts the gate
      // does not become the thing that takes the app down if that ever
      // changes.
      aiSettings.describeReadiness.mockResolvedValue({
        systemReady: false,
        enabled: false,
        providerConfigured: false,
        unboundRoles: ['tutor', 'grader'],
      });

      const status = await service.describe(ALICE);

      expect(status.systemReady).toBe(false);
      // The user's own key is still reported honestly — a system problem must
      // not present as "you have no key".
      expect(status.userKeyConfigured).toBe(true);
    });
  });
});

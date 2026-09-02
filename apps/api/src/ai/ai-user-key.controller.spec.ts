import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { Test, TestingModule } from '@nestjs/testing';

import { AiUserKeyController } from './ai-user-key.controller';
import { AiUserKeyService } from './ai-user-key.service';
import { AiStatusService } from './ai-status.service';
import {
  AI_USER_KEY_STATUS_CARRIES_NO_SECRET,
  updateAiUserKeySchema,
} from './dto/ai-user-key.dto';
import { PERMISSIONS_KEY } from '../auth/decorators/permissions.decorator';
import { PatService } from '../pat/pat.service';

// =============================================================================
// AiUserKeyController — tests (issue #35, epic #25)
// =============================================================================
//
// The security property this controller exists to hold is a NEGATIVE one: no
// route accepts a user id. A test that only exercises the happy path cannot
// see that, because the absence of a parameter has no behaviour.
//
// So the first block below reads the controller's own SOURCE and asserts the
// absence directly — the same technique `deploy/repo.test.ts` uses to keep
// hardcoded identifiers out of the CLI, and the same one
// `__tests__/config/destinations.test.ts` uses to keep the web's route table
// honest. A `@Param('userId')` added later fails here rather than in review.
// =============================================================================

const ALICE = '11111111-1111-4111-8111-111111111111';

/**
 * The controller's source with comments removed.
 *
 * COMMENTS ARE STRIPPED DELIBERATELY. The assertions below are about what the
 * code does, and the file's own header explains the rule by quoting the very
 * decorators the rule forbids — matching those would make the test fail for
 * documenting itself, and would tempt whoever hit it to weaken the assertion
 * instead of the comment.
 *
 * The stripper is intentionally crude: it does not understand a `//` inside a
 * string literal. That is safe here because the assertions are all
 * `not.toContain`, so over-stripping can only cause a false PASS on a line
 * this controller does not have, and the file is 150 lines that a reviewer
 * reads anyway.
 */
const CONTROLLER_SOURCE = readFileSync(
  join(__dirname, 'ai-user-key.controller.ts'),
  'utf8',
)
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');

describe('AiUserKeyController — no route accepts a user id', () => {
  it('declares no @Param at all', () => {
    // These routes address one thing — the caller's own key — and it comes
    // from the session. A path parameter here has no legitimate use.
    expect(CONTROLLER_SOURCE).not.toMatch(/@Param\(/);
  });

  it('declares no @Query at all', () => {
    expect(CONTROLLER_SOURCE).not.toMatch(/@Query\(/);
  });

  it('mentions no user-identifying request field', () => {
    // Catches the body-field route to the same widening, which `@Param`
    // absence alone would not.
    for (const forbidden of [
      "'userId'",
      '"userId"',
      "'user_id'",
      "'targetUserId'",
      "'id'",
    ]) {
      expect(CONTROLLER_SOURCE).not.toContain(`@Body(${forbidden}`);
      expect(CONTROLLER_SOURCE).not.toContain(`@Param(${forbidden}`);
      expect(CONTROLLER_SOURCE).not.toContain(`@Query(${forbidden}`);
    }
  });

  it('takes the user id from @CurrentUser and nowhere else', () => {
    const currentUserUses = CONTROLLER_SOURCE.match(/@CurrentUser\('id'\)/g);
    // One per route: GET /status, GET /key, PUT /key, DELETE /key,
    // POST /key/test.
    expect(currentUserUses).toHaveLength(5);
  });

  it('never reaches CredentialsService directly', () => {
    // `list('ai-user')` enumerates every user's key metadata. The controller
    // has no route to it because it has no reference to the store at all.
    expect(CONTROLLER_SOURCE).not.toContain('CredentialsService');
    expect(CONTROLLER_SOURCE).not.toContain("list(");
  });
});

describe('AiUserKeyController', () => {
  let controller: AiUserKeyController;
  let service: {
    describe: jest.Mock;
    set: jest.Mock;
    remove: jest.Mock;
    test: jest.Mock;
  };
  let status: { describe: jest.Mock };

  beforeEach(async () => {
    service = {
      describe: jest.fn().mockResolvedValue({ configured: true }),
      set: jest.fn().mockResolvedValue(undefined),
      remove: jest.fn().mockResolvedValue(undefined),
      test: jest.fn().mockResolvedValue({ success: true }),
    };
    status = {
      describe: jest
        .fn()
        .mockResolvedValue({ userKeyConfigured: true, systemReady: true }),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [AiUserKeyController],
      providers: [
        { provide: AiUserKeyService, useValue: service },
        { provide: AiStatusService, useValue: status },
        { provide: PatService, useValue: { validateToken: jest.fn() } },
      ],
    }).compile();

    controller = module.get(AiUserKeyController);
  });

  it('passes only the authenticated caller to every operation', async () => {
    await controller.getStatus(ALICE);
    await controller.getKey(ALICE);
    await controller.setKey({ apiKey: 'sk-x' } as never, ALICE);
    await controller.deleteKey(ALICE);
    await controller.testKey(ALICE);

    expect(status.describe).toHaveBeenCalledWith(ALICE);
    expect(service.describe).toHaveBeenCalledWith(ALICE);
    expect(service.set).toHaveBeenCalledWith(ALICE, 'sk-x');
    expect(service.remove).toHaveBeenCalledWith(ALICE);
    expect(service.test).toHaveBeenCalledWith(ALICE);
  });

  it('returns the fresh status after a write, so the client need not re-fetch', async () => {
    // A second round trip for something the write already knows races itself.
    await controller.setKey({ apiKey: 'sk-x' } as never, ALICE);

    expect(service.describe).toHaveBeenCalledWith(ALICE);
  });

  it('returns the fresh status after a delete', async () => {
    await controller.deleteKey(ALICE);

    expect(service.describe).toHaveBeenCalledWith(ALICE);
  });

  describe('gating', () => {
    it.each(['getStatus', 'getKey', 'setKey', 'deleteKey', 'testKey'] as const)(
      '%s declares NO permissions',
      (method) => {
        // Every authenticated user owns their own credentials. Gating these
        // would leave a Viewer unable to use the app at all, since a keyless
        // user is hard-blocked — the gate would make the product unusable for
        // the role it was meant to restrict.
        const permissions = Reflect.getMetadata(
          PERMISSIONS_KEY,
          AiUserKeyController.prototype[method],
        );
        expect(permissions ?? []).toEqual([]);
      },
    );

    it('answers 200 for a failed test rather than the POST default of 201', () => {
      const status = Reflect.getMetadata(
        '__httpCode__',
        AiUserKeyController.prototype.testKey,
      );
      expect(status).toBe(200);
    });
  });
});

describe('updateAiUserKeySchema', () => {
  it.each([[''], [null], [undefined]])(
    'accepts %p, which means "keep the stored one"',
    (apiKey) => {
      expect(updateAiUserKeySchema.safeParse({ apiKey }).success).toBe(true);
    },
  );

  it('does NOT trim a submitted key', () => {
    // A user pasting from a developer console is exactly who a silent trim
    // bites, and the failure has no visible cause.
    const padded = '  sk-with-significant-space  ';
    expect(updateAiUserKeySchema.parse({ apiKey: padded }).apiKey).toBe(padded);
  });

  it('bounds the length so a paste accident is refused by the validator', () => {
    expect(
      updateAiUserKeySchema.safeParse({ apiKey: 'x'.repeat(2000) }).success,
    ).toBe(false);
  });

  it('carries a compile-time proof that the status holds no secret', () => {
    // Including for the key's own owner: it is unreadable through the API by
    // design, and a lost key is replaced from the provider, not read back.
    expect(AI_USER_KEY_STATUS_CARRIES_NO_SECRET).toBe(true);
  });
});

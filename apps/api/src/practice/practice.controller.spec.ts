import 'reflect-metadata';
import { Test, TestingModule } from '@nestjs/testing';

import { PracticeController } from './practice.controller';
import { PracticeService } from './practice.service';
import { RBAC_EXTENSION_KEY } from '../auth/decorators/auth.decorator';
import { PERMISSIONS_KEY } from '../auth/decorators/permissions.decorator';
import { ROLES_KEY } from '../auth/decorators/roles.decorator';
import { PatService } from '../pat/pat.service';

// =============================================================================
// PracticeController — tests (issue #73, epic #52 / E3)
// =============================================================================
//
// The controller has almost no logic of its own — it resolves the caller from
// `@CurrentUser('id')` and forwards to `PracticeService` — so what is worth
// asserting is its SHAPE, the same posture `journey.controller.spec.ts` takes
// for the identical reason (practice-sessions.md §10): every route
// authenticated, none gated on a permission, and no route whose PARAMETERS
// could ever carry another learner's id.
//
// Unlike `JourneyController`, this controller DOES take path and query
// parameters — a session id, an attempt id, `page`/`pageSize` — so the
// structural assertion here is narrower and more precise than "no `@Param` or
// `@Query` at all": it is that the ONLY `@Param` names in the whole controller
// are `id` and `attemptId` (both session-scoped, never a user), and the only
// `@Query` is the pagination DTO, which is `z.strictObject` and carries its own
// rejection of `?userId=` (asserted at the integration layer). Nothing here
// could accept a caller-supplied identity even if a client tried.
// =============================================================================

const CALLER = '11111111-1111-4111-8111-111111111111';
const SESSION_ID = '22222222-2222-4222-8222-222222222222';
const ATTEMPT_ID = '33333333-3333-4333-8333-333333333333';

const ROUTE_METHODS = [
  'createSession',
  'listSessions',
  'getSession',
  'recordAttempt',
  'selfMarkAttempt',
  'completeSession',
] as const;

/** Nest's `RouteParamtypes` enum values, as embedded in `__routeArguments__` keys. */
const BODY = 3;
const QUERY = 4;
const PARAM = 5;

describe('PracticeController', () => {
  let controller: PracticeController;
  let practiceService: {
    createSession: jest.Mock;
    listSessions: jest.Mock;
    getSession: jest.Mock;
    recordAttempt: jest.Mock;
    selfMarkAttempt: jest.Mock;
    completeSession: jest.Mock;
  };

  beforeEach(async () => {
    practiceService = {
      createSession: jest.fn().mockResolvedValue({ marker: 'createSession' }),
      listSessions: jest.fn().mockResolvedValue({ marker: 'listSessions' }),
      getSession: jest.fn().mockResolvedValue({ marker: 'getSession' }),
      recordAttempt: jest.fn().mockResolvedValue({ marker: 'recordAttempt' }),
      selfMarkAttempt: jest.fn().mockResolvedValue({ marker: 'selfMarkAttempt' }),
      completeSession: jest.fn().mockResolvedValue({ marker: 'completeSession' }),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [PracticeController],
      providers: [
        { provide: PracticeService, useValue: practiceService },
        // `@Auth()` applies `JwtAuthGuard`, which injects `PatService`. Stubbed
        // so this spec stays about the controller, the same shape
        // `journey.controller.spec.ts` and `ai-user-key.controller.spec.ts` use.
        { provide: PatService, useValue: { validateToken: jest.fn() } },
      ],
    }).compile();

    controller = module.get(PracticeController);
  });

  // ---------------------------------------------------------------------------
  // The security shape
  // ---------------------------------------------------------------------------

  describe('the security shape', () => {
    it.each(ROUTE_METHODS)('requires authentication on %s, gated on nothing else', (method) => {
      const extensions = Reflect.getMetadata(
        'swagger/apiExtension',
        PracticeController.prototype[method],
      );

      // Read from the same metadata the OpenAPI document's own "Requires:"
      // line is rendered from, so the test and the published docs cannot
      // silently disagree about what a route enforces.
      expect(extensions?.[RBAC_EXTENSION_KEY]).toEqual({
        authenticated: true,
        roles: [],
        permissions: [],
      });
    });

    it.each(ROUTE_METHODS)('guards %s with the JWT guard', (method) => {
      const guards = (
        Reflect.getMetadata('__guards__', PracticeController.prototype[method]) ?? []
      ).map((guard: { name: string }) => guard.name);

      expect(guards).toContain('JwtAuthGuard');
    });

    it.each(ROUTE_METHODS)('gates %s on no permission and no role', (method) => {
      // Every authenticated user owns their own practice history, exactly as
      // they own their own learner profile and their own AI key. ROADMAP §7's
      // permission set is closed; practice-sessions.md §10 says this epic
      // introduces nothing into it.
      const handler = PracticeController.prototype[method];

      expect(Reflect.getMetadata(PERMISSIONS_KEY, handler)).toBeUndefined();
      expect(Reflect.getMetadata(ROLES_KEY, handler)).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // No route parameter can ever carry a user id
  // ---------------------------------------------------------------------------

  describe('no route accepts a user id in the path, query, or body', () => {
    function routeArgs(method: (typeof ROUTE_METHODS)[number]): Record<string, any> {
      return (
        Reflect.getMetadata('__routeArguments__', PracticeController, method) ?? {}
      );
    }

    /** Every `@Param`'s `data` (the name passed to `@Param('name')`), across the whole controller. */
    function paramNames(args: Record<string, any>): string[] {
      return Object.entries(args)
        .filter(([key]) => key.startsWith(`${PARAM}:`))
        .map(([, value]) => value.data);
    }

    it.each(ROUTE_METHODS)('%s carries no @Param or @Query named after a user', (method) => {
      const args = routeArgs(method);

      for (const name of paramNames(args)) {
        expect(name).not.toMatch(/user/i);
        expect(['id', 'attemptId']).toContain(name);
      }
    });

    it('takes a @Param("id") on every session-scoped route, and only those', () => {
      const withSessionId = ['getSession', 'recordAttempt', 'selfMarkAttempt', 'completeSession'];

      for (const method of withSessionId) {
        expect(paramNames(routeArgs(method as any))).toContain('id');
      }

      // Neither `createSession` (there is no session yet) nor `listSessions`
      // (the list itself, not one session) takes a session id.
      expect(paramNames(routeArgs('createSession'))).toEqual([]);
      expect(paramNames(routeArgs('listSessions'))).toEqual([]);
    });

    it('takes a @Param("attemptId") on self-mark alone', () => {
      expect(paramNames(routeArgs('selfMarkAttempt'))).toEqual(
        expect.arrayContaining(['id', 'attemptId']),
      );

      for (const method of ['createSession', 'listSessions', 'getSession', 'recordAttempt', 'completeSession']) {
        expect(paramNames(routeArgs(method as any))).not.toContain('attemptId');
      }
    });

    it('takes a @Query only on listSessions, and it is the pagination DTO', () => {
      // The DTO itself (`practice-session-query.dto.ts`) is `z.strictObject`
      // and documents why `?userId=` on it is a 400 — that behaviour is
      // asserted over real HTTP in the integration spec. Here the structural
      // fact is narrower: no OTHER route reads the query string at all, so no
      // other route has anywhere for a `?userId=` to land even in principle.
      for (const method of ROUTE_METHODS) {
        const args = routeArgs(method);
        const hasQuery = Object.keys(args).some((key) => key.startsWith(`${QUERY}:`));

        if (method === 'listSessions') {
          expect(hasQuery).toBe(true);
        } else {
          expect(hasQuery).toBe(false);
        }
      }
    });

    it('takes a @Body only on createSession and recordAttempt', () => {
      const withBody = ROUTE_METHODS.filter((method) => {
        const args = routeArgs(method);
        return Object.keys(args).some((key) => key.startsWith(`${BODY}:`));
      });

      expect(withBody.sort()).toEqual(['createSession', 'recordAttempt'].sort());
    });
  });

  // ---------------------------------------------------------------------------
  // Delegation: userId first, body/params forwarded, service value returned
  // ---------------------------------------------------------------------------

  describe('delegation', () => {
    it('createSession forwards the caller and the body, unchanged', async () => {
      const body = { kind: 'quick', plannedCount: 5 } as any;

      const result = await controller.createSession(CALLER, body);

      expect(practiceService.createSession).toHaveBeenCalledWith(CALLER, body);
      expect(result).toEqual({ marker: 'createSession' });
    });

    it('listSessions forwards the caller and the query, unchanged', async () => {
      const query = { page: 2, pageSize: 10 } as any;

      const result = await controller.listSessions(CALLER, query);

      expect(practiceService.listSessions).toHaveBeenCalledWith(CALLER, query);
      expect(result).toEqual({ marker: 'listSessions' });
    });

    it('getSession forwards the caller and the session id, unchanged', async () => {
      const result = await controller.getSession(CALLER, SESSION_ID);

      expect(practiceService.getSession).toHaveBeenCalledWith(CALLER, SESSION_ID);
      expect(result).toEqual({ marker: 'getSession' });
    });

    it('recordAttempt forwards the caller, the session id, and the body, unchanged', async () => {
      const body = { questionId: '44444444-4444-4444-8444-444444444444' } as any;

      const result = await controller.recordAttempt(CALLER, SESSION_ID, body);

      expect(practiceService.recordAttempt).toHaveBeenCalledWith(CALLER, SESSION_ID, body);
      expect(result).toEqual({ marker: 'recordAttempt' });
    });

    it('selfMarkAttempt forwards the caller, the session id, and the attempt id, unchanged', async () => {
      const result = await controller.selfMarkAttempt(CALLER, SESSION_ID, ATTEMPT_ID);

      expect(practiceService.selfMarkAttempt).toHaveBeenCalledWith(
        CALLER,
        SESSION_ID,
        ATTEMPT_ID,
      );
      expect(result).toEqual({ marker: 'selfMarkAttempt' });
    });

    it('completeSession forwards the caller and the session id, unchanged', async () => {
      const result = await controller.completeSession(CALLER, SESSION_ID);

      expect(practiceService.completeSession).toHaveBeenCalledWith(CALLER, SESSION_ID);
      expect(result).toEqual({ marker: 'completeSession' });
    });

    it('never forwards anything but the caller resolved from @CurrentUser', () => {
      // `@CurrentUser('id')` is a custom param decorator, recorded under a
      // `__customRouteArgs__` key rather than the built-in PARAM/QUERY/BODY
      // enum — its presence on every method is exercised by the delegation
      // tests above actually receiving `CALLER` as their first argument, which
      // proves the wiring rather than merely the metadata's shape.
      for (const method of ROUTE_METHODS) {
        const args: Record<string, any> =
          Reflect.getMetadata('__routeArguments__', PracticeController, method) ?? {};

        // The custom-decorator key is prefixed with a per-decorator hash
        // (`<hash>__customRouteArgs__:0`), not the literal string itself —
        // verified directly against Nest's own metadata rather than assumed.
        const hasCustomArg = Object.keys(args).some((key) =>
          key.includes('__customRouteArgs__'),
        );

        expect(hasCustomArg).toBe(true);
      }
    });
  });
});

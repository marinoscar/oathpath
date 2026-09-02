import 'reflect-metadata';
import { Test, TestingModule } from '@nestjs/testing';

import { JOURNEY_STAGES } from './journey-stages';
import { JourneyController } from './journey.controller';
import { JourneyService } from './journey.service';
import { RBAC_EXTENSION_KEY } from '../auth/decorators/auth.decorator';
import { PERMISSIONS_KEY } from '../auth/decorators/permissions.decorator';
import { ROLES_KEY } from '../auth/decorators/roles.decorator';
import { PatService } from '../pat/pat.service';

// =============================================================================
// JourneyController — tests (issue #65, epic #50)
// =============================================================================
//
// The controller has almost no logic, and that is the point: what is worth
// asserting is its SHAPE. Every route authenticated, none gated on a
// permission, and — the security property this whole module hangs on — no
// route that accepts a user id by any parameter at all.
// =============================================================================

const CALLER = '11111111-1111-4111-8111-111111111111';

const ROUTE_METHODS = [
  'getProfile',
  'updateProfile',
  'getHome',
  'listStages',
] as const;

describe('JourneyController', () => {
  let controller: JourneyController;
  let journeyService: {
    getProfile: jest.Mock;
    updateProfile: jest.Mock;
    getHome: jest.Mock;
  };

  beforeEach(async () => {
    journeyService = {
      getProfile: jest.fn().mockResolvedValue({ profile: {}, testVersions: [], states: [] }),
      updateProfile: jest.fn().mockResolvedValue({ profile: {}, testVersions: [], states: [] }),
      getHome: jest.fn().mockResolvedValue({}),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [JourneyController],
      providers: [
        { provide: JourneyService, useValue: journeyService },
        // `@Auth()` applies `JwtAuthGuard`, which injects `PatService`. Stubbed
        // rather than imported so this spec stays about the controller — the
        // same shape `ai-user-key.controller.spec.ts` uses.
        { provide: PatService, useValue: { validateToken: jest.fn() } },
      ],
    }).compile();

    controller = module.get(JourneyController);
  });

  describe('the security shape', () => {
    it.each(ROUTE_METHODS)('requires authentication on %s', (method) => {
      // `@Auth()` records what it enforces as an `x-rbac` vendor extension,
      // which is also what the OpenAPI document renders its "Requires:" line
      // from. Reading the same metadata here means the test and the published
      // documentation cannot disagree about what these routes enforce.
      const extensions = Reflect.getMetadata(
        'swagger/apiExtension',
        JourneyController.prototype[method],
      );

      expect(extensions?.[RBAC_EXTENSION_KEY]).toEqual({
        authenticated: true,
        roles: [],
        permissions: [],
      });
    });

    it.each(ROUTE_METHODS)('guards %s with the JWT guard', (method) => {
      const guards = (
        Reflect.getMetadata('__guards__', JourneyController.prototype[method]) ??
        []
      ).map((guard: { name: string }) => guard.name);

      expect(guards).toContain('JwtAuthGuard');
    });

    it.each(ROUTE_METHODS)('gates %s on no permission and no role', (method) => {
      // Every authenticated user owns their own profile. Gating these would
      // leave a Viewer — the default role — unable to complete orientation,
      // and `RequireOrientation` then hard-blocks them out of the product.
      // ROADMAP §7's permission set is closed; this epic adds nothing to it.
      const handler = JourneyController.prototype[method];

      expect(Reflect.getMetadata(PERMISSIONS_KEY, handler)).toBeUndefined();
      expect(Reflect.getMetadata(ROLES_KEY, handler)).toBeUndefined();
    });

    it.each(ROUTE_METHODS)(
      '%s accepts no path or query parameter at all',
      (method) => {
        // THE load-bearing assertion, and the reason it is written against
        // Nest's own metadata rather than against a URL: `__routeArguments__`
        // is keyed `<paramtype>:<index>`, where 4 is `@Param` and 5 is
        // `@Query`. If either ever appears here, some route has grown an
        // input that could name a learner — and cross-user access stops being
        // structurally impossible and starts depending on somebody
        // remembering to authorise it.
        //
        // The only decorators these handlers carry are `@CurrentUser` (a
        // custom factory, keyed `…__customRouteArgs__:n`) and, on the write,
        // one `@Body` (3), whose schema carries its own compile-time proof
        // that it names no user.
        const args: Record<string, unknown> =
          Reflect.getMetadata('__routeArguments__', JourneyController, method) ??
          {};

        const paramTypes = Object.keys(args).map((key) => key.split(':')[0]);

        expect(paramTypes).not.toContain('4');
        expect(paramTypes).not.toContain('5');
      },
    );

    it('takes a body on exactly one route, and it is the write', () => {
      const bodyRoutes = ROUTE_METHODS.filter((method) => {
        const args: Record<string, unknown> =
          Reflect.getMetadata('__routeArguments__', JourneyController, method) ??
          {};
        return Object.keys(args).some((key) => key.startsWith('3:'));
      });

      expect(bodyRoutes).toEqual(['updateProfile']);
    });
  });

  describe('delegation', () => {
    it('reads the profile for the authenticated caller only', async () => {
      await controller.getProfile(CALLER);
      expect(journeyService.getProfile).toHaveBeenCalledWith(CALLER);
    });

    it('writes the profile for the authenticated caller only', async () => {
      const body = { stateCode: 'CA' } as never;
      await controller.updateProfile(CALLER, body);

      expect(journeyService.updateProfile).toHaveBeenCalledWith(CALLER, body);
      // The id comes first and comes from `@CurrentUser`; the body is passed
      // straight through and carries no identity of its own (there is a
      // compile-time proof of that in the DTO).
      expect(journeyService.updateProfile.mock.calls[0][0]).toBe(CALLER);
    });

    it('reads home for the authenticated caller only', async () => {
      await controller.getHome(CALLER);
      expect(journeyService.getHome).toHaveBeenCalledWith(CALLER);
    });
  });

  describe('GET /journey/stages', () => {
    it('serves the registry in journey order', () => {
      expect(controller.listStages().map((s) => s.key)).toEqual(
        JOURNEY_STAGES.map((s) => s.key),
      );
    });

    it('serves copies, not the registry’s own objects', () => {
      // The registry is module-level state living for the process lifetime; a
      // serialiser or an interceptor mutating what it was handed must not be
      // able to reconfigure it for every later request.
      const [first] = controller.listStages();
      expect(first).not.toBe(JOURNEY_STAGES[0]);
      expect(first).toEqual({
        key: JOURNEY_STAGES[0].key,
        label: JOURNEY_STAGES[0].label,
        description: JOURNEY_STAGES[0].description,
      });
    });

    it('publishes only key, label and description', () => {
      // Mapped field by field so an internal field added to the registry
      // later does not silently become public API.
      for (const stage of controller.listStages()) {
        expect(Object.keys(stage).sort()).toEqual([
          'description',
          'key',
          'label',
        ]);
      }
    });

    it('does not touch the database', () => {
      controller.listStages();
      expect(journeyService.getProfile).not.toHaveBeenCalled();
    });
  });
});

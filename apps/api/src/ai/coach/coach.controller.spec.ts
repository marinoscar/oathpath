import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { Test, TestingModule } from '@nestjs/testing';

import { CoachController } from './coach.controller';
import { AI_COACH_PERSONAS } from './personas';
import { PERMISSIONS_KEY } from '../../auth/decorators/permissions.decorator';
import { PatService } from '../../pat/pat.service';
import { bannedFamilyHits } from './banned-topics';

// =============================================================================
// CoachController — tests (issue #320, epic #305)
// =============================================================================
//
// Two properties, and both of them are NEGATIVE — which is why a happy-path
// test alone would not see either:
//
//  1. `promptFragment` never reaches the wire. The registry entry has five
//     fields and the route serves four, and the whole guarantee is about the
//     one that is missing.
//  2. No route accepts a user id, so there is no "read somebody else's coach"
//     request to make in the first place, and no permission to invent.
//
// The source-reading block follows `ai-user-key.controller.spec.ts`, which
// establishes the technique in this directory for exactly this shape of
// claim.
// =============================================================================

/** The controller's source with comments stripped — see the sibling spec. */
const CONTROLLER_SOURCE = readFileSync(
  join(__dirname, 'coach.controller.ts'),
  'utf8',
)
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');

describe('CoachController', () => {
  let controller: CoachController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [CoachController],
      // `@Auth()` mounts `JwtAuthGuard`, which takes `PatService`. Stubbed
      // rather than imported: this suite is about what the route RETURNS and
      // what it does not gate on, and standing up real token validation to
      // ask that would be a slower test of something `auth`'s own suites
      // already own. Same stub, same reason, as
      // `ai-user-key.controller.spec.ts`.
      providers: [
        { provide: PatService, useValue: { validateToken: jest.fn() } },
      ],
    }).compile();

    controller = module.get<CoachController>(CoachController);
  });

  describe('GET /api/ai/coach/personas', () => {
    it('returns every persona in the registry, in registry order', () => {
      const { personas } = controller.getPersonas();

      expect(personas).toHaveLength(AI_COACH_PERSONAS.length);
      expect(personas.map((persona) => persona.key)).toEqual(
        AI_COACH_PERSONAS.map((persona) => persona.key),
      );
    });

    it('leads with `supportive`, so the default is the first card', () => {
      // Not cosmetic: `unfiltered` must never be preselected or lead, and the
      // page renders these in the order it receives them.
      expect(controller.getPersonas().personas[0].key).toBe('supportive');
    });

    it('serves exactly four fields, and `promptFragment` is not one of them', () => {
      // THE ASSERTION THIS FILE EXISTS FOR, and it is written over the ACTUAL
      // key set rather than as `toBeUndefined()` on one name: a sixth field
      // added to `CoachPersonaDef` next year must fail here, not ship.
      for (const persona of controller.getPersonas().personas) {
        expect(Object.keys(persona).sort()).toEqual([
          'description',
          'key',
          'label',
          'sampleLine',
        ]);
      }
    });

    it('never leaks a prompt fragment’s text, by value as well as by key', () => {
      // The belt to the previous test's braces: a fragment served under some
      // OTHER key would satisfy a key-set check and still be a leak.
      const body = JSON.stringify(controller.getPersonas());

      for (const persona of AI_COACH_PERSONAS) {
        if (persona.promptFragment.length === 0) continue;
        expect(body).not.toContain(persona.promptFragment);
      }
    });

    it('never serves the reaction bank', () => {
      // Selection is deterministic and server-side (`select-line.ts`); a
      // client holding the bank could pick its own line, which is the "two
      // reactions to one event" defect that function exists to prevent.
      expect(controller.getPersonas()).not.toHaveProperty('lines');
      expect(JSON.stringify(controller.getPersonas())).not.toContain(
        'answer.correct',
      );
    });

    it('serves copy that clears the invariant floor', () => {
      // `description` and `sampleLine` are learner-facing copy shipped over
      // this route, so they are held to the same banned-topic lint as the
      // bank itself. A persona described in the vocabulary the floor forbids
      // would be a floor violation on the settings page.
      for (const persona of controller.getPersonas().personas) {
        expect(bannedFamilyHits(persona.description)).toEqual([]);
        expect(bannedFamilyHits(persona.sampleLine)).toEqual([]);
      }
    });
  });

  describe('authorization', () => {
    it('requires no permission, so a Viewer can choose a coach', () => {
      // A Viewer is the DEFAULT role. Gating this would leave the role every
      // learner starts in unable to change how the app talks to them, and
      // there is no "may choose a coach" privilege in this product's model.
      const permissions = Reflect.getMetadata(
        PERMISSIONS_KEY,
        controller.getPersonas,
      );

      expect(permissions).toBeUndefined();
    });

    it('declares no @Param, so no request can name another learner', () => {
      expect(CONTROLLER_SOURCE).not.toMatch(/@Param\(/);
    });

    it('injects nothing — it reads a constant and returns it', () => {
      // No service, no repository, no credential. The narrowest surface this
      // epic could have given the settings page.
      expect(CONTROLLER_SOURCE).not.toMatch(/constructor\s*\(/);
    });
  });
});

import {
  AI_CAPABILITY_FAMILIES,
  AI_MODEL_ROLES,
  AI_MODEL_ROLE_KEYS,
  TEXT_CAPABILITY_FAMILIES,
  capabilityForRole,
  findModelRole,
  isModelRole,
  textModelRoles,
  wiredModelRoles,
} from './ai-model-roles';

// =============================================================================
// AI model-role registry (issue #27, epic #25)
// =============================================================================
//
// The registry's value is entirely in its being the ONE list. These tests
// therefore check the properties that make that true — derivation, key
// stability, and the wired/declared split — rather than restating its contents,
// which would be a second copy of the thing under test.
// =============================================================================

describe('AI_MODEL_ROLES', () => {
  it('declares all six slots epic #25 locks in', () => {
    // Decision 1: six declared — so voice work is not a settings schema change
    // and a migration over live admin configuration later. E9 (#88) is that
    // promise being cashed: `transcribe` and `speak` were wired by flipping a
    // boolean, and this length did not move.
    expect(AI_MODEL_ROLES).toHaveLength(6);
  });

  it('has unique keys', () => {
    // A duplicate would silently shadow one role in the key index, and the
    // shadowed one would render in the admin UI and never store.
    const keys = AI_MODEL_ROLES.map((role) => role.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('derives AI_MODEL_ROLE_KEYS from the registry, in order', () => {
    // The derivation claim: this is what makes "adding a role widens every
    // consuming switch in the same edit" true rather than aspirational.
    expect([...AI_MODEL_ROLE_KEYS]).toEqual(AI_MODEL_ROLES.map((r) => r.key));
  });

  it('freezes the derived key list', () => {
    // A caller that sorted or spliced it in place would silently reconfigure
    // every later consumer in the process.
    expect(Object.isFrozen(AI_MODEL_ROLE_KEYS)).toBe(true);
  });

  it('gives every role a declared capability family', () => {
    for (const role of AI_MODEL_ROLES) {
      expect(AI_CAPABILITY_FAMILIES).toContain(role.capability);
    }
  });

  it('gives every role real user-facing copy', () => {
    // The description is the only place the answer to "what am I choosing a
    // model FOR?" is written down, and it is what makes a sensible cost/
    // quality trade possible. A placeholder here is a silently useless
    // admin page.
    for (const role of AI_MODEL_ROLES) {
      expect(role.label.trim().length).toBeGreaterThan(0);
      expect(role.description.trim().length).toBeGreaterThan(20);
    }
  });

  it('wires every role something dispatches to, in registry order', () => {
    // E9 (#88) wired the two speech roles; E11 (#156) wired `realtime`, whose
    // dispatch is `AiProvider.createRealtimeSession`. A role nothing
    // dispatches to must stay unwired — wiring one makes every deployment
    // report an unbound model for a feature that does not exist.
    expect(wiredModelRoles().map((r) => r.key)).toEqual([
      'tutor',
      'grader',
      'transcribe',
      'speak',
      'realtime',
    ]);
  });

  it('leaves embed declared and inert', () => {
    // The last of the six with nothing behind it. Its slot exists so the epic
    // that wires it needs no settings-schema change and no migration over live
    // admin configuration — the same promise `realtime` has now cashed.
    expect(findModelRole('embed')?.wired).toBe(false);
  });

  it('orders the wired roles first', () => {
    // So an admin's live decisions are not below the inert ones.
    const firstUnwired = AI_MODEL_ROLES.findIndex((r) => !r.wired);
    const lastWired = AI_MODEL_ROLES.map((r) => r.wired).lastIndexOf(true);
    expect(lastWired).toBeLessThan(firstUnwired);
  });

  it('returns a fresh array from wiredModelRoles', () => {
    const first = wiredModelRoles();
    first.pop();
    expect(wiredModelRoles()).toHaveLength(5);
  });
});

describe('textModelRoles', () => {
  it('is exactly tutor and grader', () => {
    // `systemReady` is computed over these, NOT over every wired role. Had it
    // stayed on the wider set, wiring the two speech roles would have flipped
    // every already-deployed installation to not-ready on deploy — an admin
    // who changed nothing watching a working system report itself broken.
    expect(textModelRoles().map((r) => r.key)).toEqual(['tutor', 'grader']);
  });

  it('holds only roles that are both wired and a text family', () => {
    for (const role of textModelRoles()) {
      expect(role.wired).toBe(true);
      expect(TEXT_CAPABILITY_FAMILIES).toContain(role.capability);
    }
  });

  it('excludes the wired speech roles', () => {
    // The distinction the whole split exists for: a deployment with no `speak`
    // binding is a smaller product, not a broken one.
    expect(textModelRoles().map((r) => r.key)).not.toContain('speak');
    expect(textModelRoles().map((r) => r.key)).not.toContain('transcribe');
  });

  it('excludes the wired realtime role too', () => {
    // E11 (#156) wiring `realtime` is the E9 shape a second time, and it cost
    // no edit to this function: a realtime capability is not a text one, so
    // the role joined `unboundRoles` and left the hard-blocking gate alone by
    // construction. Had `systemReady` still been "no wired role unbound",
    // wiring it would have flipped every installation that has never
    // configured an interview model to not-ready on deploy.
    expect(findModelRole('realtime')?.wired).toBe(true);
    expect(textModelRoles().map((r) => r.key)).not.toContain('realtime');
  });

  it('keeps the generation floor meaningful for everything it contains', () => {
    // The floor applies only to text families. A text role outside this set
    // would mean `minModelGeneration` silently stopped constraining a model
    // the readiness gate depends on.
    for (const role of textModelRoles()) {
      expect(TEXT_CAPABILITY_FAMILIES).toContain(role.capability);
    }
  });

  it('returns a fresh array', () => {
    const first = textModelRoles();
    first.pop();
    expect(textModelRoles()).toHaveLength(2);
  });
});

describe('findModelRole', () => {
  it('resolves a declared role', () => {
    expect(findModelRole('grader')?.label).toBe('Grader');
  });

  it('returns undefined for an unknown key rather than throwing', () => {
    // Callers hold strings from persisted data — a settings row or a usage
    // event written before a role was removed. A decommissioned role must not
    // turn a settings page render into a 500.
    expect(findModelRole('role-that-was-removed')).toBeUndefined();
  });
});

describe('isModelRole', () => {
  it('accepts a declared role and rejects anything else', () => {
    expect(isModelRole('tutor')).toBe(true);
    expect(isModelRole('')).toBe(false);
    expect(isModelRole('toString')).toBe(false);
  });
});

describe('capabilityForRole', () => {
  it('reports the family a role needs', () => {
    expect(capabilityForRole('realtime')).toBe('realtime');
    expect(capabilityForRole('embed')).toBe('embedding');
  });

  it('returns undefined for an unknown role', () => {
    expect(capabilityForRole('nope')).toBeUndefined();
  });
});

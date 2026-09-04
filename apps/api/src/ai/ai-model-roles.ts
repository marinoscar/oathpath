// =============================================================================
// AI model-role registry (issue #27, epic #25)
// =============================================================================
//
// The six jobs this application asks a model to do, and what each one needs
// from a provider. An admin binds each role to a concrete model id; the
// bindings live in `ai-settings.schema.ts`'s `models` map, keyed by the
// `key` values below.
//
// -----------------------------------------------------------------------------
// WHY SIX ROLES AND NOT ONE "model" SETTING
// -----------------------------------------------------------------------------
//
// `VISION.md` names seven roles the AI companion must play, and they do not
// collapse onto one model because they are not one API surface. The `grader`
// runs on EVERY practice answer and must be cheap and sub-second; the `tutor`
// must be strong. Binding both to one model is either too expensive at grader
// volume or too weak at tutor quality, immediately — and the failure is not
// visible until it is a bill or a bad grade. See docs/specs/ai-settings.md §1.
//
// -----------------------------------------------------------------------------
// WHERE THIS LIVES, AND WHY IT IS NOT DUPLICATED IN apps/web
// -----------------------------------------------------------------------------
//
// The API owns this list; the web reads it over `GET /api/ai-settings/models`
// (#31). That is option 1 of the three `notifications/notification-events.ts`
// weighs, chosen here for the same reason: a duplicate in
// `apps/web/src/config` with a test asserting the two agree is DETECTION
// rather than prevention — the copies can still disagree in a working tree, in
// a branch, and in any build where the test is not run — and it breaks the
// epic's one-registry-entry promise directly.
//
// `packages/shared` exists and would be the structural home for shared
// contract, but it carries rebrandable CONSTANTS as plain CommonJS with a
// hand-written `.d.ts` and no build step. A registry the admin UI drives its
// selects from is a different kind of thing, and the web getting the SERVER's
// answer beats the web getting a second declaration a build could skew.
//
// This file is intentionally NOT a Nest provider. It is pure data and pure
// functions, so tests and the endpoint can consume it without standing up DI
// for a constant.
// =============================================================================

/**
 * The capability families a model can belong to.
 *
 * Derived type below rather than a hand-written union, so adding one widens
 * every `switch` in the same edit instead of silently falling through.
 *
 * WHY THIS AXIS EXISTS SEPARATELY FROM THE ROLE: the "5.4 and above" filter an
 * admin asks for is meaningful only for the TEXT families. Transcription, TTS
 * and embedding models use entirely different naming — `whisper-1`,
 * `tts-1-hd`, `text-embedding-3-large` — and applying a numeric generation
 * floor to them empties the dropdown rather than filtering it. The classifier
 * in `providers/openai.provider.ts` (#29) sorts model ids into these families
 * and the floor is applied only to {@link TEXT_CAPABILITY_FAMILIES}.
 *
 * `other` is the deliberate escape hatch: an id the classifier does not
 * recognise lands there and is SURFACED under the show-all view rather than
 * dropped. A model we cannot classify is not the same thing as a model that
 * does not exist, and treating them alike is how an upstream rename becomes an
 * admin with an empty dropdown and no workaround.
 */
export const AI_CAPABILITY_FAMILIES = [
  'text',
  'realtime',
  'transcribe',
  'tts',
  'embedding',
  'other',
] as const;

/** A model capability family. See {@link AI_CAPABILITY_FAMILIES}. */
export type AiCapabilityFamily = (typeof AI_CAPABILITY_FAMILIES)[number];

/**
 * The families a numeric generation floor may be applied to.
 *
 * A `readonly` array rather than an inline check at each call site, so the
 * answer to "does the floor apply here?" is written down once. See the note on
 * {@link AI_CAPABILITY_FAMILIES}.
 */
export const TEXT_CAPABILITY_FAMILIES: readonly AiCapabilityFamily[] = ['text'];

/**
 * One job the application asks a model to do, fully described for every
 * surface that binds, renders, or documents it.
 */
export interface AiModelRoleDef {
  /**
   * Stable key, persisted as a property name in the settings row's `models`
   * map and recorded on every `ai_usage_events` row (#34).
   *
   * RENAMING ONE IS A MIGRATION, not a refactor: an admin's stored binding
   * keyed by the old string becomes unreachable, so the role silently reverts
   * to unbound and the feature that depends on it starts reporting "your
   * administrator hasn't finished setting up the AI models" with nothing in
   * the audit trail to explain why. Add a new key and migrate the row.
   */
  key: string;

  /** Short human label, shown as the row heading on the admin bindings list. */
  label: string;

  /**
   * One sentence on what this role actually does, in the admin's terms. This
   * is the only place the answer to "what am I choosing a model FOR?" is
   * written down, and it is what makes a sensible cost/quality trade possible.
   */
  description: string;

  /**
   * The capability family a model must belong to in order to serve this role.
   *
   * Drives which models the admin's dropdown offers, and — via the provider's
   * capability flags (#28) — whether a given provider can serve the role at
   * all. Anthropic, Kimi and Qwen offer chat but no TTS, transcription or
   * realtime surface, so this is load-bearing rather than decorative.
   */
  capability: AiCapabilityFamily;

  /**
   * Is this role consumed by anything yet?
   *
   * `false` means DECLARED AND INERT: the schema carries a slot for it, the
   * admin page renders it with the registry's existing `disabled` card
   * treatment, and nothing dispatches to it. Epic #25, decision 1 — declaring
   * all six now means voice work does not need a settings-schema change and a
   * migration over live admin configuration later. E9 (#88) is that promise
   * being cashed: `transcribe` and `speak` became wired by flipping this
   * boolean, with no migration and no settings-schema change. E11 (#156)
   * cashed it a second time for `realtime`, the same way.
   *
   * `unboundRoles` (#36) is computed over EXACTLY the wired roles: an unwired
   * role with no binding is the normal state and must never be reported as
   * something an admin has left undone, or a fresh install could not become
   * ready no matter what they did.
   *
   * `systemReady` IS NARROWER THAN THAT — see {@link textModelRoles}. Wiring a
   * role is a statement about dispatch, not about whether the application as a
   * whole can run.
   */
  wired: boolean;
}

/**
 * The roles this application can bind a model to, in the order the admin page
 * renders them.
 *
 * Order is meaningful: the wired roles come first so an admin's live decisions
 * are not below the inert ones. `embed` is the only one left inert.
 */
export const AI_MODEL_ROLES: AiModelRoleDef[] = [
  {
    key: 'tutor',
    label: 'Tutor',
    description:
      'Explains civics answers, encourages, and guides study. Reaches for quality over cost — this is the voice the learner spends the most time with.',
    capability: 'text',
    wired: true,
  },
  {
    key: 'grader',
    label: 'Grader',
    description:
      'Decides whether a spoken or typed answer was right, and says why it was not. Runs on every practice answer, so it must be cheap and fast above all else.',
    capability: 'text',
    wired: true,
  },
  {
    key: 'transcribe',
    label: 'Speech recognition',
    description:
      'Turns a spoken answer into text, with a confidence signal that tells the grader whether an answer was wrong or simply misheard.',
    capability: 'transcribe',
    // Wired by E9 (#88): `AiProvider.transcribe` dispatches to it.
    wired: true,
  },
  {
    key: 'speak',
    label: 'Speech synthesis',
    description:
      'Reads questions and explanations aloud, for learners who understand spoken English less readily than written.',
    capability: 'tts',
    // Wired by E9 (#88): `AiProvider.synthesize` dispatches to it.
    wired: true,
  },
  {
    key: 'realtime',
    label: 'Interview simulator',
    description:
      'Runs a spoken mock interview that can interrupt and be interrupted naturally. Needs a speech-to-speech realtime model.',
    capability: 'realtime',
    // Wired by E11 (#156, epic #60): `AiProvider.createRealtimeSession`
    // dispatches to it — the mint call that hands a browser a short-lived
    // credential scoped to an interview session.
    //
    // WIRING IT DOES NOT MOVE `systemReady`, and that is the whole reason the
    // narrowing below exists: `realtime` is not a TEXT capability, so it joins
    // `unboundRoles` (an admin is told the interview simulator has no model)
    // without joining the hard-blocking gate (a learner with no realtime
    // binding practises by text, which is a smaller product, not a broken
    // one). See {@link textModelRoles}.
    wired: true,
  },
  {
    key: 'embed',
    label: 'Embeddings',
    description:
      'Clusters weak areas and retrieves relevant civics content. Batch work, so latency matters far less than cost.',
    capability: 'embedding',
    // Declared, not consumed. See `wired` above.
    wired: false,
  },
];

/**
 * The role keys, DERIVED from the registry above rather than hand-written.
 *
 * This is what makes "adding a role widens every consuming switch in the same
 * edit" true: `AiModelRole` below comes from this array, `aiSettingsSchema`'s
 * `models` map is built from it, and a `Record<AiModelRole, …>` anywhere fails
 * to compile until the new key is handled. A hand-written union would let a
 * new role fall through silently and bind to nothing.
 *
 * Frozen because a caller that sorted or spliced it in place would silently
 * reconfigure every later consumer in the process.
 */
export const AI_MODEL_ROLE_KEYS = Object.freeze(
  AI_MODEL_ROLES.map((role) => role.key),
) as readonly string[];

/**
 * A model role slot.
 *
 * NOTE THIS IS `string`, NOT A LITERAL UNION, and that is deliberate: the
 * registry above is a mutable array of a described interface, so a literal
 * union would require restating the six keys — the exact duplication this
 * file exists to avoid. Type safety over the SET of roles comes from
 * {@link AI_MODEL_ROLE_KEYS} and the schema built from it at runtime; the
 * compiler's job here is to stop a caller passing a non-string.
 */
export type AiModelRole = string;

/**
 * Key -> definition, built once at module load.
 *
 * The array above stays the source of truth because its ORDER is meaningful
 * (the admin page renders it). This index exists so per-request lookups are
 * not a linear scan.
 */
const ROLES_BY_KEY: ReadonlyMap<string, AiModelRoleDef> = new Map(
  AI_MODEL_ROLES.map((role) => [role.key, role]),
);

/**
 * The definition for `key`, or `undefined` when nothing is registered under it.
 *
 * RETURNS `undefined` RATHER THAN THROWING because callers frequently hold a
 * string that came from persisted data — a settings row written before a role
 * was removed, or a usage event recorded under a role that no longer exists. A
 * decommissioned role must not turn a settings page render into a 500; the
 * caller decides whether an unknown key is "skip it" or "this is a bug".
 */
export function findModelRole(key: string): AiModelRoleDef | undefined {
  return ROLES_BY_KEY.get(key);
}

/**
 * The roles something actually dispatches to.
 *
 * `unboundRoles` (#36) is computed over exactly these: an unwired role with no
 * binding is the normal state and must not be reported as configuration an
 * admin has left undone, or a fresh install could never become ready no matter
 * what they did. The two connection-test endpoints probe over these too — the
 * wired roles that have a binding.
 *
 * THIS IS NO LONGER WHAT `systemReady` IS COMPUTED OVER. It was, until E9
 * (#88) wired `transcribe` and `speak`; see {@link textModelRoles} for the
 * failure that would have caused and why the two answers are now different
 * questions.
 *
 * Returns a fresh array so a caller cannot mutate the registry's own state.
 */
export function wiredModelRoles(): AiModelRoleDef[] {
  return AI_MODEL_ROLES.filter((role) => role.wired);
}

/**
 * The wired roles whose capability is a TEXT family — `tutor` and `grader`
 * today.
 *
 * -----------------------------------------------------------------------------
 * WHY THIS EXISTS: FLIPPING TWO BOOLEANS WOULD OTHERWISE HAVE BROKEN EVERY
 * ALREADY-DEPLOYED INSTALLATION
 * -----------------------------------------------------------------------------
 *
 * `systemReady` (#36) used to be "provider chosen, master switch on, and no
 * WIRED role unbound" — i.e. computed over {@link wiredModelRoles}. E9 (#88)
 * wires `transcribe` and `speak`, and under the old rule that one edit would
 * have flipped every existing installation to `systemReady: false` on deploy:
 * an admin who changed nothing, whose tutor and grader are bound and working,
 * would find their system reporting itself broken and their learners hitting
 * `AiNotReady` on features that have nothing to do with voice. Nothing in the
 * release would have said why, because nothing failed — the definition moved
 * underneath them.
 *
 * So `systemReady` narrows to these roles, and the narrowing is load-bearing
 * rather than a convenience: it is the set of roles the HARD-BLOCKING gate
 * depends on. `RequireAiKey`, the navigation gate and `AiNotReady` all
 * ultimately ask "can this learner use the product at all", and the answer to
 * that is text — a learner with no `speak` binding reads the question instead
 * of hearing it, which is a smaller product, not a broken one.
 *
 * A VOICE SURFACE THEREFORE MUST NOT READ `systemReady`. It gates on its own
 * role's binding — `unboundRoles` names the role, which is precisely why that
 * field kept its wider meaning (#109's web surfaces need to say WHICH role is
 * missing, not merely that something is).
 *
 * E11 (#156) wiring `realtime` is the same shape a second time, and it landed
 * with no edit here at all: a `realtime` capability is not a text one, so the
 * role joined `unboundRoles` and left `systemReady` alone by construction.
 * That is the property this function was written to have — the next wired
 * non-text role costs nothing, and a wired TEXT role joins the gate in the
 * same edit that declares it.
 *
 * Derived from {@link TEXT_CAPABILITY_FAMILIES} rather than hard-coding
 * `['tutor', 'grader']`, so a third text role added to the registry joins the
 * readiness rule in the same edit — and a role moved to a non-text family
 * leaves it in the same edit too.
 *
 * Returns a fresh array, as {@link wiredModelRoles} does.
 */
export function textModelRoles(): AiModelRoleDef[] {
  return AI_MODEL_ROLES.filter(
    (role) => role.wired && TEXT_CAPABILITY_FAMILIES.includes(role.capability),
  );
}

/**
 * Is `key` a role this registry declares?
 *
 * Unknown key is `false`. Used to reject a binding for a role that does not
 * exist rather than storing it and having it silently ignored forever.
 */
export function isModelRole(key: string): boolean {
  return ROLES_BY_KEY.has(key);
}

/**
 * The capability family `key` needs, or `undefined` for an unknown role.
 *
 * The membership test the catalog filter (#31) needs on every render, kept
 * here so the answer is not re-derived — and re-derived subtly differently —
 * at each call site.
 */
export function capabilityForRole(key: string): AiCapabilityFamily | undefined {
  return ROLES_BY_KEY.get(key)?.capability;
}

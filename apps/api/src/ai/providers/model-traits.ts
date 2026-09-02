import { parseGeneration } from './model-classifier';

// =============================================================================
// OpenAI model traits (issue #176, epic #25)
// =============================================================================
//
// ONE CHAT REQUEST SHAPE DOES NOT FIT EVERY CHAT MODEL, even though they all
// answer on `POST /v1/chat/completions` and all classify into the same `text`
// family. The `o`-series and the `gpt-5` line are REASONING models: they spend
// completion budget on hidden reasoning tokens before emitting a visible one,
// they reject `temperature` and `top_p`, and they take an instruction turn as
// `developer` rather than `system`. The `gpt-4` line is the mirror image — it
// rejects `reasoning_effort` outright as an unknown parameter.
//
// Sending the wrong shape does not degrade; it 400s. Issue #176 is the clearest
// case: the reachability probe asked for ONE completion token, a reasoning
// model spent it on reasoning, OpenAI answered `400 Could not finish the
// message because max_tokens or model output limit was reached`, and the admin
// page reported a perfectly good key as unable to reach the model it is bound
// to. The remedy an admin would reach for — rotate the key — could not have
// worked.
//
// This module is the ONE place that knows which shape an id takes, so the probe
// and the completion path cannot disagree about it.
//
// -----------------------------------------------------------------------------
// TABLE-DRIVEN AND ORDERED, FOR THE SAME REASON model-classifier.ts IS
// -----------------------------------------------------------------------------
//
// The lines overlap in the string sense — `o1-mini` matches `^o\d` exactly as
// `o3-mini` does, while needing a different instruction role — so the ORDER of
// the rules below is the specification, not an implementation detail. Each rule
// says why it sits where it does.
//
// -----------------------------------------------------------------------------
// AN UNRECOGNISED ID GETS THE CONSERVATIVE SHAPE, NEVER THE REASONING ONE
// -----------------------------------------------------------------------------
//
// These traits are a best guess about a naming scheme that is not ours to
// control, so being wrong is a matter of when. The two directions of wrong are
// not symmetric:
//
//   * guessed non-reasoning, actually reasoning → we send a plain chat request,
//     which every chat model accepts; at worst the model runs out of budget and
//     the provider's output-limit rule reads that as "reached, ran, stopped".
//   * guessed reasoning, actually not → we send `reasoning_effort` to a model
//     that rejects the parameter, on the first attempt, for every call.
//
// So a `gpt-` id whose generation will not parse is NOT assumed to be
// reasoning. Between this default and the provider's single stripped retry, a
// wrong guess is recoverable in both directions.
//
// THIS MODULE IS PURE. No Nest, no SDK, no I/O — the tests next door exercise
// every rule without DI or a network.
// =============================================================================

/** What one model id needs from a chat request. */
export interface OpenAiModelTraits {
  /** Does this model spend completion budget on hidden reasoning tokens? */
  reasoning: boolean;

  /** Does it accept `temperature`/`top_p`? Reasoning models reject them. */
  supportsSampling: boolean;

  /**
   * Does it accept `reasoning_effort`? Non-reasoning models reject it as an
   * unknown parameter.
   */
  supportsReasoningEffort: boolean;

  /**
   * The lowest effort value this model accepts, or null when it takes none.
   * `gpt-5+` takes 'minimal'; the o-series' floor is 'low'.
   */
  minimumReasoningEffort: 'minimal' | 'low' | null;

  /**
   * Which role an instruction message must be sent as. The legacy
   * `o1-mini`/`o1-preview` accept neither `system` nor `developer`, so they get
   * 'user'.
   */
  instructionRole: 'system' | 'developer' | 'user';

  /** The smallest completion budget that can produce a visible token on this model. */
  minCompletionTokens: number;
}

/**
 * A floor for a plain chat model.
 *
 * Enough for a probe's one-word answer with room for a tokeniser that splits it
 * unexpectedly. Not 1: a budget of one token is a coin flip on whether the
 * model can say anything at all, and the probe is meant to test the key rather
 * than the tokeniser.
 */
const CHAT_MIN_COMPLETION_TOKENS = 16;

/**
 * A floor for a reasoning model.
 *
 * A reasoning model must be able to FINISH its reasoning pass before it can
 * emit a single visible token, so a small cap is not a cheap probe — it is a
 * guaranteed `400 ... model output limit was reached`, which is precisely the
 * bug in #176.
 *
 * THIS IS A CEILING, NOT A PURCHASE. `max_completion_tokens` bounds what the
 * model may spend; billing follows the tokens actually used, and at
 * minimal/low effort a "ping" costs a small fraction of this. Raising the
 * ceiling makes the probe possible; it does not make it expensive.
 */
const REASONING_MIN_COMPLETION_TOKENS = 2048;

/**
 * The shape every chat model accepts, and the answer for anything unrecognised.
 *
 * `system` for the instruction role because that is what the `gpt-4` line and
 * every third-party OpenAI-compatible endpoint understands; no sampling
 * parameters are sent today, but `supportsSampling` records that they would be
 * legal here.
 */
const CHAT_TRAITS: OpenAiModelTraits = {
  reasoning: false,
  supportsSampling: true,
  supportsReasoningEffort: false,
  minimumReasoningEffort: null,
  instructionRole: 'system',
  minCompletionTokens: CHAT_MIN_COMPLETION_TOKENS,
};

/** One traits rule: which ids it claims, and what they need. */
interface TraitRule {
  /** The model line this rule describes, for readability at the call site. */
  line: string;

  /**
   * Does `modelId` belong to this line?
   *
   * `generation` is passed in already parsed rather than re-derived per rule,
   * so there is exactly one parser for a model id's generation in this
   * codebase — `model-classifier.ts`'s, with its documented decimal semantics.
   */
  test: (modelId: string, generation: number | null) => boolean;

  traits: OpenAiModelTraits;
}

/**
 * The rules, IN PRIORITY ORDER. First match wins.
 *
 * Every id that matches none of them is a plain chat model — see
 * {@link CHAT_TRAITS} and the header's asymmetry argument.
 */
const TRAIT_RULES: TraitRule[] = [
  // ---- The legacy o1 previews, BEFORE the general o-series rule -------------
  //
  // `o1-mini` and `o1-preview` match `^o\d` exactly as `o3-mini` does, so this
  // rule must come first or they would inherit the wrong instruction role.
  // They are the one line that accepts NEITHER `system` NOR `developer`: an
  // instruction sent as either is a 400, and an instruction sent as `user` is
  // the documented workaround. They predate `reasoning_effort` entirely.
  {
    line: 'o1-mini / o1-preview',
    test: (modelId) => /^o1-(mini|preview)/i.test(modelId),
    traits: {
      reasoning: true,
      supportsSampling: false,
      supportsReasoningEffort: false,
      minimumReasoningEffort: null,
      instructionRole: 'user',
      minCompletionTokens: REASONING_MIN_COMPLETION_TOKENS,
    },
  },

  // ---- The rest of the o-series: o1, o3, o3-mini, o4-mini ------------------
  //
  // `developer` for instructions, and an effort floor of `low` — the o-series
  // has no `minimal` tier, so sending one is an `unsupported_value`, not a
  // cheaper request.
  {
    line: 'o-series',
    test: (modelId) => /^o\d/i.test(modelId),
    traits: {
      reasoning: true,
      supportsSampling: false,
      supportsReasoningEffort: true,
      minimumReasoningEffort: 'low',
      instructionRole: 'developer',
      minCompletionTokens: REASONING_MIN_COMPLETION_TOKENS,
    },
  },

  // ---- The gpt- line at generation 5 and above ------------------------------
  //
  // Where the `gpt-` line became a reasoning line. The generation is what
  // separates `gpt-5.4` from `gpt-4o`, so the rule is a prefix test AND a
  // number comparison rather than a string match on `gpt-5`, which would miss
  // `gpt-6` the day it ships.
  //
  // A NULL GENERATION DOES NOT MATCH. `parseGeneration` returns null for "I
  // could not tell", never for "old" — and per the header, an id we cannot read
  // takes the conservative shape rather than the reasoning one.
  {
    line: 'gpt-5+',
    test: (modelId, generation) =>
      /^(?:chat)?gpt-/i.test(modelId) && generation !== null && generation >= 5,
    traits: {
      reasoning: true,
      supportsSampling: false,
      supportsReasoningEffort: true,
      minimumReasoningEffort: 'minimal',
      instructionRole: 'developer',
      minCompletionTokens: REASONING_MIN_COMPLETION_TOKENS,
    },
  },
];

/**
 * What does a chat request to `modelId` need to look like?
 *
 * Total and never throws: an id from a naming scheme nobody anticipated — or
 * no id at all — yields the plain chat shape, which is the recoverable answer.
 *
 * Returns a COPY. The rule table is module state shared by every call, and a
 * caller that adjusted a returned object would silently rewrite the traits for
 * every model on that line for the life of the process.
 */
export function describeModelTraits(modelId: string): OpenAiModelTraits {
  if (typeof modelId !== 'string' || modelId.length === 0) {
    return { ...CHAT_TRAITS };
  }

  const generation = parseGeneration(modelId);

  for (const rule of TRAIT_RULES) {
    if (rule.test(modelId, generation)) return { ...rule.traits };
  }

  return { ...CHAT_TRAITS };
}

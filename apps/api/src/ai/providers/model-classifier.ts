import {
  TEXT_CAPABILITY_FAMILIES,
  type AiCapabilityFamily,
} from '../ai-model-roles';

// =============================================================================
// OpenAI model classification (issue #29, epic #25)
// =============================================================================
//
// `GET /v1/models` returns a flat, unordered list mixing chat, reasoning,
// realtime, transcription, TTS, embedding, image and moderation models, plus
// fine-tunes and long-deprecated ids. Handing that raw to an admin binding a
// `grader` model is not a usable surface; this file is what makes it one.
//
// -----------------------------------------------------------------------------
// TABLE-DRIVEN, NOT A CHAIN OF `if (id.includes(...))`
// -----------------------------------------------------------------------------
//
// The rules are data, and they are ORDERED — the first match wins. That
// matters because the families overlap in the string sense:
// `gpt-4o-realtime-preview` contains both `gpt-` and `realtime`, and
// `gpt-4o-transcribe` contains both `gpt-` and `transcribe`. Classifying
// either as chat would put a model into a dropdown that cannot run the request
// the role makes.
//
// So the specific families are tested BEFORE the generic text one, and the
// order below is the specification rather than an implementation detail. A new
// rule goes in the right place, not at the end.
//
// -----------------------------------------------------------------------------
// AN UNRECOGNISED ID IS `other`, NOT DROPPED
// -----------------------------------------------------------------------------
//
// Model naming is not ours to control. A classifier that silently discarded
// what it did not recognise would turn an upstream rename into "that model
// does not exist", with no way for an admin to find out otherwise — and the
// show-all escape hatch (#31) would have nothing to show. `other` is where
// those land, and they are surfaced.
//
// THIS MODULE IS PURE. No Nest, no SDK, no I/O — so the fixture-driven tests
// next door can exercise every rule without a network or DI.
// =============================================================================

/** One classification rule: a family, and the ids that belong to it. */
interface ClassificationRule {
  family: AiCapabilityFamily;

  /**
   * Matches an id belonging to this family.
   *
   * Anchored where it can be. A bare `.includes('tts')` would also match a
   * hypothetical `gpt-tts-adjacent-chat`, and the cost of a wrong family is a
   * model offered for a role it cannot serve.
   */
  test: RegExp;
}

/**
 * The rules, IN PRIORITY ORDER. First match wins — see the header.
 *
 * Deliberately conservative: a rule that is too narrow puts a model into
 * `other`, where an admin can still find it under show-all. A rule that is too
 * broad puts it into a dropdown for a role it cannot serve, where the failure
 * surfaces as a runtime error on a user's request. Narrow is the safe
 * direction.
 */
const CLASSIFICATION_RULES: ClassificationRule[] = [
  // ---- Specific families first ----------------------------------------------
  // `gpt-4o-realtime-preview`, `gpt-realtime`. Must precede the text rule:
  // both contain `gpt-`.
  { family: 'realtime', test: /realtime/i },

  // `whisper-1`, `gpt-4o-transcribe`, `gpt-4o-mini-transcribe`. Also must
  // precede the text rule.
  { family: 'transcribe', test: /(^whisper|transcribe)/i },

  // `tts-1`, `tts-1-hd`, `gpt-4o-mini-tts`. Anchored to a segment boundary so
  // `tts` inside an unrelated word does not match.
  { family: 'tts', test: /(^tts-|-tts$|-tts-)/i },

  // `text-embedding-3-small`, `text-embedding-ada-002`.
  { family: 'embedding', test: /embedding/i },

  // ---- Families this application does not bind, but must not mislabel -------
  //
  // Image and moderation models are real entries in the catalog and are not
  // text models. Without these rules `gpt-image-1` would classify as `text`
  // and be offered as a `tutor`. They land in `other`, which is honest: the
  // application has no role for them today.
  { family: 'other', test: /(^dall-e|^gpt-image|moderation)/i },

  // ---- The generic text family, last ----------------------------------------
  //
  // Chat and reasoning models share one family because they share one API
  // surface and one role type. `o1`/`o3`/`o4` are the reasoning line; `gpt-*`
  // and `chatgpt-*` the chat line.
  { family: 'text', test: /(^gpt-|^chatgpt-|^o\d)/i },
];

/**
 * Which family does `modelId` belong to?
 *
 * @returns the family, or `'other'` when no rule matches. Never throws, and
 *          never returns `undefined` — an unclassifiable id is a real state
 *          this application handles, not an error.
 */
export function classifyModel(modelId: string): AiCapabilityFamily {
  if (typeof modelId !== 'string' || modelId.length === 0) return 'other';

  for (const rule of CLASSIFICATION_RULES) {
    if (rule.test.test(modelId)) return rule.family;
  }

  return 'other';
}

/**
 * The generation number embedded in a model id, when one can be determined.
 *
 * `gpt-5.4` -> 5.4, `gpt-4o` -> 4, `gpt-4.1-mini` -> 4.1, `o3` -> 3.
 *
 * A NUMBER, NEVER A STRING. Compared as strings, `'10' < '9'`, so a
 * hypothetical `gpt-10` would rank below `gpt-9` — a filter bug whose only
 * symptom is a model that is not in the dropdown.
 *
 * KNOWN LIMITATION, STATED RATHER THAN HIDDEN: the fractional part is parsed
 * as a DECIMAL, not as a version segment. `gpt-5.10` therefore reads as 5.1
 * and would fall below a 5.4 floor even though its name suggests it is newer.
 * That is the semantics epic #25 asked for ("5.4 and above", stored as
 * `z.number()`), and every model OpenAI has shipped to date fits it —
 * `gpt-3.5`, `gpt-4.1`. If a two-digit minor ever appears, the model is
 * still reachable through the show-all escape hatch, which is exactly the
 * class of failure that hatch exists to make recoverable. Changing to a
 * version-tuple comparison would be a settings-schema change, not a local fix.
 *
 * @returns the generation, or `null` when the id carries none this function
 *          recognises. `null` MEANS "UNKNOWN", NEVER "OLD": callers must
 *          surface a null-generation model rather than filter it out, or an
 *          upstream naming change becomes an empty dropdown. See
 *          {@link passesGenerationFloor}.
 */
export function parseGeneration(modelId: string): number | null {
  if (typeof modelId !== 'string') return null;

  // The `gpt-`/`chatgpt-` line: a number, optionally with one decimal part,
  // directly after the family prefix. `gpt-4o` yields 4 — the `o` suffix is a
  // variant marker, not part of the number.
  const gpt = /^(?:chat)?gpt-(\d+(?:\.\d+)?)/i.exec(modelId);
  if (gpt) return Number.parseFloat(gpt[1]);

  // The reasoning line: `o1`, `o3-mini`, `o4-mini`. Bounded so `o1` does not
  // also match inside some other token.
  const reasoning = /^o(\d+(?:\.\d+)?)(?:$|[-_])/i.exec(modelId);
  if (reasoning) return Number.parseFloat(reasoning[1]);

  // Deliberately nothing else. A heuristic that scraped the first digit out of
  // any id would report `text-embedding-3-large` as generation 3 and
  // `whisper-1` as generation 1, and then a text-family floor of 5.4 would
  // look like it was working while silently doing nothing useful.
  return null;
}

/**
 * Does `generation` clear `floor`?
 *
 * THE NULL CASE IS THE POINT. An unparseable generation PASSES: the filter's
 * job is to hide models we know are too old, and "we could not tell" is not
 * that. Filtering them out is how an upstream rename empties a dropdown with
 * no error to explain it.
 */
export function passesGenerationFloor(
  generation: number | null,
  floor: number,
): boolean {
  if (generation === null) return true;
  return generation >= floor;
}

// -----------------------------------------------------------------------------
// Filtering
// -----------------------------------------------------------------------------
//
// APPLIED BY THE CALLER, NOT BAKED INTO THE FETCH. The provider's job is to
// answer "what models exist and what are they"; deciding which of them an
// admin should see is a presentation question that depends on the role being
// bound and on whether the show-all escape hatch is engaged. Baking it into
// `fetchModels` would mean the cache held a pre-filtered list and a change of
// floor needed a round trip.

/** How a catalog should be narrowed for one view. */
export interface CatalogFilter {
  /**
   * Restrict to one capability family. Absent means every family.
   *
   * The admin page passes the family the role needs, so a `grader` dropdown
   * never offers `whisper-1`.
   */
  family?: AiCapabilityFamily;

  /**
   * The generation floor, applied to the TEXT families only.
   *
   * See {@link TEXT_CAPABILITY_FAMILIES_NOTE} below for why this is not
   * applied everywhere.
   */
  minGeneration: number;

  /**
   * The escape hatch. When true, the floor is not applied at all and every
   * family is included — including `other`.
   *
   * This exists because model naming is not ours to control: a filter that
   * cannot be switched off eventually locks the product out of its own
   * configuration. An admin must always have a way to reach a model that
   * exists.
   */
  showAll: boolean;
}

/**
 * Narrow a classified catalog for one view.
 *
 * WHY THE FLOOR IS TEXT-ONLY: the families use entirely different naming
 * conventions. `whisper-1`, `tts-1-hd` and `text-embedding-3-large` carry no
 * comparable generation, so a floor of 5.4 would exclude every one of them —
 * the dropdown would be empty and the admin would have no way to tell a filter
 * from an outage. Only the `gpt-*` / `o*` line has a generation the floor can
 * mean anything against, and `TEXT_CAPABILITY_FAMILIES` is where that is
 * written down.
 *
 * Pure and total: it never throws, and an empty result is a legitimate answer
 * (a provider with no models in the requested family). The caller is
 * responsible for telling the difference between "filtered to nothing" and
 * "the fetch failed", which is why the fetch reports that separately.
 */
export function filterCatalog<T extends { family: AiCapabilityFamily; generation: number | null }>(
  models: T[],
  filter: CatalogFilter,
): T[] {
  return models.filter((model) => {
    if (filter.family !== undefined && model.family !== filter.family) {
      return false;
    }

    if (filter.showAll) return true;

    // `other` holds ids the classifier did not recognise, plus the image and
    // moderation models. Hidden from the default view because the application
    // has no role for them — and reachable under show-all, which is the
    // guarantee that an upstream rename never becomes an empty dropdown with
    // no workaround.
    if (model.family === 'other') return false;

    // THE FLOOR IS TEXT-ONLY. See the note on this function.
    if (!TEXT_CAPABILITY_FAMILIES.includes(model.family)) return true;

    return passesGenerationFloor(model.generation, filter.minGeneration);
  });
}

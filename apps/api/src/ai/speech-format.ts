// =============================================================================
// Speech containers and their MIME types (issue #284, epic #280)
// =============================================================================
//
// ONE PLACE, BECAUSE TWO CODE PATHS NOW ANSWER THE SAME QUESTION.
//
// Until #284 the only code that needed "what does an `mp3` come back as" was
// `OpenAiProvider.runSynthesis`, which derives the `Content-Type` from the
// format it ASKED for rather than from a response header a proxy or a mock may
// not set. `GET /api/ai/speech/audio` now needs the same answer on a path where
// no provider call happens at all: a cache HIT serves bytes read back out of
// object storage, and `speech_audio_assets` has no content-type column to read
// it from (it stores the `format`, which is the thing that actually determines
// it).
//
// A second copy of the map in the cache service would agree today and disagree
// the first time either moved, and the symptom would be a browser handed
// `audio/mp3` — a type some engines simply refuse to play, with the failure
// landing inside an `<audio>` element where nothing surfaces it. So the map
// moved here and both callers read it, rather than one of them re-deriving it.
//
// NOT A PROVIDER-SPECIFIC FACT. A container's MIME type is a registry entry,
// not a policy an AI provider owns — unlike the voice list
// (`OPENAI_TTS_VOICES`), which genuinely belongs to the provider and is
// deliberately declared in exactly one provider file. A second provider that
// synthesizes to `mp3` produces the same `audio/mpeg` bytes this one does.
// =============================================================================

/**
 * The container used when a caller names none.
 *
 * `mp3`: widely playable, small, and what every browser this application
 * targets can decode without a codec question. Read by the provider's own
 * synthesis fallback AND by the audio cache, which must know the format
 * BEFORE it can look a row up — the format is part of the cache key, so
 * "whatever the provider happens to default to" is not a value the lookup can
 * wait for.
 */
export const DEFAULT_SPEECH_FORMAT = 'mp3';

/**
 * Container -> MIME type, for synthesized audio.
 *
 * A LOOKUP, NOT `audio/${format}`. `mp3` is served as `audio/mpeg`, and a
 * browser handed `audio/mp3` may simply refuse to play it — the failure lands
 * in an audio element with no error anyone can see. Unknown formats fall back
 * to the octet-stream default rather than to a guess.
 */
export const SPEECH_CONTENT_TYPES: Readonly<Record<string, string>> = {
  mp3: 'audio/mpeg',
  opus: 'audio/ogg',
  aac: 'audio/aac',
  flac: 'audio/flac',
  wav: 'audio/wav',
  pcm: 'audio/L16',
};

/** The MIME type for a synthesised container. See {@link SPEECH_CONTENT_TYPES}. */
export function speechContentType(format: string): string {
  return SPEECH_CONTENT_TYPES[format] ?? 'application/octet-stream';
}

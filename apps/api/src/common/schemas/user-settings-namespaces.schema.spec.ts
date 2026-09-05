import {
  navigationSchema,
  studySchema,
  coachSchema,
  coachPatchSchema,
  COACH_PERSONAS,
  DEFAULT_COACH_PERSONA,
  DEFAULT_COACH_REACTIONS,
  voiceSchema,
  voicePatchSchema,
  VOICE_SPEECH_RATE_MIN,
  VOICE_SPEECH_RATE_MAX,
  DEFAULT_VOICE_AUTO_SUBMIT_SPOKEN,
  DEFAULT_VOICE_PREFER_PREMIUM,
  DEFAULT_VOICE_SPEECH_RATE,
  DEFAULT_VOICE_READ_QUESTIONS_ALOUD,
  DEFAULT_VOICE_READ_ANSWERS_ALOUD,
} from './user-settings-namespaces.schema';

describe('voiceSchema (issue #282, epic #280 "Spoken Civics Audio")', () => {
  it('round-trips every field', () => {
    const value = {
      autoSubmitSpoken: false,
      preferPremiumVoice: false,
      preferredVoice: 'alloy',
      speechRate: 1.25,
      readQuestionsAloud: true,
      readAnswersAloud: true,
    };

    expect(voiceSchema.parse(value)).toEqual(value);
  });

  it('accepts a namespace with no fields at all (every field is optional)', () => {
    expect(voiceSchema.parse({})).toEqual({});
  });

  it('rejects an unknown key (the schema is `.strict()`)', () => {
    expect(() => voiceSchema.parse({ autoSubmit: false })).toThrow();
  });

  describe('preferredVoice: shape-validated, not membership-validated', () => {
    it.each([
      ['a plain identifier', 'alloy'],
      ['digits and separators', 'voice_2-a'],
    ])('accepts %s', (_label, preferredVoice) => {
      expect(voiceSchema.parse({ preferredVoice }).preferredVoice).toBe(
        preferredVoice,
      );
    });

    it.each([
      ['a space', 'a b'],
      ['a slash', 'nova/2'],
      ['an empty string', ''],
      ['a value over 64 characters', 'a'.repeat(65)],
    ])('rejects %s', (_label, preferredVoice) => {
      expect(() => voiceSchema.parse({ preferredVoice })).toThrow();
    });
  });

  describe('speechRate: clamped to a sane range', () => {
    it.each([
      ['the minimum', VOICE_SPEECH_RATE_MIN],
      ['the maximum', VOICE_SPEECH_RATE_MAX],
      ['a mid-range value', 0.95],
    ])('accepts %s', (_label, speechRate) => {
      expect(voiceSchema.parse({ speechRate }).speechRate).toBe(speechRate);
    });

    it.each([
      ['just below the minimum', VOICE_SPEECH_RATE_MIN - 0.01],
      ['just above the maximum', VOICE_SPEECH_RATE_MAX + 0.01],
      ['far below the minimum', 0],
      ['far above the maximum', 10],
    ])('rejects %s', (_label, speechRate) => {
      expect(() => voiceSchema.parse({ speechRate })).toThrow();
    });
  });

  describe('every other field is a plain boolean', () => {
    it.each([
      'autoSubmitSpoken',
      'preferPremiumVoice',
      'readQuestionsAloud',
      'readAnswersAloud',
    ])('rejects a non-boolean %s', (field) => {
      expect(() => voiceSchema.parse({ [field]: 'yes' })).toThrow();
    });
  });

  describe('voicePatchSchema: every field also accepts null (restore the default)', () => {
    it('accepts every field set to null in the same request', () => {
      const patch = {
        autoSubmitSpoken: null,
        preferPremiumVoice: null,
        preferredVoice: null,
        speechRate: null,
        readQuestionsAloud: null,
        readAnswersAloud: null,
      };

      expect(voicePatchSchema.parse(patch)).toEqual(patch);
    });

    it('still enforces preferredVoice shape and speechRate range when non-null', () => {
      expect(() =>
        voicePatchSchema.parse({ preferredVoice: 'not a voice id!' }),
      ).toThrow();
      expect(() => voicePatchSchema.parse({ speechRate: 5 })).toThrow();
    });
  });

  describe('NEVER `.default()` — absent must mean "use the built-in default, resolved at read time"', () => {
    // This is the behavioural consequence of never writing `.default()` on
    // this namespace, stated as the file's own header states it: if any
    // field carried a `.default()`, parsing `{}` would materialise that
    // field's value into the result below, exactly as it would materialise
    // into a stored `user_settings` row the first time a learner touched any
    // unrelated preference. Asserting the parsed result is the empty object
    // is what catches that regression, rather than trusting the schema
    // source to stay written the right way.
    it('parsing an empty namespace produces an empty object, not a defaulted one', () => {
      expect(voiceSchema.parse({})).toEqual({});
    });

    it('the built-in defaults are read-time constants, not schema defaults', () => {
      // These constants exist for PracticeReminderTask's sibling to read at
      // the point of use — never for the schema to inject automatically.
      expect(DEFAULT_VOICE_AUTO_SUBMIT_SPOKEN).toBe(true);
      expect(DEFAULT_VOICE_PREFER_PREMIUM).toBe(true);
      expect(DEFAULT_VOICE_SPEECH_RATE).toBe(0.95);
      expect(DEFAULT_VOICE_READ_QUESTIONS_ALOUD).toBe(false);
      expect(DEFAULT_VOICE_READ_ANSWERS_ALOUD).toBe(false);

      // None of them appear when the namespace is absent from the parsed
      // value — confirming the schema never injects them itself.
      expect(voiceSchema.parse({})).not.toHaveProperty('autoSubmitSpoken');
      expect(voiceSchema.parse({})).not.toHaveProperty('speechRate');
    });
  });

  // Cross-namespace sanity check: the same "parsing `{}` yields `{}`" rule
  // this file's header states for every namespace, spot-checked against
  // `voice`'s pre-existing neighbours so a future namespace added without
  // reading the header still gets caught by this file when its own test is
  // added alongside these two.
  describe("the same no-default rule already holds for voice's neighbours", () => {
    it('navigationSchema and studySchema also produce {} from {}', () => {
      expect(navigationSchema.parse({})).toEqual({});
      expect(studySchema.parse({})).toEqual({});
    });
  });
});

describe('coachSchema (issue #317, epic #305 "The Coach\'s personality")', () => {
  it('round-trips both fields', () => {
    const value = { persona: 'playful' as const, reactions: false };

    expect(coachSchema.parse(value)).toEqual(value);
  });

  it('accepts a namespace with no fields at all (both fields are optional)', () => {
    expect(coachSchema.parse({})).toEqual({});
  });

  it('rejects an unknown key (the schema is `.strict()`)', () => {
    // `.strict()` is what turns a client typo into a 400 instead of a write
    // that returns 200 and stores nothing — the same silent-success failure
    // the namespaces file's header describes for a namespace missing from
    // `userSettingsSchema`.
    expect(() => coachSchema.parse({ personality: 'playful' })).toThrow();
  });

  describe('persona: a CLOSED enum', () => {
    it.each(COACH_PERSONAS)('accepts %s', (persona) => {
      expect(coachSchema.parse({ persona }).persona).toBe(persona);
    });

    it.each([
      ['an unknown persona', 'sarcastic'],
      ['a near-miss of a real one', 'Supportive'],
      ['an empty string', ''],
      ['a non-string', 3],
    ])('rejects %s', (_label, persona) => {
      // Closed, unlike `voice.preferredVoice` (shape-validated only) — the
      // accepted set here belongs to THIS application, not to a provider, so
      // there is no rolling-provider argument for accepting a value nothing
      // can resolve. A stored persona no registry entry matches would compose
      // feedback with no prompt fragment at all.
      expect(() => coachSchema.parse({ persona })).toThrow();
    });
  });

  it('rejects a non-boolean reactions', () => {
    expect(() => coachSchema.parse({ reactions: 'yes' })).toThrow();
  });

  describe('coachPatchSchema: every field also accepts null (restore the default)', () => {
    it('accepts both fields set to null in the same request', () => {
      const patch = { persona: null, reactions: null };

      expect(coachPatchSchema.parse(patch)).toEqual(patch);
    });

    it('still enforces the persona enum when non-null', () => {
      expect(() => coachPatchSchema.parse({ persona: 'sarcastic' })).toThrow();
    });
  });

  describe('NEVER `.default()` — absent must mean "use the built-in default, resolved at read time"', () => {
    // The same behavioural assertion the `voice` block above makes, and it
    // bites harder here: a `.default('supportive')` would materialise the
    // persona into a stored row the first time a learner touched any
    // unrelated preference, turning "nothing changes for existing accounts"
    // into "nothing ever changes for them" the day the default moves.
    it('parsing an empty namespace produces an empty object, not a defaulted one', () => {
      expect(coachSchema.parse({})).toEqual({});
      expect(coachSchema.parse({})).not.toHaveProperty('persona');
      expect(coachSchema.parse({})).not.toHaveProperty('reactions');
    });

    it('the built-in defaults are read-time constants, not schema defaults', () => {
      // `supportive` is exactly today's voice, so a learner who never opens
      // the setting experiences zero change; reactions default ON because the
      // coverage gap epic #305 exists to close is that most attempts say
      // nothing at all beyond the verdict.
      expect(DEFAULT_COACH_PERSONA).toBe('supportive');
      expect(DEFAULT_COACH_REACTIONS).toBe(true);

      // And the default persona is a member of the enum it defaults to — the
      // one way these two declarations could drift apart while both compile.
      expect(COACH_PERSONAS).toContain(DEFAULT_COACH_PERSONA);
    });
  });
});

import {
  FEDERAL_DISTRICT_AND_TERRITORY_CODES,
  US_STATE_AND_TERRITORY_CODES,
  US_STATES_AND_TERRITORIES,
  isValidStateOrTerritoryCode,
} from './us-states.constants';

// =============================================================================
// state_code must admit all six federal-district and territory codes
// =============================================================================
//
// docs/specs/journey-shell.md §3.2: the 2008 civics test's accepted answer
// for "who are your state's senators" covers DC/PR/GU/VI/AS/MP residents
// explicitly (they have none), so `learner_profiles.state_code` has to hold
// a real value for them from day one. This is issue #62's acceptance
// criterion "state_code accepts all six federal-district and territory
// codes, verified in the seed or a test" — this is that test.

describe('US_STATES_AND_TERRITORIES', () => {
  it('includes all six federal-district and territory codes', () => {
    expect(FEDERAL_DISTRICT_AND_TERRITORY_CODES).toEqual([
      'DC',
      'PR',
      'GU',
      'VI',
      'AS',
      'MP',
    ]);

    for (const code of FEDERAL_DISTRICT_AND_TERRITORY_CODES) {
      expect(US_STATE_AND_TERRITORY_CODES).toContain(code);
    }
  });

  it('gives every code exactly two uppercase characters', () => {
    for (const { code } of US_STATES_AND_TERRITORIES) {
      expect(code).toMatch(/^[A-Z]{2}$/);
    }
  });

  it('has no duplicate codes', () => {
    const unique = new Set(US_STATE_AND_TERRITORY_CODES);
    expect(unique.size).toBe(US_STATE_AND_TERRITORY_CODES.length);
  });

  it('has the expected total count: 50 states + DC + 5 territories', () => {
    expect(US_STATES_AND_TERRITORIES).toHaveLength(56);
    expect(US_STATE_AND_TERRITORY_CODES).toHaveLength(56);
  });

  it('pairs every code with a non-empty display name', () => {
    for (const { code, name } of US_STATES_AND_TERRITORIES) {
      expect(name).toBeTruthy();
      expect(typeof code).toBe('string');
    }
  });

  describe('isValidStateOrTerritoryCode', () => {
    it('accepts every territory and federal-district code', () => {
      for (const code of FEDERAL_DISTRICT_AND_TERRITORY_CODES) {
        expect(isValidStateOrTerritoryCode(code)).toBe(true);
      }
    });

    it('accepts an ordinary state code', () => {
      expect(isValidStateOrTerritoryCode('CA')).toBe(true);
    });

    it('rejects a code outside the set', () => {
      expect(isValidStateOrTerritoryCode('ZZ')).toBe(false);
      expect(isValidStateOrTerritoryCode('')).toBe(false);
      expect(isValidStateOrTerritoryCode('usa')).toBe(false);
    });
  });
});

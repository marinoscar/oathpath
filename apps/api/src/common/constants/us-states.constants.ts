// =============================================================================
// US State & Territory Codes (issue #62, epic #50)
// =============================================================================
//
// The canonical two-letter code domain for `learner_profiles.state_code`
// (docs/specs/journey-shell.md §3.2). This is more than the 50 states: it
// MUST also admit `DC`, `PR`, `GU`, `VI`, `AS`, `MP` — not an oversight to
// catch later, because the 2008 civics test's accepted answer for "who are
// your state's senators" already covers residents of these territories
// explicitly (they have none). A learner in Guam or Puerto Rico has to be
// able to record a real value here from day one.
//
// #65 (the orientation API) validates `state_code` against this list and
// serves it to the orientation form — this file is the single source for
// both, so the accepted set can't drift between validation and the UI.

export interface UsStateOrTerritory {
  code: string;
  name: string;
}

// The 50 states plus the federal district, in the order a form typically
// lists them (alphabetical by name), followed by the five populated US
// territories the 2008 test's civics content names explicitly.
export const US_STATES_AND_TERRITORIES: readonly UsStateOrTerritory[] = [
  { code: 'AL', name: 'Alabama' },
  { code: 'AK', name: 'Alaska' },
  { code: 'AZ', name: 'Arizona' },
  { code: 'AR', name: 'Arkansas' },
  { code: 'CA', name: 'California' },
  { code: 'CO', name: 'Colorado' },
  { code: 'CT', name: 'Connecticut' },
  { code: 'DE', name: 'Delaware' },
  { code: 'FL', name: 'Florida' },
  { code: 'GA', name: 'Georgia' },
  { code: 'HI', name: 'Hawaii' },
  { code: 'ID', name: 'Idaho' },
  { code: 'IL', name: 'Illinois' },
  { code: 'IN', name: 'Indiana' },
  { code: 'IA', name: 'Iowa' },
  { code: 'KS', name: 'Kansas' },
  { code: 'KY', name: 'Kentucky' },
  { code: 'LA', name: 'Louisiana' },
  { code: 'ME', name: 'Maine' },
  { code: 'MD', name: 'Maryland' },
  { code: 'MA', name: 'Massachusetts' },
  { code: 'MI', name: 'Michigan' },
  { code: 'MN', name: 'Minnesota' },
  { code: 'MS', name: 'Mississippi' },
  { code: 'MO', name: 'Missouri' },
  { code: 'MT', name: 'Montana' },
  { code: 'NE', name: 'Nebraska' },
  { code: 'NV', name: 'Nevada' },
  { code: 'NH', name: 'New Hampshire' },
  { code: 'NJ', name: 'New Jersey' },
  { code: 'NM', name: 'New Mexico' },
  { code: 'NY', name: 'New York' },
  { code: 'NC', name: 'North Carolina' },
  { code: 'ND', name: 'North Dakota' },
  { code: 'OH', name: 'Ohio' },
  { code: 'OK', name: 'Oklahoma' },
  { code: 'OR', name: 'Oregon' },
  { code: 'PA', name: 'Pennsylvania' },
  { code: 'RI', name: 'Rhode Island' },
  { code: 'SC', name: 'South Carolina' },
  { code: 'SD', name: 'South Dakota' },
  { code: 'TN', name: 'Tennessee' },
  { code: 'TX', name: 'Texas' },
  { code: 'UT', name: 'Utah' },
  { code: 'VT', name: 'Vermont' },
  { code: 'VA', name: 'Virginia' },
  { code: 'WA', name: 'Washington' },
  { code: 'WV', name: 'West Virginia' },
  { code: 'WI', name: 'Wisconsin' },
  { code: 'WY', name: 'Wyoming' },
  { code: 'DC', name: 'District of Columbia' },

  // Populated US territories — no US senators of their own, which is the
  // exact fact the 2008 civics test's accepted answer accounts for.
  { code: 'PR', name: 'Puerto Rico' },
  { code: 'GU', name: 'Guam' },
  { code: 'VI', name: 'U.S. Virgin Islands' },
  { code: 'AS', name: 'American Samoa' },
  { code: 'MP', name: 'Northern Mariana Islands' },
] as const;

export const US_STATE_AND_TERRITORY_CODES: readonly string[] =
  US_STATES_AND_TERRITORIES.map((entry) => entry.code);

export type UsStateOrTerritoryCode =
  (typeof US_STATES_AND_TERRITORIES)[number]['code'];

/** Federal-district and territory codes `learner_profiles.state_code` must admit alongside the 50 states — journey-shell.md §3.2. */
export const FEDERAL_DISTRICT_AND_TERRITORY_CODES: readonly string[] = [
  'DC',
  'PR',
  'GU',
  'VI',
  'AS',
  'MP',
];

export function isValidStateOrTerritoryCode(
  code: string,
): code is UsStateOrTerritoryCode {
  return US_STATE_AND_TERRITORY_CODES.includes(code);
}

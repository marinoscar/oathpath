/**
 * How a mastery state is worded and coloured — in ONE file.
 *
 * Issue #94, epic #54 / E5 "Memory". `/progress` renders the same five-state
 * breakdown on the overall summary and on every category card; one file for
 * the label and colour is how those two surfaces are kept from disagreeing
 * about what `lapsed` is called or which palette role it wears — the same
 * one-named-file argument `components/practice/outcome.ts` makes for
 * `PracticeOutcome`.
 *
 * =============================================================================
 * THE LOOKUP FALLS BACK. IT DOES NOT INDEX A `Record` AND HOPE.
 * =============================================================================
 *
 * `MasteryState` is a closed union in TypeScript (`types/index.ts`) and, by
 * that same file's own comment, an open set on the wire: a later migration
 * can add a sixth `question_mastery.state` value before a browser holding
 * this bundle reloads. So this function takes a plain `string` and falls
 * back to a neutral, honest label rather than rendering `undefined`.
 *
 * =============================================================================
 * COLOURS ARE PALETTE ROLES, NEVER HEX — SAME RULE AS `outcome.ts`
 * =============================================================================
 *
 * MUI role names, not literal colours, so dark mode is a re-render rather
 * than a second design.
 */

/** What a bar segment or chip says for one mastery state, and which palette role it wears. */
export interface MasteryStateDisplay {
  /** User-facing, and deliberately plain. */
  label: string;
  color: 'success' | 'error' | 'warning' | 'info' | 'default';
}

const MASTERY_STATES: Record<string, MasteryStateDisplay> = {
  new: {
    label: 'New',
    color: 'default',
  },
  learning: {
    label: 'Learning',
    color: 'info',
  },
  review: {
    label: 'In review',
    color: 'warning',
  },
  lapsed: {
    label: 'Lapsed',
    color: 'error',
  },
  mastered: {
    label: 'Mastered',
    color: 'success',
  },
};

/** Render order every breakdown in this app uses — least to most progressed. */
export const MASTERY_STATE_ORDER = [
  'new',
  'learning',
  'review',
  'lapsed',
  'mastered',
] as const;

export function masteryStateDisplay(state: string): MasteryStateDisplay {
  return (
    MASTERY_STATES[state] ?? {
      label: state,
      color: 'default',
    }
  );
}

// =============================================================================
// The mock interview engine's public surface (issue #123, epic #57 / E8)
// =============================================================================
//
// One import site for the whole engine. Everything re-exported here is pure —
// no NestJS, no Prisma, no `Clock`, no I/O — so a service, a task, a script or
// a spec can all use it the same way and none of them needs to know which file
// a given rule lives in.
// =============================================================================

export {
  INTERVIEW_PHASES,
  PHASE_TURNS,
  SKIPPED_PHASES,
  SMALLTALK_TURNS,
  N400_TURNS,
  SKIPPED_SEGMENT_TURNS,
  CLOSING_TURNS,
  isSkippedPhase,
  type InterviewPhase,
  type SkippedPhase,
} from './phases';

export { hashSeed, mulberry32, shuffleWithSeed } from './seeded-random';

export {
  N400_PROMPTS,
  ENGLISH_SEGMENT_LINES,
  FALLBACK_OFFICER_LINES,
  fallbackOfficerLine,
} from './officer-lines';

export {
  civicsStopReason,
  selectPassRule,
  planCivicsQuestions,
  startState,
  advancePhase,
  nextPrompt,
  applyAnswer,
  passedCivics,
  type CivicsStopReason,
  type InterviewPassRule,
  type InterviewPassRuleColumns,
  type InterviewState,
  type InterviewPrompt,
  type InterviewAnswerOutcome,
  type StartInterviewInput,
} from './interview-engine';

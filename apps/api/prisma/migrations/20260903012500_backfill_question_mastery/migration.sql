-- Data-only migration: no DDL. Populates question_mastery from every
-- (user_id, question_id) pair in practice_attempts that has at least one
-- attempt, so existing practice history is not invisible to the new
-- mastery-driven review queue the moment it ships. See the "Question
-- Mastery" comment block on schema.prisma (model QuestionMastery) for the
-- full column reasoning; this migration's own comments cover only the
-- backfill's derivation choices, which are deliberately approximate -- the
-- live scheduler (`nextSchedule`, issue #75) recomputes every row properly
-- on its very next attempt, so this only has to be reasonable, not exact.
--
-- gen_random_uuid() is used for the new rows' primary keys even though this
-- schema deliberately DROPPED database-side UUID defaults everywhere else
-- (see migration 20260831014110_drop_stale_uuid_defaults) in favor of
-- application-generated ids. That migration's reasoning is about the
-- ORDINARY write path -- every other insert in this application goes
-- through Prisma, which must supply the id itself. This migration has no
-- application code in the loop at all: it is one-time raw SQL run by the
-- migration runner, so a database-generated id here does not reintroduce
-- the pattern that migration removed.
WITH ordered_attempts AS (
  SELECT
    pa.user_id,
    pa.question_id,
    pa.outcome,
    pa.answered_at,
    -- Deterministic ordering: answered_at first, then created_at and id as
    -- tie-breakers for attempts recorded with the same answered_at (e.g.
    -- bulk-imported or backfilled history).
    ROW_NUMBER() OVER (
      PARTITION BY pa.user_id, pa.question_id
      ORDER BY pa.answered_at DESC, pa.created_at DESC, pa.id DESC
    ) AS rank_desc,
    -- The outcome of the attempt immediately BEFORE this one, in
    -- chronological order, per (user, question) pair -- used below to
    -- detect a correct -> incorrect transition (a "lapse").
    LAG(pa.outcome) OVER (
      PARTITION BY pa.user_id, pa.question_id
      ORDER BY pa.answered_at ASC, pa.created_at ASC, pa.id ASC
    ) AS previous_outcome
  FROM practice_attempts pa
),
-- Per-pair scalar aggregates, computed directly off ordered_attempts (one
-- row per attempt -- the window functions above do not collapse rows).
pair_aggregates AS (
  SELECT
    user_id,
    question_id,
    COUNT(*) AS total_attempts,
    -- Distinct CALENDAR DATES (UTC) with at least one correct attempt --
    -- not a count of correct attempts. Counting attempts would let one
    -- ten-minute drill session masquerade as durable recall; VISION.md's
    -- "never create artificial confidence after a few successful answers"
    -- is exactly the claim a same-day repeat correct answer must not make.
    COUNT(DISTINCT (answered_at AT TIME ZONE 'UTC')::date)
      FILTER (WHERE outcome = 'correct') AS distinct_correct_days,
    MAX(answered_at) AS last_attempt_at,
    BOOL_OR(outcome = 'correct') AS ever_correct,
    -- "lapses": a reasonable proxy, not the live scheduler's own definition
    -- (this is a one-time backfill, not nextSchedule -- see the header
    -- comment). Counts every point in this pair's chronological history
    -- where a correct attempt was immediately followed by an INCORRECT one
    -- specifically (not partial/skipped, which are not "was known, now
    -- missed" in the same unambiguous sense a wrong answer is).
    COUNT(*) FILTER (
      WHERE previous_outcome = 'correct' AND outcome = 'incorrect'
    ) AS lapses
  FROM ordered_attempts
  GROUP BY user_id, question_id
),
last_outcomes AS (
  SELECT user_id, question_id, outcome AS last_outcome
  FROM ordered_attempts
  WHERE rank_desc = 1
),
-- Trailing consecutive-correct streak ending at the MOST RECENT attempt:
-- walk backwards from rank_desc = 1 and stop counting at the first
-- non-correct attempt. running_non_correct is 0 for every attempt at or
-- more recent than (in recency order) the first non-correct one seen so far.
streak_walk AS (
  SELECT
    user_id,
    question_id,
    rank_desc,
    outcome,
    SUM(CASE WHEN outcome <> 'correct' THEN 1 ELSE 0 END)
      OVER (PARTITION BY user_id, question_id ORDER BY rank_desc) AS running_non_correct
  FROM ordered_attempts
),
correct_streaks AS (
  SELECT user_id, question_id, COUNT(*) AS correct_streak
  FROM streak_walk
  WHERE running_non_correct = 0 AND outcome = 'correct'
  GROUP BY user_id, question_id
)
INSERT INTO question_mastery (
  id,
  user_id,
  question_id,
  state,
  due_at,
  interval_days,
  ease,
  correct_streak,
  lapses,
  total_attempts,
  distinct_correct_days,
  last_outcome,
  last_attempt_at,
  created_at,
  updated_at
)
SELECT
  gen_random_uuid(),
  agg.user_id,
  agg.question_id,
  -- State derivation, conservative and applied in this precedence order:
  --   1. distinct_correct_days >= 3    -> mastered (sustained recall)
  --   2. last attempt was correct      -> learning (recent success, but not
  --                                       yet enough spaced evidence for
  --                                       "mastered")
  --   3. ever correct, but last wasn't -> lapsed (was known, now missed)
  --   4. never correct                 -> learning, NOT `new`. `new` means
  --                                       "never attempted" (see the
  --                                       QuestionMastery.state comment in
  --                                       schema.prisma); every pair this
  --                                       backfill inserts a row for has, by
  --                                       construction, at least one
  --                                       attempt, so `new` never applies
  --                                       here.
  CASE
    WHEN agg.distinct_correct_days >= 3 THEN 'mastered'
    WHEN lo.last_outcome = 'correct' THEN 'learning'
    WHEN agg.ever_correct THEN 'lapsed'
    ELSE 'learning'
  END::"MasteryState",
  CURRENT_TIMESTAMP,
  0,
  2.5,
  COALESCE(cs.correct_streak, 0),
  agg.lapses,
  agg.total_attempts,
  agg.distinct_correct_days,
  lo.last_outcome,
  agg.last_attempt_at,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM pair_aggregates agg
JOIN last_outcomes lo
  ON lo.user_id = agg.user_id AND lo.question_id = agg.question_id
LEFT JOIN correct_streaks cs
  ON cs.user_id = agg.user_id AND cs.question_id = agg.question_id
-- Defensive only: the table is brand new in this same release, so no row
-- can already exist for a pair. ON CONFLICT DO NOTHING makes this backfill
-- safely re-runnable rather than a hard failure if it ever is.
ON CONFLICT (user_id, question_id) DO NOTHING;

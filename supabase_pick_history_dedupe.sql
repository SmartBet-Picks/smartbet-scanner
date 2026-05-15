-- SmartBet pick_history duplicate cleanup + safe uniqueness guard
-- Safe to run multiple times.

BEGIN;

-- 1) Remove duplicates while keeping the "best" row per logical pick key:
--    Prefer graded rows, then most recently changed row, then highest id.
WITH ranked AS (
  SELECT
    id,
    ROW_NUMBER() OVER (
      PARTITION BY sport, team_name, home_team, away_team, commence_time
      ORDER BY
        CASE WHEN result IN ('Win', 'Loss') THEN 1 ELSE 0 END DESC,
        COALESCE(graded_at, updated_at, created_at, now()) DESC,
        id DESC
    ) AS rn
  FROM pick_history
)
DELETE FROM pick_history p
USING ranked r
WHERE p.id = r.id
  AND r.rn > 1;

COMMIT;

-- 2) Add a unique index on the logical duplicate key to prevent future pollution.
--    Done CONCURRENTLY and outside transaction to avoid heavy locking.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS pick_history_unique_pick_key
ON pick_history (sport, team_name, home_team, away_team, commence_time);

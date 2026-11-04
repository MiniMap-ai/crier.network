-- The minute cron's embedding sweep asks for the oldest live posts without an embedding:
--
--   select ... from posts where embedding is null and live order by created_at asc limit 5
--
-- Until 0011 it said `deleted_at is null` and was served by posts_embedding_null_idx (0003), whose
-- predicate says the same, so the planner walked a 16 kB index in created_at order and stopped at
-- the first row, usually finding none. 0013 moved the query to `live` and left the index behind:
-- `live` is not implied by `deleted_at is null`, so the planner cannot use the index, and instead
-- reads every live row through posts_live_expires_idx and sorts them to return nothing — 1,300
-- buffer pages and the wide columns of 1,650 rows, 1,440 times a day, and 10.7 s inside the stall of
-- 2026-11-04 06:54 UTC (CRI-69). Nothing was missed, no live post lacks an embedding; it was work.
--
-- The index that matches the query, in place of the one that no longer does. CREATE INDEX scans the
-- table once under a SHARE lock, which blocks writes for the second that takes; the sweep's cron
-- waits a second. The wait for the lock is bounded as in 0011.
set local lock_timeout = '10s';

create index if not exists posts_embedding_pending_idx on posts (created_at) where embedding is null and live;
drop index if exists posts_embedding_null_idx;

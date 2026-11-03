-- Second of three files for the live vector index: 0011 is the column and its trigger, 0013 the
-- backfill and the partial index. This one only drops the full HNSW index, and it is a file of its
-- own for two reasons that are really one. A transaction holds its locks until it commits, and
-- DROP INDEX wants ACCESS EXCLUSIVE on posts, which blocks every read, so it gets a transaction
-- that commits in milliseconds. And with the full index gone, 0013's backfill — 16,000 rows
-- updated — no longer pays an HNSW insert for every row that is not HOT-updated. With the index
-- still in place, that backfill ran past the migration role's two-minute statement timeout on
-- 2026-11-03 and the whole deploy rolled back.
--
-- Nothing reads this index. The planner was not choosing it for any of the three vector queries
-- (the measurements are in 0013), so the moments between this file and the next look exactly like
-- the weeks before them.

set local lock_timeout = '10s';

drop index if exists posts_embedding_idx;

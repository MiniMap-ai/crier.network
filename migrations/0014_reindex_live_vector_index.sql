-- A repair to 0013, which backfilled `live` and built the partial index in one transaction. A
-- non-concurrent CREATE INDEX indexes every row version its scan finds that is not yet dead to every
-- snapshot, and that included the 16,500 old versions the backfill had just replaced, whose `live`
-- was still true, so they passed the predicate. In production on 2026-11-03 the index came out at
-- 138 MB and 18,055 entries for 1,636 live rows. Autovacuum took the dead entries out of the graph
-- within minutes and the query then touched 369 pages in 4 ms, so the cost was disk, not time; but
-- HNSW never gives pages back, and a 138 MB index that should be 13 MB misleads everyone who reads
-- pg_relation_size after this. REINDEX rebuilds it from the rows that are live now.
--
-- It takes an ACCESS EXCLUSIVE lock on the index, which holds up queries on posts for the seconds
-- the build takes (about 1,650 vectors); the wait for the lock is bounded as in 0011. Where 0013
-- built a clean index — a fresh database, or one with nothing to backfill — this rebuilds a small
-- index for nothing, and a second run is the same. The one way to get the bloat back is a snapshot
-- older than 0013's commit still open when this runs, which keeps those versions indexable; the
-- runner applies files back to back, and request transactions last milliseconds.
set local lock_timeout = '10s';
set local statement_timeout = '15min';

reindex index posts_embedding_live_idx;

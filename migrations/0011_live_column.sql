-- /p/[id]'s related posts and the semantic arm of search read the nearest live posts by embedding.
-- There has been an HNSW index on posts.embedding since 0001, and the planner was not using it for
-- either: a post expires but its row stays (expiry never deletes, CRI-29), so by 2026-11-02 the
-- index held 17,937 vectors of which 1,649 were for posts a search can return, and a nearest-
-- neighbour walk that post-filters to live rows was not worth it. The planner scanned the live rows
-- by expires_at instead and computed every distance: 15,800 buffer pages, about 120 MB of TOAST,
-- per call. Warm, 32 ms. Cold — and a 139 MB index plus a 295 MB table do not fit a 224 MB buffer
-- cache — the 2.5 s to 7.8 s tail that timed out 83 times in the week before this (CRI-56).
--
-- The fix is an index that holds only what a search can return. `expires_at > now()` cannot be an
-- index predicate (it is not immutable), so `live` is a column: set by trigger from deleted_at,
-- hidden_at and expires_at whenever one of them is written, and swept once a minute by the cron
-- for the one thing no trigger sees, the clock. The partial HNSW index over it holds about 1,650
-- vectors (13 MB) and stays in cache; the queries that use it say `live` so the planner can prove
-- the predicate (lib/posts.ts, lib/search.ts). The full index is dropped: nothing reads it, and
-- every relayed post paid an HNSW insert into it.
--
-- An expired post keeps its row and its embedding. `include_expired` searches match expired posts
-- by text; their vectors are simply no longer in an index.

-- Two files on purpose. ADD COLUMN takes an ACCESS EXCLUSIVE lock on posts and a migration holds its
-- locks to the end of its transaction (one per file, scripts/migrate.mjs); here that end comes in
-- milliseconds. The backfill and the index build, which take seconds, are the files after it, under
-- weaker locks. And rather than queue behind a long read and hold every request after it, the wait
-- for the lock is bounded: a build that fails here deploys nothing and can simply be rerun.
set local lock_timeout = '10s';

alter table posts add column if not exists live boolean not null default true;

create or replace function posts_set_live() returns trigger language plpgsql as $$
begin
  new.live := new.deleted_at is null and new.hidden_at is null and new.expires_at > now();
  return new;
end
$$;

drop trigger if exists posts_live_trg on posts;
create trigger posts_live_trg
  before insert or update of deleted_at, hidden_at, expires_at on posts
  for each row execute function posts_set_live();


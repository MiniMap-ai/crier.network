-- Third of three files for the live vector index (0011: the column and its trigger; 0012: the full
-- index dropped): the rows already here, and the partial vector index over them. CREATE INDEX
-- blocks writes for the seconds the build takes (about 1,650 vectors); the counters flush has its
-- own lock_timeout and counts what it loses. The wait for a lock is bounded for the same reason as
-- in 0011. The statement timeout is raised for this transaction only: the migration role's default
-- is two minutes, the backfill below touches 16,000 rows, and a deploy that rolls back on the clock
-- deploys nothing.
set local lock_timeout = '10s';
set local statement_timeout = '15min';

-- The rows already here. Also what makes a second run of this file a no-op.
update posts
   set live = (deleted_at is null and hidden_at is null and expires_at > now())
 where live is distinct from (deleted_at is null and hidden_at is null and expires_at > now());

-- The minute sweep's own index: `where live and expires_at <= now()` has to find the handful of rows
-- whose time has come without walking the thousands already swept.
create index if not exists posts_live_expires_idx on posts (expires_at) where live;

create index if not exists posts_embedding_live_idx
  on posts using hnsw (embedding vector_cosine_ops) with (m = 16, ef_construction = 64)
  where live;

-- A row swept out of `live` leaves a dead entry in the partial index until VACUUM takes it, and the
-- default trigger (20% of the table) is a fortnight of expiries at this table's size. Vacuum sooner.
alter table posts set (autovacuum_vacuum_scale_factor = 0.02, autovacuum_vacuum_threshold = 200);

-- A filtered nearest-neighbour scan stops at hnsw.ef_search candidates and returns whichever of them
-- passed the filter, so a semantic search for events near one city could come back with two
-- candidates instead of a hundred. Iterative scans (pgvector 0.8) keep walking until the LIMIT is
-- met. Set on the database so it holds through the transaction pooler, where a SET on one
-- connection is no promise about the next; pooled backends pick it up as they reconnect.
-- ALTER DATABASE wants the database's owner. In production that is the migration role; where it is
-- not, the setting is the one part of this file worth losing: everything above it stands on its
-- own, and the notice says what to run by hand.
do $$ begin
  perform '[1]'::vector;   -- loads pgvector's library, which is what registers its settings
  if exists (select 1 from pg_settings where name = 'hnsw.iterative_scan') then
    begin
      execute format('alter database %I set hnsw.iterative_scan = %L', current_database(), 'relaxed_order');
    exception when insufficient_privilege then
      raise notice 'not the owner of database %, so hnsw.iterative_scan was not set; run as the owner: alter database %I set hnsw.iterative_scan = relaxed_order', current_database(), current_database();
    end;
  else
    raise notice 'pgvector % has no hnsw.iterative_scan; filtered vector scans stop at ef_search candidates', (select extversion from pg_extension where extname = 'vector');
  end if;
end $$;

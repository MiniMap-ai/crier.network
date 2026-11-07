-- CRI-62: a search whose query embedding failed ran on full-text and trigram alone, so finding
-- nothing there is not evidence that nobody posted it. embed_failed counts those searches per shape;
-- they are counted in n and never in zero (lib/search-log.ts, isUnmet). Rows written before this
-- column existed read 0, which is what they could tell us.
--
-- ADD COLUMN with a constant default changes only the catalog, but it takes an ACCESS EXCLUSIVE lock
-- on search_log that every metrics flush would queue behind. The wait for it is bounded as in 0011.
set local lock_timeout = '10s';

alter table search_log add column if not exists embed_failed integer not null default 0;

-- Expand now, contract later (DO-10). The deployment still serving while this build runs calls the
-- eight-argument bump_search, so that signature stays, as a wrapper, until a later migration drops
-- it. The nine-argument version has no defaults: with one on p_embed_failed, an eight-argument call
-- would match both signatures and fail as ambiguous.
create or replace function bump_search(
  p_q text, p_kind text, p_tags text, p_near text, p_radius_km integer, p_source text,
  p_n integer, p_zero integer, p_embed_failed integer
) returns void language sql as $$
  insert into search_log (day, q, kind, tags, near, radius_km, source, n, zero, embed_failed)
  values (current_date, p_q, p_kind, p_tags, p_near, p_radius_km, p_source, p_n, p_zero, p_embed_failed)
  on conflict (day, coalesce(q, ''), coalesce(kind, ''), coalesce(tags, ''), coalesce(near, ''), coalesce(radius_km, -1), source)
  do update set n = search_log.n + excluded.n, zero = search_log.zero + excluded.zero,
                embed_failed = search_log.embed_failed + excluded.embed_failed;
$$;

create or replace function bump_search(
  p_q text, p_kind text, p_tags text, p_near text, p_radius_km integer, p_source text,
  p_n integer default 1, p_zero integer default 0
) returns void language sql as $$
  select bump_search(p_q, p_kind, p_tags, p_near, p_radius_km, p_source, p_n, p_zero, 0);
$$;

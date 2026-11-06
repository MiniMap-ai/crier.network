-- CRI-62: a search whose query embedding failed ran on full-text and trigram alone, so finding
-- nothing there is not evidence that nobody posted it. embed_failed counts those searches per shape;
-- they are counted in n and never in zero (lib/search-log.ts, isUnmet). Rows written before this
-- column existed read 0, which is what they could tell us.
alter table search_log add column if not exists embed_failed integer not null default 0;

-- The old eight-argument bump_search goes in the same transaction as its replacement. Left beside a
-- nine-argument version with a default, an eight-argument call would match both and fail as
-- ambiguous; dropped, the deployment still serving during the build resolves to the new one with
-- p_embed_failed = 0.
drop function if exists bump_search(text, text, text, text, integer, text, integer, integer);

create or replace function bump_search(
  p_q text, p_kind text, p_tags text, p_near text, p_radius_km integer, p_source text,
  p_n integer default 1, p_zero integer default 0, p_embed_failed integer default 0
) returns void language sql as $$
  insert into search_log (day, q, kind, tags, near, radius_km, source, n, zero, embed_failed)
  values (current_date, p_q, p_kind, p_tags, p_near, p_radius_km, p_source, p_n, p_zero, p_embed_failed)
  on conflict (day, coalesce(q, ''), coalesce(kind, ''), coalesce(tags, ''), coalesce(near, ''), coalesce(radius_km, -1), source)
  do update set n = search_log.n + excluded.n, zero = search_log.zero + excluded.zero,
                embed_failed = search_log.embed_failed + excluded.embed_failed;
$$;

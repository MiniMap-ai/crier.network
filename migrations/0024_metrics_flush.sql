-- The daily half of the metrics flush as one statement (lib/flush-batch.ts, writeBatch). One call is
-- its own transaction, so the flush sends no BEGIN and cannot leave a transaction open on a pooled
-- connection; docs/metrics.md, "Lock order" and "When a counter is real".
--
-- p holds four lists, each already in lock order: counters [{key, n}], actors [{role, actor, n}],
-- stats [{col, n}], searches [{q, kind, tags, near, radius_km, source, n, zero, embed_failed}].
-- Ordinality keeps that order. lock_timeout is set on the function because the caller has no
-- transaction block for a SET LOCAL. A statement_timeout set this way would not bound the calling
-- statement, so the client's cancel at its deadline is what ends a slow one.
create or replace function metrics_flush(p jsonb) returns void
language plpgsql
set lock_timeout = '1500ms'
as $$
declare
  r record;
begin
  insert into daily_counters (day, key, n)
  select current_date, e.v ->> 'key', (e.v ->> 'n')::bigint
    from jsonb_array_elements(coalesce(p -> 'counters', '[]')) with ordinality as e(v, i)
   order by e.i
  on conflict (day, key) do update set n = daily_counters.n + excluded.n;

  insert into daily_actors (day, role, actor, n)
  select current_date, e.v ->> 'role', e.v ->> 'actor', (e.v ->> 'n')::integer
    from jsonb_array_elements(coalesce(p -> 'actors', '[]')) with ordinality as e(v, i)
   order by e.i
  on conflict (day, role, actor) do update set n = daily_actors.n + excluded.n;

  for r in select e.v from jsonb_array_elements(coalesce(p -> 'stats', '[]')) with ordinality as e(v, i) order by e.i loop
    perform bump_stat(r.v ->> 'col', (r.v ->> 'n')::bigint);
  end loop;

  for r in select e.v from jsonb_array_elements(coalesce(p -> 'searches', '[]')) with ordinality as e(v, i) order by e.i loop
    perform bump_search(r.v ->> 'q', r.v ->> 'kind', r.v ->> 'tags', r.v ->> 'near', (r.v ->> 'radius_km')::integer,
                        r.v ->> 'source', (r.v ->> 'n')::integer, (r.v ->> 'zero')::integer, (r.v ->> 'embed_failed')::integer);
  end loop;
end $$;

-- Only the app's role writes metrics. Supabase grants new functions in public to anon and
-- authenticated, which would expose this one as an RPC.
revoke all on function metrics_flush(jsonb) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on function metrics_flush(jsonb) from anon, authenticated';
  end if;
  if exists (select 1 from pg_roles where rolname = 'crier_app') then
    execute 'grant execute on function metrics_flush(jsonb) to crier_app';
  end if;
end $$;

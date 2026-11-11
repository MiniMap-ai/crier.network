-- An inbox read is recorded in daily_actors as role='heartbeat' (lib/inbox.ts), and role='publisher'
-- means a first-hand post that day (docs/metrics.md, "Weekly active publishers"). This moves to
-- 'heartbeat' every role='publisher' row whose publisher created no first-hand post on that row's
-- day, which only an inbox read can have written. A row for a day with both a post and a poll stays.
--
-- daily_actors.day is current_date in the flushing session's TimeZone, which neither the app nor
-- scripts/migrate.mjs sets, so both use the database default; created_at::date is the same
-- conversion in the same zone.
--
-- One statement, so a row is never in both roles or neither. Re-run, it finds nothing left to move.
set local lock_timeout = '10s';

with moved as (
  delete from daily_actors a
   where a.role = 'publisher'
     and not exists (
       select 1 from posts p
        where p.publisher_id = a.actor
          and not p.syndicated
          and p.created_at::date = a.day
     )
  returning a.day, a.actor, a.n
)
insert into daily_actors (day, role, actor, n)
select day, 'heartbeat', actor, n from moved
on conflict (day, role, actor) do update set n = daily_actors.n + excluded.n;

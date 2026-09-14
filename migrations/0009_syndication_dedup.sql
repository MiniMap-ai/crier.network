-- The syndication write path used to key on the instance and the read path on the thing.
--
-- Adapters emit one item per instance — Localist puts the start in the uid, Ticketmaster gives a
-- timed-entry attraction a separate event id for every 15-minute slot — and each one became its own
-- post. On 2026-09-13 that was 603 of 2,138 live rows: one balloon museum ninety times, one Denver
-- exhibition a hundred and thirteen, ten DePaul scholarship-payment keys at twenty-six each. Search
-- has always collapsed these on source_key, so seekers never saw them; what they cost was the board
-- size we publish, the crawler surface behind the 504s of 09-08 and 09-10, and the database.
--
-- lib/syndication/collapse.ts stops them being written. This is the rows already there.
--
-- Soft delete only: deleted_at and a reason in metadata, never a DELETE. The counts on /stats and
-- /api/v1/board are the live rows, so they fall by about 28% the moment this runs — that is the
-- duplicate share going away, not data.

alter table source_runs add column if not exists folded    integer default 0;
alter table source_runs add column if not exists collapsed integer default 0;

-- The judgement, computed once and read by the four statements below. A temp table rather than a
-- repeated CTE so they cannot drift apart, and so this file stays legible; migrations are applied
-- one transaction per file (scripts/migrate.mjs), which is what makes that safe.
drop table if exists min37_dedup;
create temporary table min37_dedup as
with live as (
  -- The live syndicated posts that carry an identity, as they were before this migration. A row an
  -- earlier pass already soft-deleted is put back into the set it was judged in, so running this
  -- file twice reaches the same answer rather than a different one.
  select p.id,
         p.metadata->>'source_id' as source_id,
         p.source_key,
         p.title,
         p.starts_at,
         p.created_at
    from posts p
   where p.syndicated
     and p.source_key is not null
     and p.metadata ? 'source_id'
     and p.expires_at > now()
     and (p.deleted_at is null or p.metadata->>'deleted_reason' = 'duplicate_instance')
),
grouped as (
  -- How many different things are behind this URL. Nearly always one; four of them are a venue
  -- landing page selling four different Sunday brunches, which is why the fold checks the title.
  select source_id, source_key, count(distinct title) as titles
    from live group by source_id, source_key
)
select l.id,
       l.source_id,
       l.source_key,
       g.titles,
       row_number() over (
         partition by l.source_id, l.source_key
         order by (l.starts_at is not null and l.starts_at > now()) desc,                            -- future instances first
                  case when l.starts_at is not null and l.starts_at > now() then l.starts_at end,    -- the next one upcoming
                  l.starts_at desc nulls last,                                                       -- otherwise the most recent
                  l.created_at, l.id                                                                 -- and deterministically
       ) as rn
  from live l
  join grouped g on g.source_id = l.source_id and g.source_key = l.source_key;

create index on min37_dedup (id);
create index on min37_dedup (source_id, source_key);

-- Instances of one thing: keep the next one upcoming. Several things behind one URL: keep three,
-- which is the ceiling lib/syndication/runner.ts holds the write path to from here on.
update posts p
   set deleted_at = now(),
       updated_at = now(),
       metadata = p.metadata || jsonb_build_object('deleted_reason', 'duplicate_instance')
  from min37_dedup d
 where p.id = d.id
   and p.deleted_at is null
   and ((d.titles = 1 and d.rn > 1) or (d.titles > 1 and d.rn > 3));

-- Re-key the runner's index onto the identity it now writes on. Only for the URLs that carry one
-- thing: where several do, the runner keeps relaying them under their own uids and the live-row
-- guard is what bounds them, so re-keying those would leave the two disagreeing.
insert into source_items (source_id, uid, post_id, hash, first_seen, last_seen, missing_runs)
select d.source_id, d.source_key, d.id,
       -- A post that had no siblings comes out of this unchanged, so it keeps the hash it has and
       -- the next run leaves it alone. One that has instances to swallow must be rewritten with its
       -- recurrence list and its "Also at" line, and an empty hash is how that is asked for.
       case when exists (select 1 from min37_dedup o
                          where o.source_id = d.source_id and o.source_key = d.source_key and o.rn > 1)
            then '' else coalesce(old.hash, '') end,
       now(), now(), 0
  from min37_dedup d
  left join lateral (
    select si.hash from source_items si where si.post_id = d.id order by si.last_seen desc limit 1
  ) old on true
 where d.titles = 1 and d.rn = 1
   and exists (select 1 from sources s where s.id = d.source_id)
on conflict (source_id, uid) do update
   set post_id = excluded.post_id, hash = excluded.hash, last_seen = now(), missing_runs = 0;

-- The per-instance rows the old key left behind, now that the survivor is indexed under its
-- source_key. Only where the source_key row points at the same post, so nothing else is disturbed.
delete from source_items si
 using min37_dedup d, source_items keyed
 where d.titles = 1 and d.rn = 1
   and keyed.source_id = d.source_id and keyed.uid = d.source_key and keyed.post_id = d.id
   and si.source_id = d.source_id and si.post_id = d.id and si.uid <> d.source_key;

-- And the rows pointing at a post this migration soft-deleted. Left alone, the runner would count
-- each of them missing for three runs and then try to retire a post that is already gone.
delete from source_items si
 using min37_dedup d, posts p
 where si.post_id = d.id
   and p.id = d.id
   and p.deleted_at is not null
   and p.metadata->>'deleted_reason' = 'duplicate_instance';

drop table if exists min37_dedup;

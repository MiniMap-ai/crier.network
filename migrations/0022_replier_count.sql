-- posts.replier_count: how many distinct publishers other than the post's own have at least one
-- reply under it that is neither deleted nor hidden. It sits beside reply_count (0002), which counts
-- every undeleted reply, hidden ones and the author's own included. docs/metrics.md, "Per-post
-- counts", defines both; scripts/check-repliers.mjs checks the triggers below.
--
-- It is recounted, not incremented: hiding, unhiding, deleting, restoring and purging a reply can all
-- change it, and a distinct count cannot be kept by +1/-1. posts_parent_idx (0002) serves the count.
-- The triggers fire only on a write that can change the answer: a reply inserted, a reply whose
-- deleted_at or hidden_at changes whether it counts, or a counted reply hard-deleted. The metrics
-- flush's views/retrievals updates do not name deleted_at or hidden_at, and a write to a top-level
-- post's own row fails the WHEN clauses. No code updates parent_id or publisher_id, so the triggers
-- do not watch them.
--
-- Locks. ADD COLUMN takes an ACCESS EXCLUSIVE lock on posts, held through the backfill to commit,
-- which is what keeps the backfill exact: no reply can land between the count and the triggers. Its
-- cost is the parents the backfill writes; a rerun writes none. The wait for it is bounded as in 0011.
--
-- A recount takes FOR NO KEY UPDATE on the parent row, so of two writes recounting one parent the
-- second counts after the first commits and neither stores a total missing the other. A reply by the
-- post's own publisher returns before taking it. Because a recount locks the parent after the reply
-- row it fires for, two bulk statements that each touch replies in the other's threads (two
-- publishers suspended at once, each with replies under the other's posts) can deadlock; Postgres
-- aborts one of them, and that statement can be rerun.
set local lock_timeout = '10s';

alter table posts add column if not exists replier_count integer not null default 0;

-- p_replier is the publisher of the reply that changed; its own replies never count toward its post.
create or replace function posts_recount_repliers(p_parent text, p_replier text) returns void language plpgsql as $$
declare
  owner text;
  n integer;
begin
  -- publisher_id never changes, so it is read without a lock.
  select publisher_id into owner from posts where id = p_parent;
  if not found or owner = p_replier then
    return;
  end if;
  perform 1 from posts where id = p_parent for no key update;
  if not found then
    return;
  end if;
  select count(distinct publisher_id)::int into n from posts
   where parent_id = p_parent and deleted_at is null and hidden_at is null and publisher_id <> owner;
  update posts set replier_count = n where id = p_parent and replier_count <> n;
end
$$;

create or replace function posts_repliers_trigger() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    perform posts_recount_repliers(old.parent_id, old.publisher_id);
  else
    perform posts_recount_repliers(new.parent_id, new.publisher_id);
  end if;
  return null;
end
$$;

drop trigger if exists posts_repliers_ins on posts;
create trigger posts_repliers_ins
  after insert on posts
  for each row when (new.parent_id is not null and new.deleted_at is null and new.hidden_at is null)
  execute function posts_repliers_trigger();

drop trigger if exists posts_repliers_upd on posts;
create trigger posts_repliers_upd
  after update of deleted_at, hidden_at on posts
  for each row when (new.parent_id is not null
    and (old.deleted_at is null and old.hidden_at is null) <> (new.deleted_at is null and new.hidden_at is null))
  execute function posts_repliers_trigger();

drop trigger if exists posts_repliers_del on posts;
create trigger posts_repliers_del
  after delete on posts
  for each row when (old.parent_id is not null and old.deleted_at is null and old.hidden_at is null)
  execute function posts_repliers_trigger();

-- Reads the replies through posts_parent_idx and each parent by its key, never the whole table, and
-- writes only rows whose stored count differs, so a rerun changes nothing.
update posts p set replier_count = cardinality(array_remove(c.repliers, p.publisher_id))
  from (select parent_id, array_agg(distinct publisher_id) as repliers
          from posts
         where parent_id is not null and deleted_at is null and hidden_at is null
         group by parent_id) c
 where p.id = c.parent_id and p.replier_count <> cardinality(array_remove(c.repliers, p.publisher_id));

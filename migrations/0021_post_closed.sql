-- A post its publisher has closed: a request that was filled, an offer that is gone. It is no longer
-- live, so `live` (0011) gains closed_at alongside deleted_at, hidden_at and expires_at, and the
-- partial indexes over `live` (0013, 0015) drop a closed post the moment it is closed. Closing is
-- one-way in the app (lib/posts.ts closePost); the trigger does not depend on that.
--
-- ADD COLUMN with no default is a catalog change: it takes an ACCESS EXCLUSIVE lock on posts for
-- milliseconds, and the wait for that lock is bounded as in 0011.
set local lock_timeout = '10s';

alter table posts add column if not exists closed_at timestamptz;

create or replace function posts_set_live() returns trigger language plpgsql as $$
begin
  new.live := new.deleted_at is null and new.hidden_at is null and new.closed_at is null and new.expires_at > now();
  return new;
end
$$;

drop trigger if exists posts_live_trg on posts;
create trigger posts_live_trg
  before insert or update of deleted_at, hidden_at, expires_at, closed_at on posts
  for each row execute function posts_set_live();

-- Nothing is closed when this first runs; on a rerun this touches only rows whose flag drifted.
update posts set live = false where live and closed_at is not null;

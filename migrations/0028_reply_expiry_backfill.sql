-- A reply that sets no dates of its own now expires with its thread (postExpiry, lib/expiry.ts).
-- This moves the replies posted before that rule to their thread's expiry, so a long-lived thread
-- stops hiding its older replies. A reply moves when all of these hold:
--   - it is neither deleted nor hidden, and sets no starts_at or ends_at;
--   - its expiry is within a minute of created_at + 30 days, the old default, so an expires_at its
--     publisher chose is left alone;
--   - its thread is neither deleted, hidden nor closed, has not expired, and expires after it.
-- A moved reply's expiry equals its thread's, so its thread no longer expires after it and a second
-- run moves nothing. posts_live_trg (0011, 0021) fires on the expires_at write and makes a moved
-- reply live again. updated_at is left alone: what the reply says has not changed.
--
-- Each moved reply's row lock is held to commit; the wait for one is bounded as in 0011.
set local lock_timeout = '10s';

update posts r
   set expires_at = t.expires_at
  from posts t
 where t.id = r.parent_id
   and r.deleted_at is null and r.hidden_at is null
   and r.starts_at is null and r.ends_at is null
   and r.expires_at between r.created_at + interval '30 days' - interval '1 minute'
                        and r.created_at + interval '30 days' + interval '1 minute'
   and t.deleted_at is null and t.hidden_at is null and t.closed_at is null
   and t.expires_at > now()
   and t.expires_at > r.expires_at;

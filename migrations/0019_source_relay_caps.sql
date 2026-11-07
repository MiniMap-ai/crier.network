-- CRI-54: the relay policy caps max_per_run at 100 and horizon_days at 30 (docs/syndication.md).
-- The runner clamps at run time (runLimit in lib/syndication/types.ts); the rows and this
-- constraint make the stored schedule say the same thing, so nothing reading sources believes a
-- ceiling the runner will not honour, and a row over the cap is refused rather than clamped.
set local lock_timeout = '10s';

update sources set max_per_run = 100 where max_per_run > 100;
update sources set horizon_days = 30 where horizon_days > 30;

alter table sources drop constraint if exists sources_relay_caps;
alter table sources add constraint sources_relay_caps
  check (max_per_run between 1 and 100 and horizon_days between 1 and 30);

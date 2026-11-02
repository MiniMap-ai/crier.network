-- The NWS adapter wrote expires_at from CAP <expires>, which is the product's refresh deadline and
-- not the hazard's end: the office reissues a multi-day watch every few hours, so <expires> lands
-- the same day while <ends> is days out. Search and the board filter on expires_at, so the alert
-- left the board while the hazard it described was in effect — 46% of active alerts on 2026-09-29,
-- 1,158 of the 2,946 NWS rows ever written, two Severe Colorado flood watches gone a day and a half
-- before their flooding window opened on 10-30 (CRI-50).
--
-- lib/syndication/adapters.ts now floors expires_at at ends_at plus an hour. This is the rows
-- already written: 12 alerts in effect and already gone, 8 live ones about to follow, on 2026-11-02.
--
-- Only rows whose hazard has not yet ended are touched. One that ended in the past stays expired,
-- as it should; and whether an alert should outlive its hazard at all is the separate question this
-- file does not answer. Idempotent: the second run finds nothing below the floor.

update posts
   set expires_at = greatest(expires_at, ends_at + interval '1 hour'),
       updated_at = now()
 where syndicated
   and metadata->>'source' = 'nws'
   and deleted_at is null
   and ends_at is not null
   and ends_at > now()
   and expires_at < ends_at + interval '1 hour';

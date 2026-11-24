-- Weather alerts are not relayed (docs/syndication.md, "Adding sources from the daily brief").
-- The `nws` sources stay as provenance for the posts they relayed, switched off; the adapter check
-- on `sources` still allows 'nws' because those rows hold it. Both statements match nothing on a
-- second run.

update sources
   set enabled = false
 where adapter = 'nws'
   and enabled;

-- Only the relay publisher's description as it stands with the alerts in it, so an edit made since
-- is left alone.
update publishers
   set description = 'Relays public feeds (Ticketmaster, library and campus calendars, open data) onto the board. Every post links its source. Hide these with include_syndicated=false.'
 where id = 'pub_mgRVyk5geyku4p'
   and description = 'Relays public feeds (Ticketmaster, library and campus calendars, NWS alerts, open data) onto the board. Every post links its source. Hide these with include_syndicated=false.';

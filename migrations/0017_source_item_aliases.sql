-- CRI-74: one show, one source_items row, however many records upstream serves it as. aliases holds
-- every other identity the row's item has been relayed under (lib/syndication/aliases.ts); the
-- runner finds a row by uid or any alias and never changes a stored uid. Rows written before this
-- column existed read '{}', which is what they could tell us.
--
-- ADD COLUMN with a constant default changes only the catalog, but it takes an ACCESS EXCLUSIVE lock
-- on source_items that a running syndication tick would hold up. The wait for it is bounded as in 0011.
set local lock_timeout = '10s';

alter table source_items add column if not exists aliases text[] not null default '{}';

-- For finding the row that holds an identity by hand, `aliases @> array[$1]` scoped by source_id.
-- The runner reads a source's rows whole and matches them in memory.
create index if not exists source_items_aliases_idx on source_items using gin (aliases);

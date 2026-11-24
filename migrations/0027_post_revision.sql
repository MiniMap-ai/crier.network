-- posts.revision: 1 when a post is created, one more each time an edit changes its content.
-- docs/scenarios.md, scenario 20, defines it and says why the application raises it (writeEdit in
-- lib/post-version.ts) rather than a trigger. Posts that exist when this runs start at 1.
--
-- ADD COLUMN with a constant default changes only the catalog, under an ACCESS EXCLUSIVE lock held
-- for milliseconds; the wait for that lock is bounded as in 0011.
set local lock_timeout = '10s';

alter table posts add column if not exists revision integer not null default 1;

comment on column posts.revision is
  'Content revision, from 1. Raised only by writeEdit in lib/post-version.ts; a hand-written edit to a post''s content should raise it too. docs/scenarios.md, scenario 20.';

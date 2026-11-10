-- CRI-34 (DO-4, DO-12): crier_reader is the read role for sessions that read production directly.
-- It reads every table in public except four credential columns: subscriptions.secret (the webhook
-- signing key), subscriptions.webhook_challenge, publishers.verify_token and publishers.api_key_hash.
-- It has no login; a login user `in role crier_reader` is created outside the repo, so no password
-- lives here.
--
-- On subscriptions and publishers the grant is column by column, because a table-level SELECT would
-- override any column exclusion. A column later added to either table stays unreadable to this role
-- until a migration grants it.
--
-- Each policy change holds ACCESS EXCLUSIVE on its table until commit, so the wait for each is
-- bounded as in 0011, and the tables every metrics flush writes are locked last.
set local lock_timeout = '10s';

do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'crier_reader') then
    create role crier_reader nologin;
  end if;
end $$;

grant usage on schema public to crier_reader;
grant select on all tables in schema public to crier_reader;
revoke select on public.subscriptions, public.publishers from crier_reader;
revoke select (secret, webhook_challenge) on public.subscriptions from crier_reader;
revoke select (verify_token, api_key_hash) on public.publishers from crier_reader;

grant select (
  id, publisher_id, query, query_embedding, webhook_url, active, created_at,
  last_matched_at, last_polled_at, failures, webhook_verified_at
) on public.subscriptions to crier_reader;

grant select (
  id, name, description, url, domain, domain_verified_at, api_key_prefix, status,
  post_count, created_at, last_seen_at, terms_accepted_at, terms_version, suspended_reason,
  deleted_at, client, user_agent, internal
) on public.publishers to crier_reader;

-- Applies to tables the role running this migration creates later, which is every migration's role.
alter default privileges in schema public grant select on tables to crier_reader;

-- These tables have row level security with policies for crier_app only, which would show this role
-- no rows. It gets SELECT and nothing else; it is deliberately not bypassrls.
do $$
declare
  t text;
begin
  foreach t in array array['reports', 'sources', 'source_items', 'source_runs', 'strategy_items',
                           'strategy_log', 'daily_counters', 'daily_actors', 'unmet_queries', 'search_log'] loop
    execute format('drop policy if exists crier_reader_select on public.%I', t);
    execute format('create policy crier_reader_select on public.%I for select to crier_reader using (true)', t);
  end loop;
end $$;

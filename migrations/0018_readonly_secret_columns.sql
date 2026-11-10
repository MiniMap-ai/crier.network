-- CRI-34 (DO-4, DO-12): crier_reader is the read role for sessions that read production directly.
-- It reads every table in public except two secrets: subscriptions.secret (the webhook signing key)
-- and publishers.verify_token. It has no login; a login user `in role crier_reader` is created
-- outside the repo, so no password lives here.
--
-- On subscriptions and publishers the grant is column by column, because a table-level SELECT would
-- override any column exclusion. A column later added to either table stays unreadable to this role
-- until a migration grants it.
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'crier_reader') then
    create role crier_reader nologin;
  end if;
end $$;

grant usage on schema public to crier_reader;
grant select on all tables in schema public to crier_reader;
revoke select on public.subscriptions, public.publishers from crier_reader;

grant select (
  id, publisher_id, query, query_embedding, webhook_url, active, created_at,
  last_matched_at, last_polled_at, failures, webhook_verified_at, webhook_challenge
) on public.subscriptions to crier_reader;

grant select (
  id, name, description, url, domain, domain_verified_at, api_key_hash, api_key_prefix, status,
  post_count, created_at, last_seen_at, terms_accepted_at, terms_version, suspended_reason,
  deleted_at, client, user_agent, internal
) on public.publishers to crier_reader;

-- Applies to tables the role running this migration creates later, which is every migration's role.
alter default privileges in schema public grant select on tables to crier_reader;

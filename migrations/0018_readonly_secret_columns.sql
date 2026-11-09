-- CRI-34 (DO-4, DO-12): the read-only role must not read a runtime secret. subscriptions.secret is
-- the webhook signing key and publishers.verify_token the domain proof; every other column of both
-- tables stays readable to it, so aggregates and explicit column lists keep working.
--
-- A column revoke does nothing while the role holds SELECT on the whole table, so the table grant
-- becomes a grant on every column but the secret. Columns added later are not granted to this role
-- until a migration grants them. The role does not exist outside Supabase, so CI skips all of this.
--
-- Neither revoke binds a superuser or a member of pg_read_all_data; bypassrls does not affect it.
do $$
declare
  t record;
  cols text;
begin
  if not exists (select 1 from pg_roles where rolname = 'supabase_read_only_user') then
    return;
  end if;

  for t in select * from (values ('subscriptions', 'secret'), ('publishers', 'verify_token')) as v(tbl, secret_col) loop
    select string_agg(quote_ident(a.attname), ', ' order by a.attnum) into cols
      from pg_attribute a
     where a.attrelid = ('public.' || t.tbl)::regclass and a.attnum > 0 and not a.attisdropped
       and a.attname <> t.secret_col;
    execute format('revoke select on public.%I from supabase_read_only_user', t.tbl);
    execute format('revoke select (%I) on public.%I from supabase_read_only_user', t.secret_col, t.tbl);
    execute format('grant select (%s) on public.%I to supabase_read_only_user', cols, t.tbl);
  end loop;

  if exists (select 1 from pg_roles where rolname = 'supabase_read_only_user' and rolsuper)
     or pg_has_role('supabase_read_only_user', 'pg_read_all_data', 'USAGE') then
    raise warning 'CRI-34: supabase_read_only_user is a superuser or inherits pg_read_all_data, so it can still read subscriptions.secret and publishers.verify_token';
  end if;
end $$;

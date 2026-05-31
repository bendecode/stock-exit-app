create extension if not exists pgcrypto;

create table if not exists public.positions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  symbol text not null default '',
  entry_price numeric,
  buy_date date,
  current_price numeric,
  high_price numeric,
  shares numeric,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.positions enable row level security;

drop policy if exists "positions_select_own" on public.positions;
drop policy if exists "positions_insert_own" on public.positions;
drop policy if exists "positions_update_own" on public.positions;
drop policy if exists "positions_delete_own" on public.positions;

create policy "positions_select_own"
on public.positions for select
to authenticated
using ((select auth.uid()) = user_id);

create policy "positions_insert_own"
on public.positions for insert
to authenticated
with check ((select auth.uid()) = user_id);

create policy "positions_update_own"
on public.positions for update
to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);

create policy "positions_delete_own"
on public.positions for delete
to authenticated
using ((select auth.uid()) = user_id);

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists positions_set_updated_at on public.positions;

create trigger positions_set_updated_at
before update on public.positions
for each row
execute function public.set_updated_at();

grant usage on schema public to authenticated;

grant select, insert, update, delete
on table public.positions
to authenticated;

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
    and not exists (
      select 1
      from pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'public'
        and tablename = 'positions'
    ) then
    alter publication supabase_realtime add table public.positions;
  end if;
end;
$$;

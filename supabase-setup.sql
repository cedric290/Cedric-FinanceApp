-- Kosten-Tracker: Datenbank einrichten.
-- In Supabase: SQL Editor → New query → alles einfügen → Run.

create table if not exists public.items (
  id         text primary key,
  user_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  kind       text not null,                       -- category, expense, sub, payment
  data       jsonb not null default '{}'::jsonb,
  deleted    boolean not null default false,
  updated_at timestamptz not null default now()
);

create index if not exists items_user_updated on public.items (user_id, updated_at);

-- Jeder sieht und ändert nur seine eigenen Einträge.
alter table public.items enable row level security;
drop policy if exists "nur eigene Daten" on public.items;
create policy "nur eigene Daten" on public.items
  for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

grant select, insert, update on public.items to authenticated;

-- Zeitstempel bei jeder Änderung neu setzen. Daran erkennen die Geräte, was neu ist.
create or replace function public.items_touch() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_at := clock_timestamp();
  return new;
end $$;

drop trigger if exists items_touch on public.items;
create trigger items_touch before insert or update on public.items
  for each row execute function public.items_touch();

-- Schnittstelle sofort über die neue Tabelle informieren.
notify pgrst, 'reload schema';

-- Repository path: supabase/migrations/20261103000000_hotel_auth_memberships.sql
-- Additive foundation for replacing browser-side PIN checks with Supabase Auth.
-- This migration intentionally does not change existing POS table policies or login flows.

begin;

create table if not exists public.hotel_memberships (
    id uuid primary key default gen_random_uuid(),
    auth_user_id uuid not null references auth.users(id) on delete cascade,
    restaurant_id uuid not null references public.restaurants(id) on delete cascade,
    role text not null check (role in ('master', 'waiter', 'cook', 'partner')),
    is_active boolean not null default true,
    created_by uuid references auth.users(id) on delete set null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    constraint hotel_memberships_user_restaurant_unique
        unique (auth_user_id, restaurant_id)
);

create index if not exists hotel_memberships_restaurant_id_idx
    on public.hotel_memberships (restaurant_id);

create index if not exists hotel_memberships_active_user_idx
    on public.hotel_memberships (auth_user_id)
    where is_active = true;

alter table public.hotel_memberships enable row level security;

revoke all on table public.hotel_memberships from anon, authenticated;
grant select on table public.hotel_memberships to authenticated;

drop policy if exists "Users can read their own hotel memberships"
    on public.hotel_memberships;

create policy "Users can read their own hotel memberships"
    on public.hotel_memberships
    for select
    to authenticated
    using (auth_user_id = (select auth.uid()) and is_active = true);

comment on table public.hotel_memberships is
    'Maps Supabase Auth users to a restaurant and POS role. Membership writes must be performed by a trusted server-side administrative workflow.';


-- Server-only login throttling. The private schema is not exposed through the Data API.
create schema if not exists private;
revoke all on schema private from public, anon, authenticated;
grant usage on schema private to service_role;

create table if not exists private.pos_login_attempts (
    key_hash text primary key,
    attempts integer not null default 0,
    window_started_at timestamptz not null default now()
);
revoke all on table private.pos_login_attempts from public, anon, authenticated, service_role;

create or replace function public.pos_login_rate_limit(
    p_key_hash text,
    p_reset boolean default false
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $function$
declare
    current_attempts integer;
begin
    if p_reset then
        delete from private.pos_login_attempts where key_hash = p_key_hash;
        return true;
    end if;

    insert into private.pos_login_attempts (key_hash, attempts, window_started_at)
    values (p_key_hash, 1, now())
    on conflict (key_hash) do update
      set attempts = case
            when private.pos_login_attempts.window_started_at < now() - interval '15 minutes' then 1
            else private.pos_login_attempts.attempts + 1
          end,
          window_started_at = case
            when private.pos_login_attempts.window_started_at < now() - interval '15 minutes' then now()
            else private.pos_login_attempts.window_started_at
          end
    returning attempts into current_attempts;

    return current_attempts <= 8;
end;
$function$;

revoke all on function public.pos_login_rate_limit(text, boolean) from public, anon, authenticated;
grant execute on function public.pos_login_rate_limit(text, boolean) to service_role;

commit;

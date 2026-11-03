-- Repository path: supabase/migrations/20261103000000_hotel_auth_memberships.sql
-- Additive foundation for replacing browser-side PIN checks with Supabase Auth.
-- This migration intentionally does not change existing POS table policies or login flows.

begin;

create table if not exists public.hotel_memberships (
    id uuid primary key default gen_random_uuid(),
    auth_user_id uuid not null references auth.users(id) on delete cascade,
    restaurant_id uuid not null references public.restaurants(id) on delete cascade,
    role text not null check (role in ('master', 'waiter', 'cook')),
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

commit;

# POS security audit — 2026-11-03

## Scope and important clarification

This review covers the Supabase project backing this repository and the repository's `app.html` demo.

**The user has clarified that `app.html` is only a visual/demo file showing how the Android app may look. It is not the production Android application and must not be treated as the live POS client. Do not modify it as part of backend security work.**

The actual Android/POS client source repository or project has not yet been identified. Therefore, client-side authentication integration and end-to-end compatibility cannot be completed or claimed.

No database schema, policy, production data, or deployed function was changed by this audit.

## Critical findings

### 1. Demo login is not proof of production-client behavior

- The demo `app.html` contains browser-side PIN checks and stores a login object in `localStorage`.
- Because this file is a demo only, these observations must not be generalized to the actual Android/POS app.
- The production client must be inspected before designing its exact login request, session storage, refresh, logout, and data-access changes.
- Never treat a client-provided store code, role, or local-storage value as authorization.

### 2. Public unrestricted policies

The following tables have public/anon policies with `USING (true)` and `WITH CHECK (true)` for all operations, or equivalent unrestricted access:

- `daily_expenses`
- `hotel_kots`
- `hotel_staff`
- `hotel_vendors`
- `invoice_items`
- `invoices`
- `master_menu` (an unrestricted ALL policy exists alongside read policies)
- `partner_ledger`
- `qr_orders`
- `ration_demands`
- `restaurant_partners`
- `restaurants`
- `store_menu_custom`
- `sales_reports` has an unrestricted policy but RLS is disabled.

These policies can allow unauthenticated callers with the public API key to access or alter records without a hotel boundary. Do not remove them individually until the real client and replacement authorization policies are ready and tested.

### 3. RLS disabled

RLS is disabled on:
- `sales_reports`
- `hotel_preset_rations`
- `counter_inventory`

Enabling RLS without replacement policies may block current app access. This must be coordinated with the authenticated client migration.

### 4. View security

The `public.menu_items` view is flagged by Supabase's security advisor as SECURITY DEFINER. Its definition cross-joins store codes with the global menu and custom menu data. Review and replace with an appropriately scoped `security_invoker` view or a protected access pattern after validating actual client query requirements.

### 5. RLS policies with no policies

- `qr_order_items` has RLS enabled but no policies.
- `restaurant_table_qr` has RLS enabled but no policies.

Their intended public QR ordering workflow needs a separate, narrowly scoped policy design using the QR token, rather than broad public table access.

## Current draft PR

The draft PR adds `public.hotel_memberships` as an additive mapping between Supabase Auth users, restaurants, and roles, plus a private login-attempt table/function and a PIN login Edge Function.

The migration is **not applied** to the live database. The Supabase project currently reports no applied migration records through the connected migration listing, and no Edge Functions are deployed.

The Edge Function requires `POS_AUTH_IDENTITY_SECRET` to be configured before it can operate. Do not deploy it until this secret and the actual client integration are ready. Also review the synthetic Auth identity lifecycle and login throttling design before production use.

## Required implementation order

1. Identify and inspect the real Android/POS client source. Leave `app.html` as demo-only.
2. Confirm the production login contract and identity mapping for master, waiter, cook, and partner accounts. Never return PINs or internal Auth passwords to the client.
3. Finalize and test server-side login, rate limiting, account lifecycle, and real Supabase Auth sessions.
4. Configure the server-only `POS_AUTH_IDENTITY_SECRET` securely, then deploy the login function.
5. Update the real client to use Auth sessions and stop trusting client-provided/local role or store values.
6. Add hotel-scoped RLS policies for every hotel-owned table, using authenticated membership and each table's actual hotel key. Handle child tables through their parent relation.
7. Replace the SECURITY DEFINER view and design separate restricted QR policies.
8. Test master/waiter/cook access, cross-hotel isolation, logout/session expiry, QR customer flow, and existing POS operations.
9. Only after tests pass, remove old public policies and enable RLS on the three currently unprotected tables.

## Verification status

- Supabase security advisor was run on 2026-11-03.
- Current advisor findings: `sales_reports` has a policy while RLS is disabled; `qr_order_items` and `restaurant_table_qr` have RLS enabled without policies; `menu_items` is a SECURITY DEFINER view; RLS is disabled on `sales_reports`, `hotel_preset_rations`, and `counter_inventory`.
- The live migration listing returned no applied migration records.
- The live Edge Function listing returned no deployed functions.
- No production database migration or policy change has been applied as part of this work.
- No production Android/POS client has been identified or modified.

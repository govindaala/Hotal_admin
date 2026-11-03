# POS security audit — 2026-11-03

## Scope

Read-only inspection of the Supabase project backing this repository and the current `app.html`.
No database schema, policy, data, or deployed function was changed by this audit.

## Critical findings

### 1. Browser-side PIN authentication

- `app.html` queries `restaurants` and compares `master_pin` in browser JavaScript.
- Staff login filters `hotel_staff` by plaintext `pin` from the browser.
- Successful login writes a JSON object to `localStorage`; this is not an authenticated Supabase session and can be edited by the user.
- `restaurants` and `hotel_staff` have permissive public write/read policies. PIN values must not remain available to the public Data API.

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

These policies allow unauthenticated callers with the public API key to access or alter records without a hotel boundary. Do not remove them individually until the app has a working authenticated access model and replacement policies.

### 3. RLS disabled

RLS is disabled on:
- `sales_reports`
- `hotel_preset_rations`
- `counter_inventory`

Enabling RLS without replacement policies will block current app access. This must be coordinated with the authenticated app migration.

### 4. View security

The `public.menu_items` view is flagged by Supabase's security advisor as SECURITY DEFINER. Its definition cross-joins all restaurant store codes with the global menu and custom menu values. Review and replace with an appropriately scoped `security_invoker` view or a protected access pattern after validating the client query requirements.

### 5. RLS policies with no policies

- `qr_order_items` has RLS enabled but no policies.
- `restaurant_table_qr` has RLS enabled but no policies.

Their intended public QR ordering workflow needs a separate, narrowly scoped policy design using the QR token, rather than broad public table access.

## Current migration branch

The draft PR adds `public.hotel_memberships` as an additive mapping between Supabase Auth users, restaurants, and roles. It does not alter existing app login or data policies. Membership assignment must be performed by a trusted server-side workflow.

## Required implementation order

1. Define the identity mapping and credential migration for master, waiter, cook, and partner accounts. Never return PIN hashes or raw PINs to the browser.
2. Implement and test server-side login with rate limiting, generic failure messages, and real Supabase Auth sessions. Do not deploy a login function until account identity, credential hashing, and session issuance are fully specified.
3. Update the frontend to use Auth sessions and stop trusting `localStorage` role/store values.
4. Add hotel-scoped RLS policies for every hotel-owned table, using the authenticated user's membership and the table's actual hotel key. Handle child tables through their parent relation.
5. Replace the SECURITY DEFINER view and design separate restricted QR policies.
6. Test master/waiter/cook access, cross-hotel isolation, logout/session expiry, QR customer flow, and existing POS operations.
7. Only after tests pass, remove the old public policies and enable RLS on the three currently unprotected tables.

## Verification status

- Supabase security advisor was run on 2026-11-03.
- The advisor reported disabled RLS, RLS-without-policy cases, and a SECURITY DEFINER view.
- No migration has been applied to the live database as part of this audit.
- No Edge Functions were present in the project at audit time.

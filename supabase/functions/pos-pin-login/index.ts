// Repository path: supabase/functions/pos-pin-login/index.ts
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};

const json = (body: Record<string, unknown>, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: corsHeaders });

async function digest(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function hmac(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
  return [...new Uint8Array(signature)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function constantTimeEqual(a: string, b: string): boolean {
  const aa = new TextEncoder().encode(a);
  const bb = new TextEncoder().encode(b);
  let diff = aa.length ^ bb.length;
  const size = Math.max(aa.length, bb.length);
  for (let i = 0; i < size; i++) diff |= (aa[i] ?? 0) ^ (bb[i] ?? 0);
  return diff === 0;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const url = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const identitySecret = Deno.env.get("POS_AUTH_IDENTITY_SECRET");
  if (!url || !serviceKey || !anonKey || !identitySecret) {
    return json({ error: "Login service is not configured" }, 503);
  }

  let input: { storeCode?: unknown; role?: unknown; staffId?: unknown; pin?: unknown };
  try {
    input = await req.json();
  } catch {
    return json({ error: "Invalid request" }, 400);
  }

  const storeCode = typeof input.storeCode === "string" ? input.storeCode.trim() : "";
  const role = typeof input.role === "string" ? input.role : "";
  const pin = typeof input.pin === "string" ? input.pin : String(input.pin ?? "");
  const staffId = typeof input.staffId === "string" ? input.staffId.trim() : "";

  if (!storeCode || storeCode.length > 80 || pin.length < 1 || pin.length > 32 ||
      !["master", "waiter", "cook"].includes(role) ||
      (role !== "master" && (!staffId || staffId.length > 100))) {
    return json({ error: "लॉगिन विवरण सही नहीं हैं" }, 400);
  }

  const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const authClient = createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });

  try {
    const { data: restaurant, error: restaurantError } = await admin
      .from("restaurants")
      .select("id, store_code, name, master_pin")
      .eq("store_code", storeCode)
      .maybeSingle();
    if (restaurantError || !restaurant) return json({ error: "लॉगिन विवरण गलत हैं" }, 401);

    let accountId = restaurant.id as string;
    let storedPin: string;
    let resolvedRole: "master" | "waiter" | "cook";
    if (role === "master") {
      storedPin = String(restaurant.master_pin ?? "");
      resolvedRole = "master";
    } else {
      const { data: staff, error: staffError } = await admin
        .from("hotel_staff")
        .select("id, pin, role")
        .eq("store_code", storeCode)
        .eq("staff_id", staffId)
        .eq("role", role)
        .maybeSingle();
      if (staffError || !staff) return json({ error: "लॉगिन विवरण गलत हैं" }, 401);
      accountId = staff.id as string;
      storedPin = String(staff.pin ?? "");
      resolvedRole = role;
    }

    const ip = req.headers.get("cf-connecting-ip") ?? "unknown";
    const rateKey = await hmac(identitySecret, `${resolvedRole}:${accountId}:${ip}`);
    const { data: allowed, error: rateError } = await admin.rpc("pos_login_rate_limit", {
      p_key_hash: rateKey,
      p_reset: false,
    });
    if (rateError) return json({ error: "Login service temporarily unavailable" }, 503);
    if (allowed !== true) return json({ error: "बहुत अधिक प्रयास हुए हैं। 15 मिनट बाद पुनः प्रयास करें।" }, 429);

    if (!storedPin || !constantTimeEqual(storedPin, pin)) {
      return json({ error: "लॉगिन विवरण गलत हैं" }, 401);
    }

    // The synthetic Auth credential is never sent to the browser. The PIN remains the
    // only user-entered credential; this server secret controls the internal Auth identity.
    const identity = `${resolvedRole}:${accountId}`;
    const email = `pos-${await digest(identity)}@pos-auth.invalid`;
    const password = await hmac(identitySecret, `supabase-auth:${identity}`);

    const { error: createError } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      app_metadata: { pos_managed: true },
    });
    // An existing synthetic account is expected on later logins.
    if (createError && !/already|registered|exists/i.test(createError.message)) {
      return json({ error: "लॉगिन सेवा उपलब्ध नहीं है" }, 503);
    }

    const { data: authData, error: signInError } = await authClient.auth.signInWithPassword({ email, password });
    if (signInError || !authData.session || !authData.user) {
      return json({ error: "लॉगिन सेवा उपलब्ध नहीं है" }, 503);
    }

    const { error: membershipError } = await admin.from("hotel_memberships").upsert({
      auth_user_id: authData.user.id,
      restaurant_id: restaurant.id,
      role: resolvedRole,
      is_active: true,
    }, { onConflict: "auth_user_id,restaurant_id" });
    if (membershipError) return json({ error: "खाते की भूमिका सत्यापित नहीं हो सकी" }, 503);

    await admin.rpc("pos_login_rate_limit", { p_key_hash: rateKey, p_reset: true });

    return json({
      access_token: authData.session.access_token,
      refresh_token: authData.session.refresh_token,
      expires_at: authData.session.expires_at,
      user: { id: authData.user.id },
      profile: {
        role: resolvedRole,
        storeCode: restaurant.store_code,
        hotelName: restaurant.name,
        ...(resolvedRole === "master" ? {} : { staffId }),
      },
    });
  } catch (_error) {
    // Never log PINs, tokens, or raw request bodies.
    return json({ error: "लॉगिन सेवा उपलब्ध नहीं है" }, 500);
  }
});

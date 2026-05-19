export interface SupabaseAdminConfig {
  url: string;
  serviceRoleKey: string;
}

export interface AuthUser {
  id: string;
  email: string;
}

/**
 * Validate a Supabase user JWT by asking the auth server. Returns the user
 * record on success, or null on any failure (expired/invalid/missing).
 */
export async function getUserFromJwt(
  cfg: SupabaseAdminConfig,
  jwt: string,
): Promise<AuthUser | null> {
  const resp = await fetch(`${cfg.url.replace(/\/$/, "")}/auth/v1/user`, {
    headers: {
      apikey: cfg.serviceRoleKey,
      Authorization: `Bearer ${jwt}`,
    },
  });
  if (!resp.ok) return null;
  const body = (await resp.json()) as AuthUser | null;
  return body && body.id ? body : null;
}

/**
 * Look up the most recent stripe_customer_id stored for this user.
 */
export async function getCustomerIdForUser(
  cfg: SupabaseAdminConfig,
  userId: string,
): Promise<string | null> {
  const path =
    `/rest/v1/stripe_subscriptions?user_id=eq.${userId}` +
    `&select=stripe_customer_id&order=created_at.desc&limit=1`;
  const resp = await fetch(`${cfg.url.replace(/\/$/, "")}${path}`, {
    headers: {
      apikey: cfg.serviceRoleKey,
      Authorization: `Bearer ${cfg.serviceRoleKey}`,
    },
  });
  if (!resp.ok) return null;
  const rows = (await resp.json()) as { stripe_customer_id?: string }[];
  return rows[0]?.stripe_customer_id ?? null;
}

interface SupabaseError {
  msg?: string;
  message?: string;
  error?: string;
  error_description?: string;
  code?: string;
}

function extractErrorMessage(body: unknown): string {
  if (typeof body === "string") return body;
  if (body && typeof body === "object") {
    const e = body as SupabaseError;
    return e.msg ?? e.message ?? e.error_description ?? e.error ?? JSON.stringify(body);
  }
  return String(body);
}

async function adminFetch<T>(
  cfg: SupabaseAdminConfig,
  path: string,
  init: RequestInit & { json?: unknown } = {},
): Promise<{ status: number; body: T }> {
  const { json, headers, ...rest } = init;
  const resp = await fetch(`${cfg.url.replace(/\/$/, "")}${path}`, {
    ...rest,
    headers: {
      apikey: cfg.serviceRoleKey,
      Authorization: `Bearer ${cfg.serviceRoleKey}`,
      "content-type": "application/json",
      ...(headers as Record<string, string> | undefined),
    },
    body: json !== undefined ? JSON.stringify(json) : (init as { body?: BodyInit }).body,
  });
  const text = await resp.text();
  let parsed: unknown = text;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      // keep raw text
    }
  }
  return { status: resp.status, body: parsed as T };
}

/**
 * Create a Supabase Auth user with the given email/password. If a user already
 * exists for that email, look it up and return the existing record without
 * touching the password.
 */
export async function ensureUserExists(
  cfg: SupabaseAdminConfig,
  email: string,
  password: string,
  name: string,
): Promise<AuthUser> {
  const created = await adminFetch<AuthUser>(cfg, "/auth/v1/admin/users", {
    method: "POST",
    json: {
      email,
      password,
      email_confirm: true,
      user_metadata: { name },
    },
  });

  if (created.status >= 200 && created.status < 300 && created.body?.id) {
    return created.body;
  }

  const msg = extractErrorMessage(created.body).toLowerCase();
  const isAlreadyExists =
    msg.includes("already") ||
    msg.includes("registered") ||
    msg.includes("user_exists") ||
    msg.includes("email_exists");
  if (!isAlreadyExists) {
    throw new Error(`supabase createUser failed (${created.status}): ${extractErrorMessage(created.body)}`);
  }

  const filter = encodeURIComponent(`email.eq.${email}`);
  const list = await adminFetch<{ users?: AuthUser[] }>(
    cfg,
    `/auth/v1/admin/users?filter=${filter}&per_page=1`,
    { method: "GET" },
  );
  const existing = list.body?.users?.find((u) => u.email === email);
  if (!existing) {
    throw new Error(`supabase lookup by email failed after conflict: ${extractErrorMessage(list.body)}`);
  }
  return existing;
}

export interface StripeSubscriptionRow {
  user_id: string;
  stripe_customer_id: string;
  stripe_subscription_id: string;
  plan_key: string;
  with_sms: boolean;
  status: string;
  trial_end: string | null;
  current_period_end: string | null;
  cancel_at: string | null;
  canceled_at: string | null;
  committed_until: string | null;
  cancellation_fee_amount: number | null;
  raw_metadata: Record<string, unknown>;
}

/**
 * Upsert a row into public.stripe_subscriptions keyed on stripe_subscription_id.
 */
export async function upsertSubscription(
  cfg: SupabaseAdminConfig,
  row: StripeSubscriptionRow,
): Promise<void> {
  const resp = await adminFetch<unknown>(
    cfg,
    "/rest/v1/stripe_subscriptions?on_conflict=stripe_subscription_id",
    {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
      json: row,
    },
  );
  if (resp.status < 200 || resp.status >= 300) {
    throw new Error(`supabase upsert failed (${resp.status}): ${extractErrorMessage(resp.body)}`);
  }
}

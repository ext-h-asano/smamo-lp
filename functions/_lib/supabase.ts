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

export async function adminFetch<T>(
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

  // GoTrue admin API の filter は PostgREST 構文ではなくプレーン文字列の
  // 部分一致検索。部分一致で複数ヒットしうるので per_page を広げて
  // 完全一致を探す。
  const filter = encodeURIComponent(email);
  const list = await adminFetch<{ users?: AuthUser[] }>(
    cfg,
    `/auth/v1/admin/users?filter=${filter}&per_page=50`,
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
 * Recompute users.contract_status from the union of all subscriptions for
 * this user. Any active/trialing/past_due subscription keeps the account
 * active. Returns the resulting status ('active' | 'cancelled') so the
 * caller can log it.
 *
 * Used by the Stripe webhook after each subscription event upsert: the
 * legacy single contract_status column has to reflect the aggregate across
 * multiple subscriptions (per-device pricing model).
 */
export async function recomputeContractStatus(
  cfg: SupabaseAdminConfig,
  userId: string,
): Promise<"active" | "cancelled"> {
  const path =
    `/rest/v1/stripe_subscriptions?user_id=eq.${userId}&select=status`;
  const resp = await fetch(`${cfg.url.replace(/\/$/, "")}${path}`, {
    headers: {
      apikey: cfg.serviceRoleKey,
      Authorization: `Bearer ${cfg.serviceRoleKey}`,
    },
  });
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`stripe_subscriptions list failed (${resp.status}): ${body}`);
  }
  const rows = (await resp.json()) as { status: string }[];
  const liveStatuses = new Set(["active", "trialing", "past_due"]);
  const anyActive = rows.some((r) => liveStatuses.has(r.status));
  // No subscription at all? Treat as cancelled (no entitlement).
  const next: "active" | "cancelled" = anyActive ? "active" : "cancelled";
  await updateUserContractStatus(cfg, userId, next);
  return next;
}

/**
 * Update public.users.contract_status for the given Supabase user.
 * Used after Stripe subscription state changes to keep the legacy column
 * in sync with the Stripe-derived truth.
 */
export async function updateUserContractStatus(
  cfg: SupabaseAdminConfig,
  userId: string,
  contractStatus: "active" | "cancelled",
): Promise<void> {
  const resp = await fetch(
    `${cfg.url.replace(/\/$/, "")}/rest/v1/users?id=eq.${encodeURIComponent(userId)}`,
    {
      method: "PATCH",
      headers: {
        apikey: cfg.serviceRoleKey,
        Authorization: `Bearer ${cfg.serviceRoleKey}`,
        "content-type": "application/json",
        Prefer: "return=minimal",
      },
      body: JSON.stringify({ contract_status: contractStatus }),
    },
  );
  if (resp.status < 200 || resp.status >= 300) {
    const body = await resp.text();
    throw new Error(`supabase users.contract_status update failed (${resp.status}): ${body}`);
  }
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

/**
 * 招待コードから「有効な」代理店の id を解決する。
 * 該当なしは null。疎通/HTTP エラーは throw（呼び出し側で 500 と無効コードを区別するため）。
 * code は呼び出し側で正規化済み（trim + uppercase）を渡すこと。
 */
export async function resolveAgencyByCode(
  cfg: SupabaseAdminConfig,
  code: string,
): Promise<string | null> {
  const path =
    `/rest/v1/agencies?code=eq.${encodeURIComponent(code)}` +
    `&active=eq.true&parent_agency_id=not.is.null&select=id&limit=1`;
  const resp = await fetch(`${cfg.url.replace(/\/$/, "")}${path}`, {
    headers: {
      apikey: cfg.serviceRoleKey,
      Authorization: `Bearer ${cfg.serviceRoleKey}`,
    },
  });
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`agencies lookup failed (${resp.status}): ${body}`);
  }
  const rows = (await resp.json()) as { id?: string }[];
  return rows[0]?.id ?? null;
}

/**
 * users.referred_by_agency_id を「未設定 (NULL) の場合のみ」埋める。
 * is.null ガードにより既存のアトリビューションは上書きしない（再契約/add_device 対策）。
 * 0 行更新（既に紐付け済み）も 2xx で成功扱い。
 */
export async function setUserReferralIfEmpty(
  cfg: SupabaseAdminConfig,
  userId: string,
  agencyId: string,
): Promise<void> {
  const resp = await fetch(
    `${cfg.url.replace(/\/$/, "")}/rest/v1/users` +
      `?id=eq.${encodeURIComponent(userId)}&referred_by_agency_id=is.null`,
    {
      method: "PATCH",
      headers: {
        apikey: cfg.serviceRoleKey,
        Authorization: `Bearer ${cfg.serviceRoleKey}`,
        "content-type": "application/json",
        Prefer: "return=minimal",
      },
      body: JSON.stringify({ referred_by_agency_id: agencyId }),
    },
  );
  if (resp.status < 200 || resp.status >= 300) {
    const body = await resp.text();
    throw new Error(`users.referred_by_agency_id update failed (${resp.status}): ${body}`);
  }
}

/**
 * 招待コードから「有効な子代理店」の表示名を解決する。該当なしは null。
 * checkout.ts の resolveAgencyByCode とは独立（そちらは無改修）。無効コードで
 * 申込フローを止めない、表示専用の軽い照合。code は呼び出し側で正規化済みを渡す。
 */
export async function resolveAgencyNameByCode(
  cfg: SupabaseAdminConfig,
  code: string,
): Promise<{ name: string } | null> {
  const path =
    `/rest/v1/agencies?code=eq.${encodeURIComponent(code)}` +
    `&active=eq.true&parent_agency_id=not.is.null&select=name&limit=1`;
  const resp = await fetch(`${cfg.url.replace(/\/$/, "")}${path}`, {
    headers: {
      apikey: cfg.serviceRoleKey,
      Authorization: `Bearer ${cfg.serviceRoleKey}`,
    },
  });
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`agencies name lookup failed (${resp.status}): ${body}`);
  }
  const rows = (await resp.json()) as { name?: string }[];
  return rows[0]?.name ? { name: rows[0].name } : null;
}

/**
 * 親代理店の招待コードを解決する（子代理店オンボード用）。
 * parent_agency_id IS NULL かつ active のみ。code は正規化済みを渡すこと。
 */
export async function resolveParentAgencyByCode(
  cfg: SupabaseAdminConfig,
  code: string,
): Promise<{ id: string; name: string } | null> {
  const path =
    `/rest/v1/agencies?code=eq.${encodeURIComponent(code)}` +
    `&active=eq.true&parent_agency_id=is.null&select=id,name&limit=1`;
  const resp = await fetch(`${cfg.url.replace(/\/$/, "")}${path}`, {
    headers: {
      apikey: cfg.serviceRoleKey,
      Authorization: `Bearer ${cfg.serviceRoleKey}`,
    },
  });
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`parent agencies lookup failed (${resp.status}): ${body}`);
  }
  const rows = (await resp.json()) as { id?: string; name?: string }[];
  const row = rows[0];
  return row?.id && row?.name ? { id: row.id, name: row.name } : null;
}

/**
 * マーケティングキャンペーンコードから有効なキャンペーン id を解決する。
 * 該当なしは null。code は呼び出し側で正規化済みを渡すこと。
 */
export async function resolveCampaignByCode(
  cfg: SupabaseAdminConfig,
  code: string,
): Promise<string | null> {
  const path =
    `/rest/v1/marketing_campaigns?code=eq.${encodeURIComponent(code)}` +
    `&active=eq.true&select=id&limit=1`;
  const resp = await fetch(`${cfg.url.replace(/\/$/, "")}${path}`, {
    headers: {
      apikey: cfg.serviceRoleKey,
      Authorization: `Bearer ${cfg.serviceRoleKey}`,
    },
  });
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`marketing_campaigns lookup failed (${resp.status}): ${body}`);
  }
  const rows = (await resp.json()) as { id?: string }[];
  return rows[0]?.id ?? null;
}

/**
 * users.acquisition_campaign_id を「未設定 (NULL) の場合のみ」埋める。
 * 再契約 / add_device での上書きを防ぐ。0 行更新も成功扱い。
 */
export async function setUserCampaignIfEmpty(
  cfg: SupabaseAdminConfig,
  userId: string,
  campaignId: string,
): Promise<void> {
  const resp = await fetch(
    `${cfg.url.replace(/\/$/, "")}/rest/v1/users` +
      `?id=eq.${encodeURIComponent(userId)}&acquisition_campaign_id=is.null`,
    {
      method: "PATCH",
      headers: {
        apikey: cfg.serviceRoleKey,
        Authorization: `Bearer ${cfg.serviceRoleKey}`,
        "content-type": "application/json",
        Prefer: "return=minimal",
      },
      body: JSON.stringify({ acquisition_campaign_id: campaignId }),
    },
  );
  if (resp.status < 200 || resp.status >= 300) {
    const body = await resp.text();
    throw new Error(`users.acquisition_campaign_id update failed (${resp.status}): ${body}`);
  }
}

/** lp_visits に1行 INSERT する。 */
export async function insertLpVisit(
  cfg: SupabaseAdminConfig,
  row: {
    campaign_id: string | null;
    campaign_code: string | null;
    session_id: string;
    path: string;
  },
): Promise<void> {
  const resp = await fetch(`${cfg.url.replace(/\/$/, "")}/rest/v1/lp_visits`, {
    method: "POST",
    headers: {
      apikey: cfg.serviceRoleKey,
      Authorization: `Bearer ${cfg.serviceRoleKey}`,
      "content-type": "application/json",
      Prefer: "return=minimal",
    },
    body: JSON.stringify({
      campaign_id: row.campaign_id,
      campaign_code: row.campaign_code,
      session_id: row.session_id,
      path: row.path,
    }),
  });
  if (resp.status < 200 || resp.status >= 300) {
    const body = await resp.text();
    throw new Error(`lp_visits insert failed (${resp.status}): ${body}`);
  }
}

export interface ParentOnboardResult {
  child_id: string;
  child_code: string;
  parent_id: string;
  created: boolean;
}

/**
 * 親コード経由の申込ユーザーを子代理店として登録する（RPC）。
 * 既に agency_members にいる場合は既存を返す（冪等）。
 */
export async function onboardChildViaParentCode(
  cfg: SupabaseAdminConfig,
  parentCode: string,
  userId: string,
  displayName: string,
): Promise<ParentOnboardResult> {
  const resp = await fetch(
    `${cfg.url.replace(/\/$/, "")}/rest/v1/rpc/agency_onboard_via_parent_code`,
    {
      method: "POST",
      headers: {
        apikey: cfg.serviceRoleKey,
        Authorization: `Bearer ${cfg.serviceRoleKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        p_parent_code: parentCode,
        p_user_id: userId,
        p_display_name: displayName,
      }),
    },
  );
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`agency_onboard_via_parent_code failed (${resp.status}): ${body}`);
  }
  const row = (await resp.json()) as ParentOnboardResult;
  if (!row?.child_id || !row?.child_code) {
    throw new Error("agency_onboard_via_parent_code returned unexpected payload");
  }
  return row;
}

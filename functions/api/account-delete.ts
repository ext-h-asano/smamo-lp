import { Env, jsonResponse, makeStripe } from "../_lib/stripe";
import { adminFetch, getUserFromJwt, SupabaseAdminConfig } from "../_lib/supabase";
import { calculateCancellationFee } from "../_lib/cancellation_fee";

/**
 * アプリ内アカウント削除 (App Store Review Guideline 5.1.1(v))。
 *
 * confirm を付けずに叩くと「解約手数料の見積り」を返し、confirm: true で実行する。
 * Apple は誤操作防止の確認ステップを許容しているので、アプリ側は見積り→確認→実行の
 * 2 段で呼ぶこと。
 *
 * 【実行時の順序は変えないこと】
 *   1. Stripe を即時解約 → Webhook (customer.subscription.deleted) が
 *      2年契約の中途解約手数料を請求し、status を canceled に同期する
 *   2. auth ユーザーを BAN + app_metadata.pending_deletion を立てる
 *   3. Go サーバーの cleanup ループが canceled コンテナを解放し、
 *      解放し終わったユーザーの auth.users を物理削除する (runPendingDeletionSweep)
 *
 * 1 より先に 2 を実行すると「課金は続いているのにログインできない」状態を作る。
 * ここで auth.users を直接消してはいけない: stripe_subscriptions が CASCADE で消え、
 * containers.user_id も SET NULL になり、コンテナが解放されずに取り残される。
 */

/** 解約対象とみなす Stripe subscription status。 */
const LIVE_STATUSES = new Set(["active", "trialing", "past_due", "unpaid"]);

/** 実質無期限 (100年)。Supabase の ban_duration は Go の duration 文字列。 */
const BAN_DURATION = "876000h";

interface DeleteRequest {
  confirm?: boolean;
}

interface SubscriptionRow {
  stripe_subscription_id: string;
  plan_key: string;
  status: string;
  raw_metadata?: Record<string, unknown> | null;
}

interface SubscriptionSummary {
  stripe_subscription_id: string;
  plan_key: string;
  device_name: string | null;
  cancellation_fee: number;
  remaining_months: number;
}

async function listSubscriptions(
  cfg: SupabaseAdminConfig,
  userId: string,
): Promise<SubscriptionRow[]> {
  const { status, body } = await adminFetch<SubscriptionRow[] | unknown>(
    cfg,
    `/rest/v1/stripe_subscriptions?user_id=eq.${userId}` +
      `&select=stripe_subscription_id,plan_key,status,raw_metadata`,
  );
  if (status < 200 || status >= 300 || !Array.isArray(body)) {
    throw new Error(`stripe_subscriptions list failed (${status})`);
  }
  return body as SubscriptionRow[];
}

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const auth = request.headers.get("authorization") ?? "";
  const m = /^Bearer\s+(.+)$/i.exec(auth);
  if (!m) return jsonResponse({ error: "missing bearer token" }, 401);

  const cfg: SupabaseAdminConfig = {
    url: env.SUPABASE_URL,
    serviceRoleKey: env.SUPABASE_SECRET_KEY,
  };
  const user = await getUserFromJwt(cfg, m[1]);
  if (!user) return jsonResponse({ error: "invalid or expired token" }, 401);

  let body: DeleteRequest = {};
  try {
    if (request.headers.get("content-type")?.includes("application/json")) {
      body = (await request.json()) as DeleteRequest;
    }
  } catch {
    // empty body = 見積りリクエストとして扱う
  }

  const stripe = makeStripe(env.STRIPE_SECRET_KEY);

  let rows: SubscriptionRow[];
  try {
    rows = await listSubscriptions(cfg, user.id);
  } catch (e) {
    console.error(`[account-delete] subscription list failed user=${user.id}:`, e);
    return jsonResponse({ error: "failed to load subscriptions" }, 500);
  }
  const live = rows.filter((r) => LIVE_STATUSES.has(r.status));

  // 手数料は Stripe の実データ (items の単価 + metadata.committed_until) から出す。
  // Webhook の実請求と同じ _lib/cancellation_fee を通すので金額は必ず一致する。
  const summaries: SubscriptionSummary[] = [];
  for (const row of live) {
    let fee = { amount: 0, remainingMonths: 0 };
    try {
      const sub = await stripe.subscriptions.retrieve(row.stripe_subscription_id);
      fee = calculateCancellationFee({
        planKey: sub.metadata?.plan_key ?? row.plan_key,
        committedUntilIso: sub.metadata?.committed_until,
        unitAmounts: sub.items.data.map((it) => it.price?.unit_amount ?? 0),
        nowMs: Date.now(),
      });
    } catch (e) {
      console.error(
        `[account-delete] stripe retrieve failed sub=${row.stripe_subscription_id}:`,
        e,
      );
      return jsonResponse({ error: "failed to inspect subscription" }, 502);
    }
    summaries.push({
      stripe_subscription_id: row.stripe_subscription_id,
      plan_key: row.plan_key,
      device_name: (row.raw_metadata?.device_name as string | undefined) ?? null,
      cancellation_fee: fee.amount,
      remaining_months: fee.remainingMonths,
    });
  }
  const totalFee = summaries.reduce((s, x) => s + x.cancellation_fee, 0);

  if (body.confirm !== true) {
    return jsonResponse({
      requires_confirmation: true,
      email: user.email,
      subscriptions: summaries,
      total_cancellation_fee: totalFee,
    });
  }

  // --- 実行フェーズ ---------------------------------------------------------
  // 1) 即時解約。Webhook が手数料請求と status 同期を行う。
  for (const s of summaries) {
    try {
      await stripe.subscriptions.cancel(s.stripe_subscription_id);
      console.log(
        `[account-delete] cancelled sub=${s.stripe_subscription_id} user=${user.id}`,
      );
    } catch (e) {
      // 途中で失敗したら BAN せずに中断する。課金が続いたままログイン不能になるのを避ける。
      console.error(
        `[account-delete] cancel failed sub=${s.stripe_subscription_id}:`,
        e,
      );
      return jsonResponse(
        { error: "failed to cancel subscription", stripe_subscription_id: s.stripe_subscription_id },
        502,
      );
    }
  }

  // 2) 即座にログイン不能にし、Go の削除スイープが拾う目印を立てる。
  const banned = await adminFetch(cfg, `/auth/v1/admin/users/${user.id}`, {
    method: "PUT",
    json: {
      ban_duration: BAN_DURATION,
      app_metadata: { pending_deletion: true },
    },
  });
  if (banned.status < 200 || banned.status >= 300) {
    console.error(
      `[account-delete] ban failed user=${user.id} status=${banned.status}`,
      banned.body,
    );
    return jsonResponse({ error: "failed to lock account" }, 500);
  }

  console.log(
    `[account-delete] user=${user.id} locked; ${summaries.length} subscription(s) cancelled, fee=¥${totalFee}`,
  );
  return jsonResponse({
    deleted: true,
    cancelled_subscriptions: summaries.length,
    total_cancellation_fee: totalFee,
  });
};

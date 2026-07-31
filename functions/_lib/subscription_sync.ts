/**
 * Stripe の subscription を Supabase (stripe_subscriptions / users.contract_status) へ同期する。
 * webhook のイベント振り分けと、払い出し経路の自己修復 (auto_provisioning) の両方から使う。
 */
import type Stripe from "stripe";
import type { Env } from "./stripe";
import { StripeSubscriptionRow, recomputeContractStatus, upsertSubscription } from "./supabase";

export async function syncSubscription(
  stripe: Stripe,
  env: Env,
  subscriptionId: string,
  extras: { cancellationFee?: number | null } = {},
): Promise<void> {
  const sub = await stripe.subscriptions.retrieve(subscriptionId);
  const userId = sub.metadata?.supabase_user_id;
  if (!userId) {
    console.warn(`[stripe] sub ${subscriptionId} has no supabase_user_id metadata; skipping upsert`);
    return;
  }
  const customerId = typeof sub.customer === "string" ? sub.customer : sub.customer.id;

  const row: StripeSubscriptionRow = {
    user_id: userId,
    stripe_customer_id: customerId,
    stripe_subscription_id: sub.id,
    plan_key: sub.metadata?.plan_key ?? "unknown",
    with_sms: sub.metadata?.with_sms === "true",
    status: sub.status,
    trial_end: tsToIso(sub.trial_end),
    current_period_end: tsToIso(currentPeriodEnd(sub)),
    cancel_at: tsToIso(sub.cancel_at),
    canceled_at: tsToIso(sub.canceled_at),
    committed_until: sub.metadata?.committed_until ?? null,
    cancellation_fee_amount: extras.cancellationFee ?? null,
    raw_metadata: sub.metadata ?? {},
  };
  const cfg = { url: env.SUPABASE_URL, serviceRoleKey: env.SUPABASE_SECRET_KEY };
  await upsertSubscription(cfg, row);
  console.log(`[stripe] upserted stripe_subscriptions sub=${sub.id} status=${sub.status}`);

  // 集計: 当該ユーザーの全 subscription を再評価して contract_status を決める。
  // 1 ユーザー = 複数 subscription (デバイス毎課金) のため、個別 event だけ見て
  // 上書きすると他の active 契約があっても 'cancelled' に倒してしまう。
  const aggregate = await recomputeContractStatus(cfg, userId);
  console.log(`[stripe] users.contract_status user=${userId} -> ${aggregate}`);
}

function tsToIso(ts: number | null | undefined): string | null {
  return ts ? new Date(ts * 1000).toISOString() : null;
}

function currentPeriodEnd(sub: Stripe.Subscription): number | null {
  // Stripe's newer API stores period end on each subscription item; fall back to the first item.
  const item = sub.items?.data?.[0] as unknown as { current_period_end?: number } | undefined;
  return item?.current_period_end ?? null;
}

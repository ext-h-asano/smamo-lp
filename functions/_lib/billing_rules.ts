/**
 * 課金ライフサイクル系メールの純ロジック (Stripe API 非依存・ユニットテスト対象)。
 */
import type Stripe from "stripe";

export interface TrialReminderCandidate {
  id: string;
  trial_end: number | null;
  cancel_at_period_end: boolean;
}

/**
 * trial_end が now < trial_end <= now+24h かつ解約予約なしの subscription を抽出。
 * 順番待ち凍結中 (trial_end が遠い未来) は自然に対象外になる。
 */
export function selectTrialReminderTargets<T extends TrialReminderCandidate>(
  subs: T[],
  nowSec: number,
): T[] {
  const windowEnd = nowSec + 24 * 3600;
  return subs.filter(
    (s) =>
      typeof s.trial_end === "number" &&
      s.trial_end > nowSec &&
      s.trial_end <= windowEnd &&
      !s.cancel_at_period_end,
  );
}

/**
 * customer.subscription.updated が「解約予約が入った瞬間」(cancel_at_period_end: false→true)
 * かどうかを判定。previous_attributes に当該フィールドが無ければ false。
 */
export function isCancelRequested(
  eventType: string,
  previousAttributes: Record<string, unknown> | undefined,
  sub: { cancel_at_period_end: boolean },
): boolean {
  return (
    eventType === "customer.subscription.updated" &&
    !!previousAttributes &&
    "cancel_at_period_end" in previousAttributes &&
    previousAttributes["cancel_at_period_end"] === false &&
    sub.cancel_at_period_end === true
  );
}

/** invoice から subscription id を取り出す (新旧 API 形状両対応)。webhook.ts から移設 */
export function extractSubscriptionId(invoice: Stripe.Invoice): string | null {
  const parent = (
    invoice as unknown as { parent?: { subscription_details?: { subscription?: string } } }
  ).parent;
  const fromParent = parent?.subscription_details?.subscription;
  if (fromParent) return fromParent;
  const legacy = (invoice as unknown as { subscription?: string | Stripe.Subscription }).subscription;
  if (!legacy) return null;
  return typeof legacy === "string" ? legacy : legacy.id;
}

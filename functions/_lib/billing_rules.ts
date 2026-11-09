/**
 * 課金ライフサイクル系メールの純ロジック (Stripe API 非依存・ユニットテスト対象)。
 */
import type Stripe from "stripe";

export interface TrialReminderCandidate {
  id: string;
  trial_end: number | null;
  cancel_at_period_end: boolean;
  cancel_at?: number | null;
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
      !isCancelScheduled(s),
  );
}

/**
 * 解約予約が入っているか。Stripe のポータルは cancel_at_period_end ではなく
 * cancel_at（終了日時）だけを入れて解約予約することがある（2026-10-28 実測）ので両方を見る。
 */
export function isCancelScheduled(sub: {
  cancel_at_period_end: boolean;
  cancel_at?: number | null;
}): boolean {
  return sub.cancel_at_period_end === true || typeof sub.cancel_at === "number";
}

/**
 * customer.subscription.updated が「解約予約が入った瞬間」かどうかを判定。
 * cancel_at_period_end: false→true か cancel_at: null→日時 のどちらか。
 * previous_attributes に当該フィールドが無ければ false。
 */
export function isCancelRequested(
  eventType: string,
  previousAttributes: Record<string, unknown> | undefined,
  sub: { cancel_at_period_end: boolean; cancel_at?: number | null },
): boolean {
  if (eventType !== "customer.subscription.updated" || !previousAttributes) return false;
  const periodEndRequested =
    "cancel_at_period_end" in previousAttributes &&
    previousAttributes["cancel_at_period_end"] === false &&
    sub.cancel_at_period_end === true;
  const cancelAtRequested =
    "cancel_at" in previousAttributes &&
    previousAttributes["cancel_at"] == null &&
    typeof sub.cancel_at === "number";
  return periodEndRequested || cancelAtRequested;
}

/**
 * customer.subscription.updated が「解約予約が取り消された瞬間」かどうかを判定。
 * 変更前は予約あり（cancel_at_period_end=true か cancel_at が日時）で、今は予約なし。
 */
export function isCancelUndone(
  eventType: string,
  previousAttributes: Record<string, unknown> | undefined,
  sub: { cancel_at_period_end: boolean; cancel_at?: number | null },
): boolean {
  if (eventType !== "customer.subscription.updated" || !previousAttributes) return false;
  if (!("cancel_at_period_end" in previousAttributes) && !("cancel_at" in previousAttributes)) {
    return false;
  }
  const wasScheduled =
    previousAttributes["cancel_at_period_end"] === true ||
    typeof previousAttributes["cancel_at"] === "number";
  return wasScheduled && !isCancelScheduled(sub);
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

/**
 * カード未確定のまま残った「幽霊契約」を判定する純ロジック (Stripe API 非依存・ユニットテスト対象)。
 *
 * 背景 (2026-09 の実害):
 *   /api/checkout は POST のたびに無条件で subscription を作る。3D セキュア失敗やカード入力画面からの
 *   離脱で SetupIntent が完了しなくても、trial_period_days が付くため subscription は `incomplete` では
 *   なく `trialing` で生まれる。Stripe の自動失効 (incomplete_expired) は trialing には効かないので、
 *   カード未確定の契約が 3 日後に必ず請求されてしまう (実際に二重契約 → card_velocity_exceeded が発生)。
 *
 * 判別条件 (本番データで検証済み。正常契約とはきれいに分離できる):
 *   pending_setup_intent != null かつ default_payment_method == null
 *   → カード確定に成功すると Stripe は pending_setup_intent を null にし default_payment_method を埋める。
 */
import type Stripe from "stripe";

/** スイープ対象とみなすまでの最低経過時間。カード入力に手間取っている最中の人を巻き込まないため */
export const STALE_SIGNUP_MIN_AGE_SEC = 60 * 60;

/** 幽霊契約になりうるステータス。active / past_due 等は課金が動いているので触らない */
const UNCONFIRMED_STATUSES = new Set(["trialing", "incomplete"]);

export interface StaleSignupCandidate {
  id: string;
  status: string;
  created?: number | null;
  pending_setup_intent?: unknown;
  default_payment_method?: unknown;
  metadata?: Record<string, string> | null;
}

/** カード未確定のまま残っている申込かどうか（経過時間もユーザーも見ない、コア条件のみ） */
export function isCardUnconfirmedSignup(sub: StaleSignupCandidate): boolean {
  if (!UNCONFIRMED_STATUSES.has(sub.status)) return false;
  if (sub.pending_setup_intent === null || sub.pending_setup_intent === undefined) return false;
  return sub.default_payment_method === null || sub.default_payment_method === undefined;
}

/**
 * 層1: 同じユーザーが再送信したときに残っている、前回の失敗分を選ぶ。
 * metadata.supabase_user_id が一致するものだけ。空 ID なら安全側で何も選ばない。
 */
export function selectStaleSignupSubscriptions<T extends StaleSignupCandidate>(
  subs: T[],
  supabaseUserId: string,
): T[] {
  if (!supabaseUserId) return [];
  return subs.filter(
    (s) => isCardUnconfirmedSignup(s) && s.metadata?.supabase_user_id === supabaseUserId,
  );
}

/**
 * 層2: 離脱ユーザー分を Customer 横断で回収する。ユーザー一致は問わないが、
 * 作成から minAgeSec 以上経過しているものに限る。
 */
export function selectAgedStaleSignupSubscriptions<T extends StaleSignupCandidate>(
  subs: T[],
  nowSec: number,
  minAgeSec: number = STALE_SIGNUP_MIN_AGE_SEC,
): T[] {
  return subs.filter(
    (s) =>
      isCardUnconfirmedSignup(s) &&
      typeof s.created === "number" &&
      nowSec - s.created >= minAgeSec,
  );
}

/** invoice item から紐づく subscription id を取り出す (新旧 API 形状両対応) */
export function invoiceItemSubscriptionId(item: unknown): string | null {
  const it = item as {
    parent?: { subscription_details?: { subscription?: string | null } | null } | null;
    subscription?: string | { id: string } | null;
  };
  const fromParent = it?.parent?.subscription_details?.subscription;
  if (fromParent) return fromParent;
  const legacy = it?.subscription;
  if (!legacy) return null;
  return typeof legacy === "string" ? legacy : legacy.id;
}

/**
 * 対象 subscription に紐づく「まだ請求書に載っていない」invoice item を選ぶ。
 * 契約だけキャンセルしてこれを残すと、次回請求に初期費用 ¥33,000 が紛れ込む。
 */
export function selectPendingInvoiceItemsForSubscription<T extends { invoice?: unknown }>(
  items: T[],
  subscriptionId: string,
): T[] {
  return items.filter(
    (it) =>
      !it.invoice &&
      invoiceItemSubscriptionId(it) === subscriptionId,
  );
}

function customerIdOf(sub: { customer?: unknown }): string | null {
  const c = sub.customer;
  if (typeof c === "string") return c;
  if (c && typeof c === "object" && typeof (c as { id?: unknown }).id === "string") {
    return (c as { id: string }).id;
  }
  return null;
}

/**
 * 幽霊契約を後始末する: 紐づく未請求 invoice item を消してから subscription をキャンセルする。
 * invoice item の削除に失敗してもキャンセルは続行する（請求を止める方が優先）。
 * subscription のキャンセルに失敗した場合は throw する（呼び出し側で failed として数える）。
 */
export async function cancelStaleSignupSubscription(
  stripe: Stripe,
  sub: { id: string; customer?: unknown },
): Promise<void> {
  const customerId = customerIdOf(sub);
  if (customerId) {
    try {
      const items = await stripe.invoiceItems.list({ customer: customerId, pending: true, limit: 100 });
      for (const item of selectPendingInvoiceItemsForSubscription(items.data, sub.id)) {
        await stripe.invoiceItems.del(item.id);
        console.log(`[stale-signup] invoice item を削除 ii=${item.id} sub=${sub.id}`);
      }
    } catch (err) {
      console.error(
        `[stale-signup] invoice item の削除に失敗 sub=${sub.id}:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }
  await stripe.subscriptions.cancel(sub.id);
  console.log(`[stale-signup] カード未確定の契約をキャンセル sub=${sub.id}`);
}

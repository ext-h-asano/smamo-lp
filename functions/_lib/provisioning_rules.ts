/**
 * コンテナ払い出しの発火条件を判定する純ロジック (Stripe API 非依存・ユニットテスト対象)。
 *
 * 割当は「カードが確定した後」だけに限定する。契約作成 (customer.subscription.created) は
 * カード入力前に発火するため、そこでは割り当てない。
 */
import type Stripe from "stripe";

/**
 * customer.subscription.updated が「支払い方法が未設定 → 設定 に変わった瞬間」かどうか。
 * setup_intent.succeeded を取りこぼした場合の安全網として使う。
 * 既に支払い方法があった契約のカード差し替えでは false（再割当を誘発しない）。
 */
export function shouldProvisionOnSubscriptionUpdate(
  previousAttributes: Record<string, unknown> | undefined,
  sub: { default_payment_method?: string | Stripe.PaymentMethod | null },
): boolean {
  if (!previousAttributes) return false;
  if (!("default_payment_method" in previousAttributes)) return false;
  const prev = previousAttributes["default_payment_method"];
  if (prev !== null && prev !== undefined) return false;
  return Boolean(sub.default_payment_method);
}

/**
 * setup_intent.succeeded から対象 subscription を一意に特定する。
 *
 * カード登録が成功すると Stripe は subscription.pending_setup_intent を null にするため、
 * SetupIntent 側から逆引きすることはできない (2026-07-31 実測)。そこで /api/checkout が
 * 申込時に SetupIntent の metadata.subscription_id へ紐付けを書き込んでいる。
 *
 * metadata が無いのは本修正のデプロイ時点で決済途中だった契約だけ。その場合に限り
 * 旧来の推測 (trialing/active の先頭一致) にフォールバックする。
 * metadata が指す契約が一覧に無い場合は推測で代用せず null を返す (呼出側が critical を出す)。
 */
export function matchSubscriptionForSetupIntent<T extends { id: string; status: string }>(
  si: { metadata?: Record<string, string> | null },
  subs: T[],
): T | null {
  const linked = si.metadata?.subscription_id;
  if (linked) return subs.find((s) => s.id === linked) ?? null;
  return subs.find((s) => s.status === "trialing" || s.status === "active") ?? subs[0] ?? null;
}

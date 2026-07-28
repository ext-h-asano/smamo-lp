import {
  INITIAL_FEE_JPY,
  PLAN_AMOUNTS_JPY,
  PLAN_HAS_INITIAL_FEE,
  PlanKey,
  SMS_OPTION_FEE_JPY,
} from "./plans";

/**
 * 初期費用の免除まわりの判定を一箇所に集約する。
 *
 * 免除対象の招待コードは環境変数 INITIAL_FEE_WAIVER_CODES（カンマ区切り）で与える。
 * 未設定・空なら「誰も免除しない」。設定漏れが意図せぬ全員無料にならない側に倒している。
 */

/** "a, b" → Set{"A","B"}。trim + 大文字化して比較を安定させる。 */
export function parseWaiverCodes(raw?: string | null): Set<string> {
  const codes = (raw ?? "")
    .split(",")
    .map((c) => c.trim().toUpperCase())
    .filter((c) => c !== "");
  return new Set(codes);
}

/** 入力された招待コードが初期費用の免除対象か。 */
export function isInitialFeeWaiverCode(code: string, raw?: string | null): boolean {
  const normalized = (code ?? "").trim().toUpperCase();
  if (normalized === "") return false;
  return parseWaiverCodes(raw).has(normalized);
}

/**
 * 既存 subscription が初期費用免除で作られたか。
 * checkout.ts は metadata.initial_fee_waived に理由文字列 ("invitation_code") を入れるため、
 * 値の中身ではなく「入っているか」で判定する。
 *
 * 判定材料は metadata のみ。実際の課金は Stripe の invoice item の有無で決まっており、
 * それを記録しているのがこの metadata であるため、環境変数のグローバル免除スイッチを
 * 信じるとメールの金額が実際の請求と食い違う。
 */
export function isSubscriptionInitialFeeWaived(metadata?: Record<string, string> | null): boolean {
  return Boolean(metadata?.initial_fee_waived);
}

/** 初回請求額（プラン + SMS オプション + 初期費用）。メール表示のフォールバック計算用。 */
export function firstChargeAmountJpy(
  planKey: PlanKey,
  withSms: boolean,
  waived: boolean,
): number {
  const planAmount = PLAN_AMOUNTS_JPY[planKey] ?? PLAN_AMOUNTS_JPY.monthly;
  const initFee = !waived && PLAN_HAS_INITIAL_FEE[planKey] ? INITIAL_FEE_JPY : 0;
  const smsFee = withSms ? SMS_OPTION_FEE_JPY : 0;
  return planAmount + initFee + smsFee;
}

/**
 * subscription metadata から初回請求額を求める。
 * Stripe の invoice preview が使えない場面（ウェルカムメール / リマインダーのフォールバック）用。
 */
export function firstChargeAmountForSubscription(metadata?: Record<string, string> | null): number {
  const planKey = (metadata?.plan_key as PlanKey | undefined) ?? "monthly";
  const withSms = metadata?.with_sms === "true";
  return firstChargeAmountJpy(planKey, withSms, isSubscriptionInitialFeeWaived(metadata));
}

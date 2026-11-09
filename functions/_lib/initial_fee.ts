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
  const amount = firstChargeAmountJpy(planKey, withSms, isSubscriptionInitialFeeWaived(metadata));
  // 特別対応アカウントの恒久割引（checkout.ts が forever クーポンと一緒に記録する）
  const special = Number(metadata?.special_monthly_jpy);
  if (planKey === "monthly" && Number.isFinite(special) && special > 0) {
    return amount - PLAN_AMOUNTS_JPY.monthly + special;
  }
  return amount;
}

/** 初期費用の請求明細を Stripe 上で探す・消す・作るのに要る最小限の API。テストで差し替える。 */
export interface InitialFeeStripe {
  invoiceItems: {
    list(params: { customer: string; pending: boolean; limit: number }): Promise<{
      data: Array<{
        id: string;
        metadata?: Record<string, string> | null;
        subscription?: string | { id: string } | null;
        parent?: { subscription_details?: { subscription?: string } | null } | null;
      }>;
    }>;
    del(id: string): Promise<unknown>;
    create(params: {
      customer: string;
      subscription: string;
      amount: number;
      currency: string;
      description: string;
      metadata: Record<string, string>;
    }): Promise<unknown>;
  };
}

interface TrialSub {
  id: string;
  customer: string | { id: string };
  status: string;
  metadata?: Record<string, string> | null;
}

async function pendingInitialFeeItemIds(stripe: InitialFeeStripe, sub: TrialSub): Promise<string[]> {
  const customer = typeof sub.customer === "string" ? sub.customer : sub.customer.id;
  const { data } = await stripe.invoiceItems.list({ customer, pending: true, limit: 100 });
  return data
    .filter((ii) => ii.metadata?.kind === "initial_fee")
    .filter((ii) => {
      const legacy = typeof ii.subscription === "string" ? ii.subscription : ii.subscription?.id;
      return (ii.parent?.subscription_details?.subscription ?? legacy) === sub.id;
    })
    .map((ii) => ii.id);
}

/**
 * お試し期間中に解約予約が入ったら、その契約に付いた初期費用の明細を消す。
 *
 * checkout.ts は初期費用を「次の請求に載る明細」として先に作っておく。お試し中に解約予約
 * (cancel_at) が入ると、お試し終了＝契約終了の時点で Stripe がこの明細だけを請求してしまい、
 * 解約した人に ¥33,000 が請求された（2026-10-31 実例）。お試し中でなければ初期費用は
 * 初回請求で精算済みなので何もしない。
 */
export async function removeInitialFeeOnTrialCancel(
  stripe: InitialFeeStripe,
  sub: TrialSub,
): Promise<number> {
  if (sub.status !== "trialing") return 0;
  const ids = await pendingInitialFeeItemIds(stripe, sub);
  for (const id of ids) await stripe.invoiceItems.del(id);
  if (ids.length > 0) {
    console.log(`[initial_fee] お試し中の解約予約で初期費用を取り消し: sub=${sub.id} items=${ids.join(",")}`);
  }
  return ids.length;
}

/**
 * お試し期間中に解約予約が取り消されたら、消した初期費用の明細を付け直す。
 * 免除契約・初期費用の無いプラン・すでに明細がある場合は何もしない。
 */
export async function restoreInitialFeeOnCancelUndone(
  stripe: InitialFeeStripe,
  sub: TrialSub,
): Promise<boolean> {
  if (sub.status !== "trialing") return false;
  if (isSubscriptionInitialFeeWaived(sub.metadata)) return false;
  const planKey = (sub.metadata?.plan_key as PlanKey | undefined) ?? "monthly";
  if (!PLAN_HAS_INITIAL_FEE[planKey]) return false;
  if ((await pendingInitialFeeItemIds(stripe, sub)).length > 0) return false;
  const customer = typeof sub.customer === "string" ? sub.customer : sub.customer.id;
  await stripe.invoiceItems.create({
    customer,
    subscription: sub.id,
    amount: INITIAL_FEE_JPY,
    currency: "jpy",
    description: "初期費用",
    metadata: { kind: "initial_fee", plan_key: planKey },
  });
  console.log(`[initial_fee] 解約予約の取り消しで初期費用を付け直し: sub=${sub.id}`);
  return true;
}

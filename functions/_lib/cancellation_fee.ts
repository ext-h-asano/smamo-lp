/** 単価が取得できなかったときに使う 2 年プランの月額 (税込円)。 */
export const TWO_YEAR_MONTHLY_FEE_FALLBACK_JPY = 5478;

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

export interface CancellationFeeInput {
  /** Subscription.metadata.plan_key */
  planKey: string | null | undefined;
  /** Subscription.metadata.committed_until (ISO8601) */
  committedUntilIso: string | null | undefined;
  /** Subscription.items.data.map((it) => it.price?.unit_amount ?? 0) */
  unitAmounts: number[];
  nowMs: number;
}

export interface CancellationFeeResult {
  /** 拘束期間の残月数 (切り上げ)。手数料が発生しない場合は 0。 */
  remainingMonths: number;
  /** 請求額 (税込円)。発生しない場合は 0。 */
  amount: number;
}

const NO_FEE: CancellationFeeResult = { remainingMonths: 0, amount: 0 };

/**
 * 2 年プランの中途解約手数料を算出する。
 *
 * アカウント削除フローの事前見積り (api/account-delete) と、実際に請求する
 * Webhook (customer.subscription.deleted) の両方から呼ぶ。両者が食い違うと
 * 「提示額と請求額が違う」という課金クレームになるため、必ずここを共有すること。
 */
export function calculateCancellationFee(
  input: CancellationFeeInput,
): CancellationFeeResult {
  if (input.planKey !== "two_year" || !input.committedUntilIso) return NO_FEE;

  const committedUntilMs = new Date(input.committedUntilIso).getTime();
  if (Number.isNaN(committedUntilMs)) return NO_FEE;

  const remainingMonths = Math.ceil(
    (committedUntilMs - input.nowMs) / THIRTY_DAYS_MS,
  );
  if (remainingMonths <= 0) return NO_FEE;

  // items には SMS オプション (¥550) が併存しうるので、最大額の項目＝プラン本体とみなす。
  const planMonthlyFee = Math.max(0, ...input.unitAmounts);
  const unit =
    planMonthlyFee > 0 ? planMonthlyFee : TWO_YEAR_MONTHLY_FEE_FALLBACK_JPY;

  return { remainingMonths, amount: remainingMonths * unit };
}

export type PlanKey = "monthly" | "yearly" | "two_year" | "lite";

/**
 * スマモ ライト（plan_key='lite'）: 通話（LINE 等の音声・ビデオ通話を含む）ができない代わりに安い月額プラン。
 * 実体は実機フォンファーム（containers.status='phone'）で、割当先の振り分けは DB の
 * plan_device_status() が正本（vpn_project_server/docs/lite_plan_phone_devices.sql）。
 *
 * 2026-10 時点では LP 本体には載せず、非公開ページ /lite からのみ申し込める。
 * LP に公開するときは index.html の料金カードに data-plan="lite" の CTA を足すだけでよい
 * （フロントの PLANS・checkout・webhook・メールは全プラン共通で lite を扱える）。
 */
export const LITE_PLAN_KEY = "lite" as const;

/** 実機（フォンファーム）に割り当たるプランか。運用通知の文言の出し分けに使う。 */
export function isPhoneDevicePlan(planKey: string | null | undefined): boolean {
  return planKey === LITE_PLAN_KEY;
}

/** 返却された実機を初期化してプールへ戻す手順（運用通知に載せる）。 */
export const PHONE_RETURN_ACTION =
  ".4 で vpn_project_server/scripts/phonefarm/return_phone_to_pool.sh を実行（引数なしで返却機一覧）。初期化してから status='phone' に戻すと順番待ちへ自動割当される";

export interface PlanConfig {
  priceId: string;
  hasInitialFee: boolean;
  commitMonths?: number;
}

export function getPlans(env: {
  STRIPE_PRICE_MONTHLY: string;
  STRIPE_PRICE_YEARLY: string;
  STRIPE_PRICE_TWO_YEAR: string;
  STRIPE_PRICE_LITE?: string;
}): Record<PlanKey, PlanConfig> {
  return {
    monthly: { priceId: env.STRIPE_PRICE_MONTHLY, hasInitialFee: true },
    yearly: { priceId: env.STRIPE_PRICE_YEARLY, hasInitialFee: true },
    two_year: { priceId: env.STRIPE_PRICE_TWO_YEAR, hasInitialFee: false, commitMonths: 24 },
    // STRIPE_PRICE_LITE 未設定の環境では priceId が空になり、checkout が申込を断る。
    lite: { priceId: env.STRIPE_PRICE_LITE ?? "", hasInitialFee: PLAN_HAS_INITIAL_FEE.lite },
  };
}

export const PLAN_DISPLAY_NAME: Record<PlanKey, string> = {
  monthly: "SMAMO 月額プラン",
  yearly: "SMAMO 年払いプラン",
  two_year: "SMAMO 2年プラン",
  lite: "SMAMO ライトプラン（通話なし）",
};

export const INITIAL_FEE_JPY = 33000;
export const TRIAL_DAYS = 3;

export const SMS_OPTION_FEE_JPY = 550;

export const PLAN_AMOUNTS_JPY: Record<PlanKey, number> = {
  monthly: 3828,
  yearly: 38280,
  two_year: 6028,
  lite: 2480,
};

export const PLAN_HAS_INITIAL_FEE: Record<PlanKey, boolean> = {
  monthly: true,
  yearly: true,
  two_year: false,
  lite: true,
};

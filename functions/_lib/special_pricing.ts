import type Stripe from "stripe";
import { PLAN_AMOUNTS_JPY, PlanKey } from "./plans";

/**
 * 個別の特別対応アカウント（メールアドレス単位）。
 *
 * - initialFeeWaived: 初期費用を請求しない（全プラン）
 * - monthlyJpy: 月額プランの月額を恒久的にこの金額にする（Stripe の forever クーポンで差額を引く）
 *
 * 2026-10-09 ユーザー指示: pb.kanada@gmail.com は初期費用なし・月額 ¥2,480 を永久に。
 * 追加端末（add_device）も同じメールで申し込むので同じ扱いになる。
 */
export interface SpecialPricing {
  initialFeeWaived: boolean;
  monthlyJpy?: number;
}

const SPECIAL_ACCOUNTS: Record<string, SpecialPricing> = {
  "pb.kanada@gmail.com": { initialFeeWaived: true, monthlyJpy: 2480 },
};

export function specialPricingFor(email: string | null | undefined): SpecialPricing | null {
  const key = (email ?? "").trim().toLowerCase();
  return SPECIAL_ACCOUNTS[key] ?? null;
}

/** 月額プランの特別月額。対象外（別プラン・設定なし）なら null。 */
export function specialMonthlyJpy(sp: SpecialPricing | null, planKey: PlanKey): number | null {
  if (!sp?.monthlyJpy || planKey !== "monthly") return null;
  if (sp.monthlyJpy >= PLAN_AMOUNTS_JPY.monthly) return null;
  return sp.monthlyJpy;
}

/**
 * 「月額を amountJpy にする」forever クーポンを用意して ID を返す。
 * ID を金額から決め打ちにして、test/live どちらの環境でも初回だけ作成・以後は再利用する。
 */
export async function ensureSpecialMonthlyCoupon(stripe: Stripe, amountJpy: number): Promise<string> {
  const id = `smamo_special_monthly_${amountJpy}`;
  try {
    const c = await stripe.coupons.retrieve(id);
    if (c.valid) return c.id;
  } catch (err) {
    const code = (err as { code?: string; statusCode?: number })?.code;
    const status = (err as { statusCode?: number })?.statusCode;
    if (code !== "resource_missing" && status !== 404) throw err;
  }
  const c = await stripe.coupons.create({
    id,
    name: `特別料金（月額¥${amountJpy.toLocaleString("ja-JP")}）`,
    amount_off: PLAN_AMOUNTS_JPY.monthly - amountJpy,
    currency: "jpy",
    duration: "forever",
  });
  return c.id;
}

import Stripe from "stripe";

export function makeStripe(secret: string): Stripe {
  return new Stripe(secret, {
    apiVersion: "2025-09-30.clover" as Stripe.LatestApiVersion,
    httpClient: Stripe.createFetchHttpClient(),
  });
}

export interface Env {
  STRIPE_SECRET_KEY: string;
  STRIPE_PUBLISHABLE_KEY: string;
  STRIPE_WEBHOOK_SECRET: string;
  STRIPE_PRICE_MONTHLY: string;
  STRIPE_PRICE_YEARLY: string;
  STRIPE_PRICE_TWO_YEAR: string;
  STRIPE_PRICE_SMS_OPTION: string;
  STRIPE_PRODUCT_INITIAL_FEE: string;
  SUPABASE_URL: string;
  SUPABASE_SECRET_KEY: string;
  /** Resend API key for transactional emails. 未設定なら welcome メールは飛ばさない (warn ログのみ) */
  RESEND_API_KEY?: string;
  /** Discord webhook URL (provisioning 結果通知用)。未設定なら通知を skip するだけ */
  DISCORD_WEBHOOK_URL?: string;
  /** 割当成功後のプール残量がこの値以下なら warn 通知。数値文字列。デフォルト "3" */
  POOL_WARN_THRESHOLD?: string;
  /** 初期費用 ¥33,000 を免除する招待コード（カンマ区切り、大文字小文字問わず）。例: "P-9A22DB44"（パビオ本体）。未設定なら誰も免除しない */
  INITIAL_FEE_WAIVER_CODES?: string;
  /** 順番待ち登録時に trial_end を凍結する日数。数値文字列。デフォルト "365" */
  WAITLIST_FREEZE_DAYS?: string;
  /** ドレインエンドポイントの認証シークレット */
  DRAIN_SECRET: string;
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

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
  /** "true" のとき、初期費用無料キャンペーンを有効化し checkout で初期費用 ¥33,000 の付与をスキップする。終了時は "false" / 未設定にして再デプロイ */
  INITIAL_FEE_WAIVED?: string;
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

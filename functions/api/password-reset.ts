import { Env, jsonResponse } from "../_lib/stripe";
import { sendRecoveryEmail } from "../_lib/supabase";

/**
 * パスワード再設定メールを送る。
 *
 * 応答は常に 200 { ok: true }。未登録・レート制限・Supabase 障害もすべて同じ。
 * 「送ったかどうか」を応答から読み取らせないためで、存在判定が要る場面は
 * /api/account-check が担当する。
 *
 * redirect_to はリクエスト元のオリジンから組み立てるので、dev.smamo.jp からの
 * 要求は dev.smamo.jp/reset に戻る。Supabase ダッシュボードの Redirect URL
 * 許可リストに両方の /reset を登録しておくこと。
 */
export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  let body: { email?: string };
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ ok: true });
  }

  const email = (body.email ?? "").trim();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return jsonResponse({ ok: true });
  }

  const cfg = { url: env.SUPABASE_URL, serviceRoleKey: env.SUPABASE_SECRET_KEY };
  const redirectTo = new URL("/reset", request.url).toString();
  try {
    await sendRecoveryEmail(cfg, email, redirectTo);
  } catch (err) {
    console.error("[password-reset] failed:", err instanceof Error ? err.message : String(err));
  }
  return jsonResponse({ ok: true });
};

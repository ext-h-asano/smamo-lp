import { Env, jsonResponse } from "../_lib/stripe";
import { updatePasswordWithToken } from "../_lib/supabase";

const INVALID_TOKEN = {
  error: "リンクの有効期限が切れています。もう一度お試しください。",
  code: "invalid_token",
};

/**
 * 再設定メールのリンク (/reset#access_token=...) から渡された recovery トークンで
 * パスワードを更新する。トークンの検証は Supabase の PUT /auth/v1/user に任せる。
 */
export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  let body: { access_token?: string; password?: string };
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "invalid JSON body" }, 400);
  }

  const accessToken = (body.access_token ?? "").trim();
  const password = body.password ?? "";
  if (!accessToken) return jsonResponse(INVALID_TOKEN, 401);
  if (password.length < 8) {
    return jsonResponse({ error: "パスワードは 8 文字以上で入力してください。" }, 400);
  }

  const cfg = { url: env.SUPABASE_URL, serviceRoleKey: env.SUPABASE_SECRET_KEY };
  try {
    const ok = await updatePasswordWithToken(cfg, accessToken, password);
    if (!ok) return jsonResponse(INVALID_TOKEN, 401);
    return jsonResponse({ ok: true });
  } catch (err) {
    console.error("[password-update] failed:", err instanceof Error ? err.message : String(err));
    return jsonResponse({ error: "システムエラーが発生しました。時間をおいて再度お試しください。" }, 500);
  }
};

import { Env, jsonResponse } from "../_lib/stripe";
import { findUserByEmail, verifyPassword } from "../_lib/supabase";

interface AccountCheckRequest {
  email?: string;
  password?: string;
}

/**
 * 申込フォーム Step 1 用。入力されたメールアドレスが既に登録済みかを、
 * ユーザーを作らずに判定する。既存なら入力パスワードで本人確認まで行う。
 *
 * カード入力の前にここで決着させるのが目的。Step 2 で弾くと、顧客は
 * カードを入れ直す羽目になる（招待コード検証を Step 1 でやっているのと同じ理由）。
 *
 * 判定結果はクライアントの表示制御にしか使わない。契約作成時は /api/checkout が
 * ensureUserExists で同じ認証をやり直すので、ここを迂回しても意味を持たない。
 */
export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  let body: AccountCheckRequest;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "invalid JSON body" }, 400);
  }

  const email = (body.email ?? "").trim();
  const password = body.password ?? "";
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return jsonResponse({ error: "invalid email" }, 400);
  }
  if (password.length < 8) {
    return jsonResponse({ error: "パスワードは 8 文字以上で入力してください。" }, 400);
  }

  const cfg = { url: env.SUPABASE_URL, serviceRoleKey: env.SUPABASE_SECRET_KEY };
  try {
    const existing = await findUserByEmail(cfg, email);
    if (!existing) return jsonResponse({ exists: false });
    const authenticated = await verifyPassword(cfg, email, password);
    return jsonResponse({ exists: true, authenticated });
  } catch (err) {
    console.error("[account-check] failed:", err instanceof Error ? err.message : String(err));
    return jsonResponse({ error: "システムエラーが発生しました。時間をおいて再度お試しください。" }, 500);
  }
};

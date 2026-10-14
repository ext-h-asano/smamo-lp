/**
 * POST /api/apple/verify-purchase
 * iOS アプリが購入完了直後と「購入を復元」の後に呼ぶ（docs/ios_iap_design.md）。
 *
 * 認証: Authorization: Bearer <Supabase access token>
 * 本文: { "signedTransaction": "<StoreKit 2 の JWS>" }
 * 応答:
 *   200 { status: "ok" | "already" | "waitlisted" | "inactive", containerId? }
 *   400 JWS 不正 / bundle・product 違い
 *   401 トークン不正
 *   403 appAccountToken がログイン中のユーザーと違う
 *   409 { error: "transaction_owned_by_other_user" } 同じ Apple 契約が別アカウントに紐付いている
 *   500 一時的な障害（アプリは completePurchase せず次回再送する）
 */
import { Env, jsonResponse } from "../../_lib/stripe";
import { getUserFromJwt } from "../../_lib/supabase";
import { AppleJwsError, verifyAppleJws } from "../../_lib/apple_jws";
import {
  type AppleTransaction,
  appleBundleId,
  appleProductId,
  applyAppleState,
  provisionAppleSubscription,
} from "../../_lib/apple_subscription";

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const m = /^Bearer\s+(.+)$/i.exec(request.headers.get("authorization") ?? "");
  if (!m) return jsonResponse({ error: "missing bearer token" }, 401);

  const cfg = { url: env.SUPABASE_URL, serviceRoleKey: env.SUPABASE_SECRET_KEY };
  const user = await getUserFromJwt(cfg, m[1]);
  if (!user) return jsonResponse({ error: "invalid or expired token" }, 401);

  let signed: unknown;
  try {
    signed = ((await request.json()) as { signedTransaction?: unknown })?.signedTransaction;
  } catch {
    return jsonResponse({ error: "invalid JSON body" }, 400);
  }
  if (typeof signed !== "string" || !signed) {
    return jsonResponse({ error: "signedTransaction is required" }, 400);
  }

  let tx: AppleTransaction;
  try {
    tx = await verifyAppleJws<AppleTransaction>(signed);
  } catch (e) {
    if (e instanceof AppleJwsError) {
      console.warn(`[apple/verify] invalid JWS user=${user.id}: ${e.message}`);
      return jsonResponse({ error: "invalid_transaction" }, 400);
    }
    console.error(`[apple/verify] JWS verification error user=${user.id}`, e);
    return jsonResponse({ error: "verification failed" }, 500);
  }

  if (tx.bundleId !== appleBundleId(env) || tx.productId !== appleProductId(env)) {
    console.warn(`[apple/verify] unexpected bundle/product user=${user.id} bundle=${tx.bundleId} product=${tx.productId}`);
    return jsonResponse({ error: "unexpected_product" }, 400);
  }
  if (typeof tx.originalTransactionId !== "string" || !tx.originalTransactionId) {
    return jsonResponse({ error: "invalid_transaction" }, 400);
  }
  // アプリは購入時に Supabase の user id を appAccountToken に入れる。別人の購入の横取りを防ぐ。
  if (tx.appAccountToken && tx.appAccountToken.toLowerCase() !== user.id.toLowerCase()) {
    console.warn(`[apple/verify] appAccountToken mismatch user=${user.id} otid=${tx.originalTransactionId}`);
    return jsonResponse({ error: "app_account_token_mismatch" }, 403);
  }

  try {
    const applied = await applyAppleState(cfg, user.id, tx, undefined, { nowMs: Date.now() });
    switch (applied.kind) {
      case "conflict":
        console.warn(`[apple/verify] otid=${tx.originalTransactionId} belongs to another user (requested by ${user.id})`);
        return jsonResponse({ error: "transaction_owned_by_other_user" }, 409);
      case "user_missing":
        return jsonResponse({ error: "invalid or expired token" }, 401);
      case "no_state":
        // 期限切れの transaction しか無く、行も無い（失効済みの購入の復元など）
        return jsonResponse({ status: "inactive" });
    }
    const result = await provisionAppleSubscription(env, {
      originalTransactionId: tx.originalTransactionId,
      status: applied.status,
      waitlisted: applied.waitlisted,
      email: user.email ?? null,
      triggerId: `apple-verify:${tx.transactionId}`,
    });
    console.log(`[apple/verify] user=${user.id} otid=${tx.originalTransactionId} -> ${result.status}`);
    return jsonResponse(result);
  } catch (e) {
    console.error(`[apple/verify] failed user=${user.id} otid=${tx.originalTransactionId}`, e);
    return jsonResponse({ error: "temporary failure" }, 500);
  }
};

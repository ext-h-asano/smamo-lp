/**
 * POST /api/apple/notifications
 * App Store Server Notifications V2 の受け口（本番・Sandbox の両方をここに登録する）。
 *
 * 本文: { "signedPayload": "<JWS>" }
 * 応答: 200 = 処理済み or 無視, 400 = 署名不正, 500 = 一時的な障害（Apple が再送する）
 *
 * 冪等: 同じ通知が何度来ても同じ行の同じ状態になる。古い署名日時の情報は書かない。
 */
import { Env, jsonResponse } from "../../_lib/stripe";
import { AppleJwsError, verifyAppleJws } from "../../_lib/apple_jws";
import {
  type AppleRenewalInfo,
  type AppleTransaction,
  appleBundleId,
  appleProductId,
  applyAppleState,
  fetchAppleRow,
  provisionAppleSubscription,
} from "../../_lib/apple_subscription";

interface NotificationPayload {
  notificationType?: string;
  subtype?: string;
  notificationUUID?: string;
  data?: {
    bundleId?: string;
    environment?: string;
    signedTransactionInfo?: string;
    signedRenewalInfo?: string;
  };
}

/** 未割当なら払い出しを試みる通知 */
const PROVISION_TYPES = new Set(["SUBSCRIBED", "DID_RENEW"]);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ok = (handled: string) => jsonResponse({ ok: true, handled });

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  let signedPayload: unknown;
  try {
    signedPayload = ((await request.json()) as { signedPayload?: unknown })?.signedPayload;
  } catch {
    return jsonResponse({ error: "invalid JSON body" }, 400);
  }
  if (typeof signedPayload !== "string" || !signedPayload) {
    return jsonResponse({ error: "signedPayload is required" }, 400);
  }

  let payload: NotificationPayload;
  let tx: AppleTransaction | undefined;
  let renewal: AppleRenewalInfo | undefined;
  try {
    payload = await verifyAppleJws<NotificationPayload>(signedPayload);
    if (payload.data?.signedTransactionInfo) {
      tx = await verifyAppleJws<AppleTransaction>(payload.data.signedTransactionInfo);
    }
    if (payload.data?.signedRenewalInfo) {
      renewal = await verifyAppleJws<AppleRenewalInfo>(payload.data.signedRenewalInfo);
    }
  } catch (e) {
    if (e instanceof AppleJwsError) {
      console.warn(`[apple/notify] invalid signature: ${e.message}`);
      return jsonResponse({ error: "invalid signature" }, 400);
    }
    console.error("[apple/notify] verification error", e);
    return jsonResponse({ error: "verification failed" }, 500);
  }

  const type = payload.notificationType ?? "";
  const tag = `type=${type}/${payload.subtype ?? "-"} uuid=${payload.notificationUUID ?? "-"}`;

  if (payload.data?.bundleId && payload.data.bundleId !== appleBundleId(env)) {
    console.warn(`[apple/notify] other bundle ${payload.data.bundleId} ${tag}`);
    return ok("ignored_bundle");
  }
  if (!tx) {
    console.log(`[apple/notify] no transaction info ${tag}`);
    return ok("ignored_no_transaction");
  }
  if (tx.bundleId !== appleBundleId(env) || tx.productId !== appleProductId(env)) {
    console.warn(`[apple/notify] other product ${tx.bundleId}/${tx.productId} ${tag}`);
    return ok("ignored_product");
  }
  if (typeof tx.originalTransactionId !== "string" || !tx.originalTransactionId) {
    return ok("ignored_no_transaction");
  }

  const cfg = { url: env.SUPABASE_URL, serviceRoleKey: env.SUPABASE_SECRET_KEY };
  try {
    const existing = await fetchAppleRow(cfg, tx.originalTransactionId);
    // 行が無い = アプリの verify-purchase より先に通知が来た。appAccountToken（= Supabase user id）で作る。
    const token = tx.appAccountToken && UUID_RE.test(tx.appAccountToken) ? tx.appAccountToken.toLowerCase() : null;
    const userId = existing?.user_id ?? token;
    if (!userId) {
      console.log(`[apple/notify] unknown otid=${tx.originalTransactionId}, no appAccountToken; wait for verify ${tag}`);
      return ok("ignored_unknown_user");
    }

    const applied = await applyAppleState(cfg, userId, tx, renewal, { nowMs: Date.now(), notificationType: type });
    if (applied.kind === "conflict" || applied.kind === "user_missing" || applied.kind === "no_state") {
      console.warn(`[apple/notify] ${applied.kind} otid=${tx.originalTransactionId} user=${userId} ${tag}`);
      return ok(`ignored_${applied.kind}`);
    }
    console.log(
      `[apple/notify] ${applied.kind} otid=${tx.originalTransactionId} user=${userId} status=${applied.status} ${tag}`,
    );

    if (applied.kind === "written" && (applied.created || PROVISION_TYPES.has(type))) {
      const result = await provisionAppleSubscription(env, {
        originalTransactionId: tx.originalTransactionId,
        status: applied.status,
        waitlisted: applied.waitlisted,
        email: null,
        triggerId: `apple-notify:${payload.notificationUUID ?? tx.transactionId}`,
      });
      console.log(`[apple/notify] provision otid=${tx.originalTransactionId} -> ${result.status}`);
    }
    return ok(applied.kind);
  } catch (e) {
    console.error(`[apple/notify] failed otid=${tx.originalTransactionId} ${tag}`, e);
    return jsonResponse({ error: "temporary failure" }, 500);
  }
};

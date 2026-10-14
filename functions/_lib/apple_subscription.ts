/**
 * App Store の自動更新サブスクを stripe_subscriptions に相乗りさせて同期・払い出しする。
 * 設計: vpn_project_server/docs/ios_iap_design.md
 *
 * 行の形:
 *   stripe_subscription_id = 'apple:<originalTransactionId>'
 *   stripe_customer_id     = 'apple'
 *   provider               = 'apple'
 *   plan_key               = 'monthly'
 *
 * Apple の状態 → status:
 *   無料トライアル中                         → trialing
 *   課金中（自動更新オン/オフとも期限内）       → active（自動更新オフなら cancel_at = expiresDate）
 *   請求リトライ中 / 猶予期間                  → past_due
 *   EXPIRED / REFUND / REVOKE / 期限切れ       → canceled
 */
import type { Env } from "./stripe";
import {
  adminFetch,
  recomputeContractStatus,
  type StripeSubscriptionRow,
  type SupabaseAdminConfig,
} from "./supabase";
import { autoAssignContainerDetailed } from "./auto_provisioning";
import { APPLE_CUSTOMER_ID, appleSubscriptionId } from "./provider";

export const DEFAULT_APPLE_BUNDLE_ID = "cx.ext.smamo";
export const DEFAULT_APPLE_PRODUCT_ID = "cx.ext.smamo.monthly";
export const APPLE_PLAN_KEY = "monthly";

export function appleBundleId(env: Env): string {
  return env.APPLE_BUNDLE_ID || DEFAULT_APPLE_BUNDLE_ID;
}
export function appleProductId(env: Env): string {
  return env.APPLE_PRODUCT_ID || DEFAULT_APPLE_PRODUCT_ID;
}

/** JWSTransactionDecodedPayload のうち使う項目 */
export interface AppleTransaction {
  originalTransactionId: string;
  transactionId: string;
  bundleId: string;
  productId: string;
  purchaseDate?: number;
  expiresDate?: number;
  /** 1 = 導入オファー（無料トライアル） */
  offerType?: number;
  offerDiscountType?: string;
  appAccountToken?: string;
  environment?: string;
  revocationDate?: number;
  revocationReason?: number;
  signedDate?: number;
  type?: string;
}

/** JWSRenewalInfoDecodedPayload のうち使う項目 */
export interface AppleRenewalInfo {
  originalTransactionId?: string;
  /** 0 = 自動更新オフ, 1 = オン */
  autoRenewStatus?: number;
  isInBillingRetryPeriod?: boolean;
  gracePeriodExpiresDate?: number;
  expirationIntent?: number;
  signedDate?: number;
}

export interface AppleSubscriptionRow extends StripeSubscriptionRow {
  provider: "apple";
  apple_original_transaction_id: string;
  apple_environment: string | null;
}

/** 契約の生死。live のときだけ払い出す（recomputeContractStatus と同じ集合） */
export const APPLE_LIVE_STATUSES = new Set(["trialing", "active", "past_due"]);

const CANCEL_NOTIFICATION_TYPES = new Set(["EXPIRED", "REFUND", "REVOKE"]);

export interface AppleState {
  status: "trialing" | "active" | "past_due" | "canceled";
  trial_end: string | null;
  current_period_end: string | null;
  /** undefined = 判定材料（renewal info）が無いので既存値を触らない */
  cancel_at: string | null | undefined;
  canceled_at: string | null;
}

const iso = (ms: number | null | undefined): string | null =>
  typeof ms === "number" && Number.isFinite(ms) ? new Date(ms).toISOString() : null;

/**
 * Apple の transaction / renewal info から状態を出す。
 *
 * renewal が無い（アプリからの verify-purchase）かつ期限切れのときは null を返す。
 * 端末が渡す transaction だけでは「請求リトライ中」と「本当に失効」を区別できないため、
 * 既存の行を canceled に倒すと Go の解約ループがコンテナを消してしまう。失効は通知に任せる。
 */
export function deriveAppleState(
  tx: AppleTransaction,
  renewal: AppleRenewalInfo | undefined,
  nowMs: number,
  notificationType?: string,
): AppleState | null {
  const expires = tx.expiresDate ?? null;
  const base = { trial_end: null, current_period_end: iso(expires) };

  if (tx.revocationDate || (notificationType && CANCEL_NOTIFICATION_TYPES.has(notificationType))) {
    // canceled_at は通知の再送で動かないよう、取消日 → 期限 → 現在時刻 の順で決める
    const at = tx.revocationDate ?? (expires !== null && expires <= nowMs ? expires : nowMs);
    return { ...base, status: "canceled", cancel_at: null, canceled_at: iso(at) };
  }

  const inRetryOrGrace =
    renewal?.isInBillingRetryPeriod === true ||
    (typeof renewal?.gracePeriodExpiresDate === "number" && renewal.gracePeriodExpiresDate > nowMs);
  if (inRetryOrGrace) {
    return { ...base, status: "past_due", cancel_at: renewal ? null : undefined, canceled_at: null };
  }

  if (expires !== null && expires > nowMs) {
    const trial = tx.offerType === 1 && (tx.offerDiscountType === undefined || tx.offerDiscountType === "FREE_TRIAL");
    const cancelAt = renewal ? (renewal.autoRenewStatus === 0 ? iso(expires) : null) : undefined;
    return {
      status: trial ? "trialing" : "active",
      trial_end: trial ? iso(expires) : null,
      current_period_end: iso(expires),
      cancel_at: cancelAt,
      canceled_at: null,
    };
  }

  // 期限切れ
  if (!renewal && !notificationType) return null;
  return { ...base, status: "canceled", cancel_at: null, canceled_at: iso(expires ?? nowMs) };
}

function signedDateOf(tx: AppleTransaction, renewal?: AppleRenewalInfo): number {
  return Math.max(tx.signedDate ?? 0, renewal?.signedDate ?? 0);
}

export function buildAppleSubscriptionRow(
  userId: string,
  tx: AppleTransaction,
  renewal: AppleRenewalInfo | undefined,
  state: AppleState,
): AppleSubscriptionRow {
  return {
    user_id: userId,
    stripe_customer_id: APPLE_CUSTOMER_ID,
    stripe_subscription_id: appleSubscriptionId(tx.originalTransactionId),
    plan_key: APPLE_PLAN_KEY,
    with_sms: false,
    status: state.status,
    trial_end: state.trial_end,
    current_period_end: state.current_period_end,
    // undefined のキーは JSON に出ないので、PATCH では既存値が残る
    cancel_at: state.cancel_at as string | null,
    canceled_at: state.canceled_at,
    committed_until: null,
    cancellation_fee_amount: null,
    raw_metadata: {
      provider: "apple",
      supabase_user_id: userId,
      plan_key: APPLE_PLAN_KEY,
      product_id: tx.productId,
      transaction_id: tx.transactionId,
      apple_signed_date: signedDateOf(tx, renewal),
      ...(renewal?.autoRenewStatus !== undefined ? { auto_renew_status: renewal.autoRenewStatus } : {}),
      ...(renewal?.expirationIntent !== undefined ? { expiration_intent: renewal.expirationIntent } : {}),
    },
    provider: "apple",
    apple_original_transaction_id: tx.originalTransactionId,
    apple_environment: tx.environment ?? null,
  };
}

export interface ExistingAppleRow {
  user_id: string;
  status: string;
  waitlisted_at: string | null;
  raw_metadata: Record<string, unknown> | null;
}

export async function fetchAppleRow(
  cfg: SupabaseAdminConfig,
  originalTransactionId: string,
): Promise<ExistingAppleRow | null> {
  const subId = encodeURIComponent(appleSubscriptionId(originalTransactionId));
  const resp = await adminFetch<ExistingAppleRow[]>(
    cfg,
    `/rest/v1/stripe_subscriptions?stripe_subscription_id=eq.${subId}` +
      `&select=user_id,status,waitlisted_at,raw_metadata&limit=1`,
    { method: "GET" },
  );
  if (resp.status < 200 || resp.status >= 300 || !Array.isArray(resp.body)) {
    throw new Error(`stripe_subscriptions lookup failed (${resp.status})`);
  }
  return resp.body[0] ?? null;
}

export type ApplyResult =
  | { kind: "written" | "stale"; status: string; created: boolean; waitlisted: boolean }
  | { kind: "conflict" }
  | { kind: "user_missing" }
  | { kind: "no_state" };

function pgCode(body: unknown): string | undefined {
  return body && typeof body === "object" ? ((body as { code?: string }).code ?? undefined) : undefined;
}

/**
 * Apple の状態を stripe_subscriptions に書いて users.contract_status を再計算する。
 *
 * - 同じ originalTransactionId が別ユーザーの行なら conflict（Apple ID の使い回し防止）。
 *   既存行の user_id は絶対に上書きしない（PATCH は user_id で絞る、新規は INSERT のみ）。
 * - 既存行より古い署名日時の情報（順不同に届いた通知・端末に残っていた古い JWS）は書かない。
 * - 同時に 2 つ作ろうとした場合は UNIQUE 違反を拾い、読み直してからやり直す。
 */
export async function applyAppleState(
  cfg: SupabaseAdminConfig,
  userId: string,
  tx: AppleTransaction,
  renewal: AppleRenewalInfo | undefined,
  opts: { nowMs: number; notificationType?: string },
): Promise<ApplyResult> {
  const state = deriveAppleState(tx, renewal, opts.nowMs, opts.notificationType);
  const subId = appleSubscriptionId(tx.originalTransactionId);

  for (let attempt = 0; attempt < 2; attempt++) {
    const existing = await fetchAppleRow(cfg, tx.originalTransactionId);
    if (existing && existing.user_id !== userId) return { kind: "conflict" };

    if (!state) {
      if (!existing) return { kind: "no_state" };
      return { kind: "stale", status: existing.status, created: false, waitlisted: !!existing.waitlisted_at };
    }

    if (existing) {
      const prevSigned = Number(existing.raw_metadata?.apple_signed_date ?? 0);
      if (prevSigned > signedDateOf(tx, renewal)) {
        return { kind: "stale", status: existing.status, created: false, waitlisted: !!existing.waitlisted_at };
      }
      const row = buildAppleSubscriptionRow(userId, tx, renewal, state);
      const resp = await adminFetch<unknown>(
        cfg,
        `/rest/v1/stripe_subscriptions?stripe_subscription_id=eq.${encodeURIComponent(subId)}` +
          `&user_id=eq.${encodeURIComponent(userId)}`,
        { method: "PATCH", headers: { Prefer: "return=minimal" }, json: row },
      );
      if (resp.status < 200 || resp.status >= 300) {
        throw new Error(`stripe_subscriptions update failed (${resp.status}): ${JSON.stringify(resp.body)}`);
      }
      await recomputeContractStatus(cfg, userId);
      return { kind: "written", status: state.status, created: false, waitlisted: !!existing.waitlisted_at };
    }

    const row = buildAppleSubscriptionRow(userId, tx, renewal, state);
    const resp = await adminFetch<unknown>(cfg, "/rest/v1/stripe_subscriptions", {
      method: "POST",
      headers: { Prefer: "return=minimal" },
      json: row,
    });
    if (resp.status >= 200 && resp.status < 300) {
      await recomputeContractStatus(cfg, userId);
      return { kind: "written", status: state.status, created: true, waitlisted: false };
    }
    const code = pgCode(resp.body);
    if (code === "23503") return { kind: "user_missing" }; // FK: auth.users に居ない
    if (code === "23505") continue; // 同時に作られた → 読み直す
    throw new Error(`stripe_subscriptions insert failed (${resp.status}): ${JSON.stringify(resp.body)}`);
  }
  throw new Error(`stripe_subscriptions write did not converge sub=${subId}`);
}

export type AppleProvisionStatus = "ok" | "already" | "waitlisted" | "inactive";

/**
 * 有効な Apple 契約にコンテナを払い出す。auto_assign_pool_container は冪等。
 * 枯渇時は autoAssignContainerDetailed が mark_waitlisted と Discord 通知を行う（trial_end 凍結はしない）。
 * 既に順番待ちに入っている契約は、FIFO を崩さないよう RPC を呼ばずに waitlisted を返す。
 */
export async function provisionAppleSubscription(
  env: Env,
  args: {
    originalTransactionId: string;
    status: string;
    waitlisted: boolean;
    email: string | null;
    triggerId: string;
  },
): Promise<{ status: AppleProvisionStatus; containerId?: string }> {
  if (!APPLE_LIVE_STATUSES.has(args.status)) return { status: "inactive" };
  if (args.waitlisted) return { status: "waitlisted" };

  const subId = appleSubscriptionId(args.originalTransactionId);
  const out = await autoAssignContainerDetailed({
    env,
    stripe: null,
    subscriptionId: subId,
    customerEmail: args.email,
    planKey: APPLE_PLAN_KEY,
    deviceName: null,
    triggerId: args.triggerId,
  });
  switch (out.reason) {
    case "ok":
      return { status: "ok", ...(out.containerName ? { containerId: out.containerName } : {}) };
    case "already":
      return { status: "already", ...(out.containerName ? { containerId: out.containerName } : {}) };
    case "exhausted":
      return { status: "waitlisted" };
    case "not_found":
    default:
      // 直前に書いた行が見つからない or RPC 障害（critical 通知済み）。呼び出し側で 500 にする。
      throw new Error(`auto_assign_pool_container failed for ${subId}`);
  }
}


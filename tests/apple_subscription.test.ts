import { describe, it, expect, afterEach, vi } from "vitest";
import {
  type AppleTransaction,
  applyAppleState,
  buildAppleSubscriptionRow,
  deriveAppleState,
  provisionAppleSubscription,
} from "../functions/_lib/apple_subscription";
import { installFakeSupabase, rpcCalls } from "./helpers/fake_supabase";

const NOW = Date.parse("2026-10-14T00:00:00Z");
const DAY = 86400_000;
const USER = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const cfg = { url: "https://example.supabase.co", serviceRoleKey: "svc" };
const env = { SUPABASE_URL: cfg.url, SUPABASE_SECRET_KEY: cfg.serviceRoleKey } as never;

function tx(o: Partial<AppleTransaction> = {}): AppleTransaction {
  return {
    originalTransactionId: "2000000111",
    transactionId: "2000000999",
    bundleId: "cx.ext.smamo",
    productId: "cx.ext.smamo.monthly",
    purchaseDate: NOW - DAY,
    expiresDate: NOW + 2 * DAY,
    environment: "Sandbox",
    signedDate: NOW,
    ...o,
  };
}
const iso = (ms: number) => new Date(ms).toISOString();

afterEach(() => vi.unstubAllGlobals());

describe("deriveAppleState（Apple の状態 → status 対応表）", () => {
  it("無料トライアル中 → trialing, trial_end = expiresDate", () => {
    const s = deriveAppleState(tx({ offerType: 1, offerDiscountType: "FREE_TRIAL" }), { autoRenewStatus: 1 }, NOW);
    expect(s).toEqual({
      status: "trialing",
      trial_end: iso(NOW + 2 * DAY),
      current_period_end: iso(NOW + 2 * DAY),
      cancel_at: null,
      canceled_at: null,
    });
  });

  it("課金中・自動更新オン → active, cancel_at なし", () => {
    const s = deriveAppleState(tx(), { autoRenewStatus: 1 }, NOW)!;
    expect(s.status).toBe("active");
    expect(s.trial_end).toBeNull();
    expect(s.cancel_at).toBeNull();
  });

  it("課金中・自動更新オフ → active, cancel_at = expiresDate", () => {
    const s = deriveAppleState(tx(), { autoRenewStatus: 0 }, NOW)!;
    expect(s.status).toBe("active");
    expect(s.cancel_at).toBe(iso(NOW + 2 * DAY));
  });

  it("トライアル中に自動更新オフ → trialing のまま cancel_at = expiresDate", () => {
    const s = deriveAppleState(tx({ offerType: 1 }), { autoRenewStatus: 0 }, NOW)!;
    expect(s.status).toBe("trialing");
    expect(s.cancel_at).toBe(iso(NOW + 2 * DAY));
  });

  it("請求リトライ中 → past_due（期限が過ぎていても canceled にしない）", () => {
    const s = deriveAppleState(tx({ expiresDate: NOW - DAY }), { isInBillingRetryPeriod: true }, NOW, "DID_FAIL_TO_RENEW")!;
    expect(s.status).toBe("past_due");
    expect(s.canceled_at).toBeNull();
  });

  it("猶予期間中 → past_due", () => {
    const s = deriveAppleState(tx({ expiresDate: NOW - DAY }), { gracePeriodExpiresDate: NOW + DAY }, NOW)!;
    expect(s.status).toBe("past_due");
  });

  it.each(["EXPIRED", "REFUND", "REVOKE"])("%s 通知 → canceled", (type) => {
    const s = deriveAppleState(tx({ expiresDate: NOW - DAY }), { autoRenewStatus: 0 }, NOW, type)!;
    expect(s.status).toBe("canceled");
    expect(s.canceled_at).toBe(iso(NOW - DAY));
  });

  it("返金（revocationDate あり）→ 期限内でも canceled, canceled_at = revocationDate", () => {
    const s = deriveAppleState(tx({ revocationDate: NOW - 1000 }), undefined, NOW)!;
    expect(s.status).toBe("canceled");
    expect(s.canceled_at).toBe(iso(NOW - 1000));
  });

  it("renewal 付きで期限切れ → canceled", () => {
    expect(deriveAppleState(tx({ expiresDate: NOW - DAY }), { autoRenewStatus: 0 }, NOW)!.status).toBe("canceled");
  });

  it("端末の transaction だけで期限切れ → 判定しない（null）", () => {
    expect(deriveAppleState(tx({ expiresDate: NOW - DAY }), undefined, NOW)).toBeNull();
  });

  it("renewal が無いときは cancel_at を触らない（undefined）", () => {
    expect(deriveAppleState(tx(), undefined, NOW)!.cancel_at).toBeUndefined();
  });

  it("同じ通知の再送で canceled_at が動かない（冪等）", () => {
    const a = deriveAppleState(tx({ expiresDate: NOW - DAY }), {}, NOW, "EXPIRED");
    const b = deriveAppleState(tx({ expiresDate: NOW - DAY }), {}, NOW + 5 * DAY, "EXPIRED");
    expect(a).toEqual(b);
  });
});

describe("buildAppleSubscriptionRow", () => {
  it("stripe_subscriptions の Apple 行の形にする", () => {
    const t = tx();
    const row = buildAppleSubscriptionRow(USER, t, { autoRenewStatus: 1, signedDate: NOW + 5 }, deriveAppleState(t, { autoRenewStatus: 1 }, NOW)!);
    expect(row).toMatchObject({
      user_id: USER,
      stripe_customer_id: "apple",
      stripe_subscription_id: "apple:2000000111",
      plan_key: "monthly",
      with_sms: false,
      status: "active",
      provider: "apple",
      apple_original_transaction_id: "2000000111",
      apple_environment: "Sandbox",
      committed_until: null,
    });
    expect(row.raw_metadata).toMatchObject({ provider: "apple", supabase_user_id: USER, apple_signed_date: NOW + 5 });
  });
});

describe("applyAppleState", () => {
  it("行が無ければ INSERT して contract_status を再計算する", async () => {
    const db = installFakeSupabase();
    const r = await applyAppleState(cfg, USER, tx(), undefined, { nowMs: NOW });
    expect(r).toEqual({ kind: "written", status: "active", created: true, waitlisted: false });
    expect(db.rows).toHaveLength(1);
    expect(db.rows[0].stripe_subscription_id).toBe("apple:2000000111");
    expect(db.contractStatus[USER]).toBe("active");
  });

  it("別ユーザーの行なら conflict（上書きしない）", async () => {
    const db = installFakeSupabase({
      rows: [{ user_id: OTHER, stripe_subscription_id: "apple:2000000111", status: "active", raw_metadata: {} }],
    });
    const r = await applyAppleState(cfg, USER, tx(), undefined, { nowMs: NOW });
    expect(r).toEqual({ kind: "conflict" });
    expect(db.rows[0].user_id).toBe(OTHER);
    expect(db.calls.some((c) => c.method !== "GET")).toBe(false);
  });

  it("既存行は user_id で絞った PATCH で更新する", async () => {
    const db = installFakeSupabase({
      rows: [{ user_id: USER, stripe_subscription_id: "apple:2000000111", status: "trialing", raw_metadata: { apple_signed_date: NOW - 10 } }],
    });
    const r = await applyAppleState(cfg, USER, tx({ expiresDate: NOW - DAY }), { autoRenewStatus: 0 }, { nowMs: NOW, notificationType: "EXPIRED" });
    expect(r).toMatchObject({ kind: "written", status: "canceled", created: false });
    const patch = db.calls.find((c) => c.method === "PATCH" && c.url.includes("stripe_subscriptions"))!;
    expect(patch.url).toContain(`user_id=eq.${USER}`);
    expect(db.rows[0].status).toBe("canceled");
    expect(db.contractStatus[USER]).toBe("cancelled");
  });

  it("古い署名日時の情報は書かない（順不同の通知）", async () => {
    const db = installFakeSupabase({
      rows: [{ user_id: USER, stripe_subscription_id: "apple:2000000111", status: "canceled", raw_metadata: { apple_signed_date: NOW + 1000 } }],
    });
    const r = await applyAppleState(cfg, USER, tx(), { autoRenewStatus: 1, signedDate: NOW }, { nowMs: NOW, notificationType: "DID_RENEW" });
    expect(r).toMatchObject({ kind: "stale", status: "canceled" });
    expect(db.rows[0].status).toBe("canceled");
  });

  it("端末の期限切れ transaction では既存行を canceled にしない", async () => {
    const db = installFakeSupabase({
      rows: [{ user_id: USER, stripe_subscription_id: "apple:2000000111", status: "past_due", raw_metadata: {} }],
    });
    const r = await applyAppleState(cfg, USER, tx({ expiresDate: NOW - DAY }), undefined, { nowMs: NOW });
    expect(r).toMatchObject({ kind: "stale", status: "past_due" });
    expect(db.rows[0].status).toBe("past_due");
  });

  it("端末の期限切れ transaction で行も無ければ no_state", async () => {
    installFakeSupabase();
    expect(await applyAppleState(cfg, USER, tx({ expiresDate: NOW - DAY }), undefined, { nowMs: NOW })).toEqual({ kind: "no_state" });
  });

  it("同時作成の UNIQUE 違反では読み直し、別ユーザーなら conflict", async () => {
    installFakeSupabase({
      insertError: {
        status: 409,
        code: "23505",
        thenRow: { user_id: OTHER, stripe_subscription_id: "apple:2000000111", status: "active", raw_metadata: {} },
      },
    });
    expect(await applyAppleState(cfg, USER, tx(), undefined, { nowMs: NOW })).toEqual({ kind: "conflict" });
  });

  it("auth.users に居ない（FK 違反）なら user_missing", async () => {
    installFakeSupabase({ insertError: { status: 409, code: "23503" } });
    expect(await applyAppleState(cfg, USER, tx(), undefined, { nowMs: NOW })).toEqual({ kind: "user_missing" });
  });

  it("Supabase 障害は throw（呼び出し側で 500）", async () => {
    installFakeSupabase({ failLookup: true });
    await expect(applyAppleState(cfg, USER, tx(), undefined, { nowMs: NOW })).rejects.toThrow();
  });
});

describe("provisionAppleSubscription", () => {
  const base = { originalTransactionId: "2000000111", status: "active", waitlisted: false, email: "u@example.com", triggerId: "t" };

  it("割当できたら ok と containerId", async () => {
    installFakeSupabase({ assign: { reason: "ok", container_name: "abc123", remaining_pool: 9 } });
    expect(await provisionAppleSubscription(env, base)).toEqual({ status: "ok", containerId: "abc123" });
  });

  it("割当済みなら already と containerId", async () => {
    installFakeSupabase({ assign: { reason: "already", container_name: "abc123" } });
    expect(await provisionAppleSubscription(env, base)).toEqual({ status: "already", containerId: "abc123" });
  });

  it("枯渇なら mark_waitlisted して waitlisted（Stripe の trial_end 凍結はしない）", async () => {
    const db = installFakeSupabase({
      assign: { reason: "exhausted" },
      rows: [{ user_id: USER, stripe_subscription_id: "apple:2000000111", status: "active" }],
    });
    expect(await provisionAppleSubscription(env, base)).toEqual({ status: "waitlisted" });
    expect(rpcCalls(db, "mark_waitlisted")).toHaveLength(1);
    expect(db.stripeCalls).toEqual([]);
    expect(db.rows[0].waitlisted_at).toBeTruthy();
  });

  it("順番待ち中なら RPC を呼ばずに waitlisted（FIFO を崩さない）", async () => {
    const db = installFakeSupabase();
    expect(await provisionAppleSubscription(env, { ...base, waitlisted: true })).toEqual({ status: "waitlisted" });
    expect(rpcCalls(db, "auto_assign_pool_container")).toHaveLength(0);
  });

  it("canceled は払い出さない（inactive）", async () => {
    const db = installFakeSupabase();
    expect(await provisionAppleSubscription(env, { ...base, status: "canceled" })).toEqual({ status: "inactive" });
    expect(rpcCalls(db, "auto_assign_pool_container")).toHaveLength(0);
  });

  it("RPC 障害は throw", async () => {
    installFakeSupabase({ assign: "error" });
    await expect(provisionAppleSubscription(env, base)).rejects.toThrow();
  });
});

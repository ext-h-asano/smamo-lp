import { describe, it, expect, afterEach, vi } from "vitest";

// エンドポイントは本物の Apple ルートで検証する。テストでは自前の偽ルートを信頼させる。
vi.mock("../functions/_lib/apple_jws", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../functions/_lib/apple_jws")>();
  const { sharedFakeChain } = await import("./helpers/fake_apple_chain");
  return {
    ...orig,
    verifyAppleJws: async (jws: string, opts: Parameters<typeof orig.verifyAppleJws>[1] = {}) =>
      orig.verifyAppleJws(jws, { trustedRoots: [(await sharedFakeChain()).root.der], ...opts }),
  };
});

import { onRequestPost as verifyPurchase } from "../functions/api/apple/verify-purchase";
import { onRequestGet as availability } from "../functions/api/apple/availability";
import { onRequestPost as notifications } from "../functions/api/apple/notifications";
import { makeFakeChain, sharedFakeChain, signJws } from "./helpers/fake_apple_chain";
import { installFakeSupabase, rpcCalls } from "./helpers/fake_supabase";

const USER = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const DAY = 86400_000;
const env = { SUPABASE_URL: "https://example.supabase.co", SUPABASE_SECRET_KEY: "svc" } as never;

function txPayload(o: Record<string, unknown> = {}) {
  const now = Date.now();
  return {
    originalTransactionId: "2000000111",
    transactionId: "2000000999",
    bundleId: "cx.ext.smamo",
    productId: "cx.ext.smamo.monthly",
    purchaseDate: now - 1000,
    expiresDate: now + 3 * DAY,
    offerType: 1,
    offerDiscountType: "FREE_TRIAL",
    appAccountToken: USER,
    environment: "Sandbox",
    signedDate: now,
    type: "Auto-Renewable Subscription",
    ...o,
  };
}

async function signedTx(o: Record<string, unknown> = {}) {
  return signJws(await sharedFakeChain(), txPayload(o));
}

function call(handler: PagesFunction<never>, method: string, path: string, body?: unknown, token: string | null = "tok") {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  const request = new Request(`https://smamo.jp${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
  return handler({ request, env } as never);
}

afterEach(() => vi.unstubAllGlobals());

describe("POST /api/apple/verify-purchase", () => {
  const post = (body: unknown, token?: string | null) => call(verifyPurchase as never, "POST", "/api/apple/verify-purchase", body, token);

  it("トークンが無ければ 401", async () => {
    installFakeSupabase();
    expect((await post({ signedTransaction: "x" }, null)).status).toBe(401);
  });

  it("トークンが不正なら 401", async () => {
    installFakeSupabase({ user: null });
    expect((await post({ signedTransaction: await signedTx() })).status).toBe(401);
  });

  it("新規購入: 行を作って割り当て、ok と containerId を返す", async () => {
    const db = installFakeSupabase({ assign: { reason: "ok", container_name: "abc123", remaining_pool: 5 } });
    const res = await post({ signedTransaction: await signedTx() });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok", containerId: "abc123" });
    expect(db.rows[0]).toMatchObject({
      user_id: USER,
      stripe_subscription_id: "apple:2000000111",
      status: "trialing",
      provider: "apple",
    });
    expect(db.stripeCalls).toEqual([]);
  });

  it("2 回目（購入の復元）は already", async () => {
    installFakeSupabase({
      rows: [{ user_id: USER, stripe_subscription_id: "apple:2000000111", status: "trialing", raw_metadata: {} }],
      assign: { reason: "already", container_name: "abc123" },
    });
    expect(await (await post({ signedTransaction: await signedTx() })).json()).toEqual({ status: "already", containerId: "abc123" });
  });

  it("満席なら waitlisted（trial_end 凍結の Stripe 呼び出しなし）", async () => {
    const db = installFakeSupabase({ assign: { reason: "exhausted" } });
    expect(await (await post({ signedTransaction: await signedTx() })).json()).toEqual({ status: "waitlisted" });
    expect(rpcCalls(db, "mark_waitlisted")).toHaveLength(1);
    expect(db.stripeCalls).toEqual([]);
  });

  it("期限切れの購入しか無ければ inactive", async () => {
    installFakeSupabase();
    const res = await post({ signedTransaction: await signedTx({ expiresDate: Date.now() - DAY }) });
    expect(await res.json()).toEqual({ status: "inactive" });
  });

  it("署名が偽物なら 400", async () => {
    installFakeSupabase();
    const jws = await signJws(await makeFakeChain(), txPayload()); // 信頼されていない別ルート
    expect((await post({ signedTransaction: jws })).status).toBe(400);
    expect((await post({ signedTransaction: "not.a.jws" })).status).toBe(400);
    expect((await post({})).status).toBe(400);
    expect((await post("{broken")).status).toBe(400);
  });

  it("bundle や product が違えば 400", async () => {
    installFakeSupabase();
    expect((await post({ signedTransaction: await signedTx({ bundleId: "cx.ext.other" }) })).status).toBe(400);
    expect((await post({ signedTransaction: await signedTx({ productId: "cx.ext.smamo.yearly" }) })).status).toBe(400);
  });

  it("appAccountToken がログイン中のユーザーと違えば 403", async () => {
    const db = installFakeSupabase();
    expect((await post({ signedTransaction: await signedTx({ appAccountToken: OTHER }) })).status).toBe(403);
    expect(db.rows).toHaveLength(0);
  });

  it("appAccountToken が無い購入も受け付ける", async () => {
    installFakeSupabase();
    expect((await post({ signedTransaction: await signedTx({ appAccountToken: undefined }) })).status).toBe(200);
  });

  it("同じ Apple 契約が別ユーザーに紐付いていれば 409", async () => {
    const db = installFakeSupabase({
      rows: [{ user_id: OTHER, stripe_subscription_id: "apple:2000000111", status: "active", raw_metadata: {} }],
    });
    const res = await post({ signedTransaction: await signedTx({ appAccountToken: undefined }) });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "transaction_owned_by_other_user" });
    expect(db.rows[0].user_id).toBe(OTHER);
  });

  it("Supabase 障害は 500", async () => {
    installFakeSupabase({ failLookup: true });
    expect((await post({ signedTransaction: await signedTx() })).status).toBe(500);
  });
});

describe("GET /api/apple/availability", () => {
  const get = (token?: string | null) => call(availability as never, "GET", "/api/apple/availability", undefined, token);

  it("空きがあれば true", async () => {
    const db = installFakeSupabase({ poolCount: 2 });
    expect(await (await get()).json()).toEqual({ available: true });
    expect(rpcCalls(db, "pool_available_count")[0].body).toEqual({ p_plan_key: "monthly" });
  });

  it("空きが無ければ false", async () => {
    installFakeSupabase({ poolCount: 0 });
    expect(await (await get()).json()).toEqual({ available: false });
  });

  it("未認証は 401、RPC 障害は 500", async () => {
    installFakeSupabase({ user: null });
    expect((await get()).status).toBe(401);
    installFakeSupabase({ poolCount: "error" });
    expect((await get()).status).toBe(500);
  });
});

describe("POST /api/apple/notifications", () => {
  const post = (body: unknown) => call(notifications as never, "POST", "/api/apple/notifications", body, null);

  async function notification(type: string, txo: Record<string, unknown> = {}, renewal?: Record<string, unknown>, subtype?: string) {
    const chain = await sharedFakeChain();
    const now = Date.now();
    return {
      signedPayload: await signJws(chain, {
        notificationType: type,
        subtype,
        notificationUUID: `uuid-${type}`,
        signedDate: now,
        data: {
          bundleId: "cx.ext.smamo",
          environment: "Sandbox",
          signedTransactionInfo: await signJws(chain, txPayload(txo)),
          ...(renewal
            ? { signedRenewalInfo: await signJws(chain, { originalTransactionId: "2000000111", signedDate: now, ...renewal }) }
            : {}),
        },
      }),
    };
  }

  it("署名が不正なら 400", async () => {
    installFakeSupabase();
    const bad = { signedPayload: await signJws(await makeFakeChain(), { notificationType: "TEST" }) };
    expect((await post(bad)).status).toBe(400);
    expect((await post({})).status).toBe(400);
  });

  it("中の signedTransactionInfo が偽物でも 400", async () => {
    installFakeSupabase();
    const chain = await sharedFakeChain();
    const body = {
      signedPayload: await signJws(chain, {
        notificationType: "SUBSCRIBED",
        data: { bundleId: "cx.ext.smamo", signedTransactionInfo: await signJws(await makeFakeChain(), txPayload()) },
      }),
    };
    expect((await post(body)).status).toBe(400);
  });

  it("TEST 通知は 200 で無視", async () => {
    installFakeSupabase();
    const body = { signedPayload: await signJws(await sharedFakeChain(), { notificationType: "TEST", data: { bundleId: "cx.ext.smamo" } }) };
    expect((await post(body)).status).toBe(200);
  });

  it("SUBSCRIBED: verify より先に来たら appAccountToken のユーザーで作って払い出す", async () => {
    const db = installFakeSupabase({ assign: { reason: "ok", container_name: "abc123" } });
    const res = await post(await notification("SUBSCRIBED", {}, { autoRenewStatus: 1 }, "INITIAL_BUY"));
    expect(res.status).toBe(200);
    expect(db.rows[0]).toMatchObject({ user_id: USER, status: "trialing" });
    expect(rpcCalls(db, "auto_assign_pool_container")).toHaveLength(1);
  });

  it("行も appAccountToken も無ければ 200 で無視（後で verify が来る）", async () => {
    const db = installFakeSupabase();
    const res = await post(await notification("SUBSCRIBED", { appAccountToken: undefined }, { autoRenewStatus: 1 }));
    expect(res.status).toBe(200);
    expect(db.rows).toHaveLength(0);
  });

  it("DID_CHANGE_RENEWAL_STATUS（自動更新オフ）→ cancel_at を入れる。払い出しは呼ばない", async () => {
    const db = installFakeSupabase({
      rows: [{ user_id: USER, stripe_subscription_id: "apple:2000000111", status: "trialing", raw_metadata: {} }],
    });
    const res = await post(await notification("DID_CHANGE_RENEWAL_STATUS", {}, { autoRenewStatus: 0 }, "AUTO_RENEW_DISABLED"));
    expect(res.status).toBe(200);
    expect(db.rows[0].cancel_at).toBeTruthy();
    expect(rpcCalls(db, "auto_assign_pool_container")).toHaveLength(0);
  });

  it("EXPIRED → canceled（同じ通知の再送でも同じ結果）", async () => {
    const db = installFakeSupabase({
      rows: [{ user_id: USER, stripe_subscription_id: "apple:2000000111", status: "active", raw_metadata: {} }],
    });
    const body = await notification("EXPIRED", { expiresDate: Date.now() - DAY, offerType: undefined }, { autoRenewStatus: 0 }, "VOLUNTARY");
    expect((await post(body)).status).toBe(200);
    const first = { ...db.rows[0] };
    expect(first.status).toBe("canceled");
    expect((await post(body)).status).toBe(200);
    expect(db.rows[0]).toEqual(first);
    expect(db.contractStatus[USER]).toBe("cancelled");
  });

  it("REFUND → 期限内でも canceled", async () => {
    const db = installFakeSupabase({
      rows: [{ user_id: USER, stripe_subscription_id: "apple:2000000111", status: "active", raw_metadata: {} }],
    });
    await post(await notification("REFUND", { offerType: undefined, revocationDate: Date.now() - 1000, revocationReason: 0 }));
    expect(db.rows[0].status).toBe("canceled");
  });

  it("DID_RENEW → active にして、未割当なら払い出す", async () => {
    const db = installFakeSupabase({
      rows: [{ user_id: USER, stripe_subscription_id: "apple:2000000111", status: "trialing", raw_metadata: {} }],
      assign: { reason: "already", container_name: "abc123" },
    });
    await post(await notification("DID_RENEW", { offerType: undefined, offerDiscountType: undefined }, { autoRenewStatus: 1 }));
    expect(db.rows[0].status).toBe("active");
    expect(db.rows[0].trial_end).toBeNull();
    expect(rpcCalls(db, "auto_assign_pool_container")).toHaveLength(1);
  });

  it("他アプリの bundle は 200 で無視", async () => {
    const db = installFakeSupabase();
    await post(await notification("SUBSCRIBED", { bundleId: "cx.ext.other" }, { autoRenewStatus: 1 }));
    expect(db.rows).toHaveLength(0);
  });

  it("Supabase 障害は 500（Apple に再送させる）", async () => {
    installFakeSupabase({ failLookup: true });
    expect((await post(await notification("DID_RENEW", {}, { autoRenewStatus: 1 }))).status).toBe(500);
  });
});

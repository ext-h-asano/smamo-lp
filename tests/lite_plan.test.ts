import { describe, it, expect, vi, afterEach } from "vitest";
import { onRequestPost } from "../functions/api/checkout";
import { handleStripeEvent } from "../functions/api/stripe/webhook";
import { makeStripe } from "../functions/_lib/stripe";
import { calculateCancellationFee } from "../functions/_lib/cancellation_fee";
import { firstChargeAmountJpy } from "../functions/_lib/initial_fee";
import { PLAN_DISPLAY_NAME } from "../functions/_lib/plans";

// スマモ ライト（plan_key='lite'・通話なし・¥2,480/月）。実機フォンファームに割り当たる。
// 割当先の振り分けは DB の plan_device_status() が担い、ここでは申込・解約の LP 側の契約を固定する。

const baseEnv = {
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_SECRET_KEY: "svc-key",
  STRIPE_SECRET_KEY: "stripe-key-not-used",
  STRIPE_WEBHOOK_SECRET: "whsec_dummy",
  STRIPE_PRICE_MONTHLY: "price_monthly",
  STRIPE_PRICE_YEARLY: "price_yearly",
  STRIPE_PRICE_TWO_YEAR: "price_two_year",
};

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function stubCheckoutFetch() {
  const calls: { url: string; method: string; body: string }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      calls.push({ url, method, body: String(init?.body ?? "") });
      if (url.includes("/auth/v1/admin/users")) return jsonRes({ id: "user_1", email: "new@example.com" });
      if (url.includes("api.stripe.com/v1/setup_intents/")) return jsonRes({ id: "seti_1" });
      if (url.includes("api.stripe.com/v1/customers")) {
        if (method === "POST") return jsonRes({ id: "cus_1", object: "customer", email: "new@example.com" });
        return jsonRes({ object: "list", data: [] });
      }
      if (url.includes("api.stripe.com/v1/subscriptions")) {
        return jsonRes({
          id: "sub_1",
          object: "subscription",
          pending_setup_intent: { id: "seti_1", object: "setup_intent", client_secret: "seti_1_secret_x" },
        });
      }
      if (url.includes("api.stripe.com/v1/invoiceitems")) return jsonRes({ id: "ii_1" });
      throw new Error(`unexpected call: ${method} ${url}`);
    }),
  );
  return calls;
}

function checkoutCtx(env: Record<string, unknown>, body: Record<string, unknown> = {}) {
  return {
    request: new Request("https://smamo.jp/api/checkout", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        plan: "lite",
        email: "new@example.com",
        name: "テスト",
        password: "password123",
        terms_accepted: true,
        ...body,
      }),
    }),
    env,
  } as never;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("POST /api/checkout — ライトプラン", () => {
  it("STRIPE_PRICE_LITE の price で契約を作り、plan_key=lite と初期費用を付ける", async () => {
    const calls = stubCheckoutFetch();
    const res = await onRequestPost(checkoutCtx({ ...baseEnv, STRIPE_PRICE_LITE: "price_lite" }));
    expect(res.status).toBe(200);

    const subCall = calls.find((c) => c.url.includes("api.stripe.com/v1/subscriptions") && c.method === "POST");
    expect(subCall!.body).toContain("price_lite");
    expect(subCall!.body).not.toContain("price_monthly");
    expect(decodeURIComponent(subCall!.body)).toContain("metadata[plan_key]=lite");
    // 2年契約ではないので拘束期間のメタデータは付かない
    expect(subCall!.body).not.toContain("committed_until");

    const feeCall = calls.find((c) => c.url.includes("api.stripe.com/v1/invoiceitems"));
    expect(feeCall!.body).toContain("amount=33000");
  });

  it("STRIPE_PRICE_LITE が無い環境では、ユーザーも Stripe も作らずに断る", async () => {
    const calls = stubCheckoutFetch();
    const res = await onRequestPost(checkoutCtx(baseEnv));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe("plan_unavailable");
    expect(calls).toEqual([]);
  });

  it("未知のプランは従来どおり invalid plan", async () => {
    stubCheckoutFetch();
    const res = await onRequestPost(checkoutCtx({ ...baseEnv, STRIPE_PRICE_LITE: "price_lite" }, { plan: "phone" }));
    expect(res.status).toBe(400);
  });
});

describe("ライトプランの金額・表示", () => {
  it("初回請求額は ¥2,480 + 初期費用 ¥33,000", () => {
    expect(firstChargeAmountJpy("lite", false, false)).toBe(35480);
    expect(firstChargeAmountJpy("lite", false, true)).toBe(2480);
  });

  it("表示名で通話なしと分かる", () => {
    expect(PLAN_DISPLAY_NAME.lite).toContain("通話なし");
  });

  it("中途解約手数料は掛からない", () => {
    const fee = calculateCancellationFee({
      planKey: "lite",
      committedUntilIso: "2099-01-01T00:00:00Z",
      unitAmounts: [2480],
      nowMs: Date.now(),
    });
    expect(fee.amount).toBe(0);
  });
});

describe("customer.subscription.deleted — 実機の返却通知", () => {
  const DISCORD_URL = "https://discord.example/webhook-not-real";

  function stubWebhookFetch(planKey: string) {
    const discordBodies: string[] = [];
    const sub = {
      id: "sub_DEL",
      object: "subscription",
      customer: "cus_TEST",
      status: "canceled",
      trial_end: null,
      cancel_at: null,
      canceled_at: 1_800_000_000,
      cancel_at_period_end: false,
      items: { data: [{ price: { unit_amount: 2480 }, current_period_end: 1_800_000_000 }] },
      metadata: { supabase_user_id: "user_1", plan_key: planKey },
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        if (url.includes("api.stripe.com/v1/subscriptions/")) return jsonRes(sub);
        if (url.includes("/rest/v1/stripe_subscriptions") && method === "POST") return jsonRes({}, 201);
        if (url.includes("/rest/v1/stripe_subscriptions") && method === "GET") return jsonRes([{ status: "canceled" }]);
        if (url.includes("/rest/v1/users") && method === "PATCH") return jsonRes({});
        if (url.startsWith(DISCORD_URL)) {
          discordBodies.push(String(init?.body ?? ""));
          return jsonRes({});
        }
        throw new Error(`unexpected call: ${method} ${url}`);
      }),
    );
    return { sub, discordBodies };
  }

  it("ライトの解約では「実機が返却された・要初期化」を通知する", async () => {
    const { sub, discordBodies } = stubWebhookFetch("lite");
    const stripe = makeStripe("stripe-key-not-used"); // stub の後に構築すること
    await handleStripeEvent(stripe, { ...baseEnv, DISCORD_WEBHOOK_URL: DISCORD_URL } as never, {
      id: "evt_del",
      type: "customer.subscription.deleted",
      data: { object: sub },
    } as never);
    expect(discordBodies.some((b) => b.includes("実機が返却されました"))).toBe(true);
  });

  it("通常プランの解約では通知しない", async () => {
    const { sub, discordBodies } = stubWebhookFetch("monthly");
    const stripe = makeStripe("stripe-key-not-used");
    await handleStripeEvent(stripe, { ...baseEnv, DISCORD_WEBHOOK_URL: DISCORD_URL } as never, {
      id: "evt_del2",
      type: "customer.subscription.deleted",
      data: { object: sub },
    } as never);
    expect(discordBodies).toEqual([]);
  });
});

import { describe, it, expect, vi, afterEach } from "vitest";
import { handleStripeEvent } from "../functions/api/stripe/webhook";
import { makeStripe } from "../functions/_lib/stripe";

const env = {
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_SECRET_KEY: "svc-key",
  STRIPE_SECRET_KEY: "stripe-key-not-used",
  STRIPE_WEBHOOK_SECRET: "whsec_dummy",
  // Resend / Discord は未設定にして送信経路を no-op にする
} as never;

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const SUB = {
  id: "sub_TEST",
  object: "subscription",
  customer: "cus_TEST",
  status: "trialing",
  default_payment_method: null,
  trial_end: 1_800_000_000,
  cancel_at: null,
  canceled_at: null,
  cancel_at_period_end: false,
  items: { data: [{ price: { unit_amount: 3828 }, current_period_end: 1_800_000_000 }] },
  metadata: { supabase_user_id: "user_1", plan_key: "monthly", with_sms: "false" },
};

/** 叩かれた URL を記録しつつ、経路ごとに最小限の応答を返す */
function stubFetch(overrides: Record<string, unknown> = {}) {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown) => {
      const url = String(input);
      calls.push(url);
      if (url.includes("/rpc/auto_assign_pool_container")) {
        return jsonRes([
          {
            reason: "ok",
            container_name: "container-1",
            scrcpy_port: 1,
            remaining_pool: 10,
            user_id_assigned: "user_1",
          },
        ]);
      }
      if (url.includes("/v1/subscriptions/")) return jsonRes({ ...SUB, ...overrides });
      if (url.includes("/v1/subscriptions")) return jsonRes({ object: "list", data: [{ ...SUB, ...overrides }] });
      if (url.includes("/v1/customers/")) return jsonRes({ id: "cus_TEST", email: "t@example.com" });
      // Supabase の upsert (POST) / recomputeContractStatus の一覧 (GET) / users PATCH。
      // recomputeContractStatus は status 列の配列を読むので、その形で返しておく。
      return jsonRes([{ status: "trialing" }]);
    }),
  );
  return calls;
}

// makeStripe() は Stripe.createFetchHttpClient() 内で構築時点の globalThis.fetch を
// 束縛するため、必ず vi.stubGlobal の後に呼ぶこと。モジュールスコープで作ると
// スタブされないまま実際の api.stripe.com に到達してしまう。
const assigned = (calls: string[]) =>
  calls.some((u) => u.includes("/rpc/auto_assign_pool_container"));

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("handleStripeEvent — 割当はカード確定後のみ", () => {
  it("customer.subscription.created では割当しない (カード入力前に発火するため)", async () => {
    const calls = stubFetch();
    const stripe = makeStripe("stripe-key-not-used");
    await handleStripeEvent(stripe, env, {
      id: "evt_1",
      type: "customer.subscription.created",
      data: { object: SUB },
    } as never);
    expect(assigned(calls)).toBe(false);
  });

  it("setup_intent.succeeded では割当する", async () => {
    const calls = stubFetch();
    const stripe = makeStripe("stripe-key-not-used");
    await handleStripeEvent(stripe, env, {
      id: "evt_2",
      type: "setup_intent.succeeded",
      data: {
        object: {
          id: "seti_1",
          customer: "cus_TEST",
          metadata: { subscription_id: "sub_TEST" },
        },
      },
    } as never);
    expect(assigned(calls)).toBe(true);
  });

  it("customer.subscription.updated は支払い方法の遷移があるときだけ割当する", async () => {
    const withTransition = stubFetch({ default_payment_method: "pm_1" });
    const stripe = makeStripe("stripe-key-not-used");
    await handleStripeEvent(stripe, env, {
      id: "evt_3",
      type: "customer.subscription.updated",
      data: {
        object: { ...SUB, default_payment_method: "pm_1" },
        previous_attributes: { default_payment_method: null },
      },
    } as never);
    expect(assigned(withTransition)).toBe(true);

    vi.unstubAllGlobals();
    const withoutTransition = stubFetch();
    const stripe2 = makeStripe("stripe-key-not-used");
    await handleStripeEvent(stripe2, env, {
      id: "evt_4",
      type: "customer.subscription.updated",
      data: { object: SUB, previous_attributes: { status: "trialing" } },
    } as never);
    expect(assigned(withoutTransition)).toBe(false);
  });
});

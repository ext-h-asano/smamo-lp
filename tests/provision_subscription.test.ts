import { describe, it, expect, vi, afterEach } from "vitest";
import { makeStripe } from "../functions/_lib/stripe";
import { provisionSubscription } from "../functions/_lib/auto_provisioning";

const env = {
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_SECRET_KEY: "svc-key",
  STRIPE_SECRET_KEY: "sk_test_not_used",
  STRIPE_PRICE_MONTHLY: "price_monthly",
  STRIPE_PRICE_YEARLY: "price_yearly",
  STRIPE_PRICE_TWO_YEAR: "price_two_year",
  STRIPE_PRODUCT_INITIAL_FEE: "prod_initial_fee",
  DRAIN_SECRET: "drain-secret",
  // RESEND_API_KEY / DISCORD_WEBHOOK_URL は各テストで必要な時だけ足す。
  // 未設定なら email.ts / discord.ts が warn ログのみで fetch せず no-op する。
} as never;

function jsonRes(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function makeSub(overrides: Record<string, unknown> = {}) {
  return {
    id: "sub_123",
    object: "subscription",
    customer: "cus_123",
    status: "trialing",
    trial_end: Math.floor(Date.now() / 1000) + 3 * 86400,
    cancel_at: null,
    canceled_at: null,
    items: { data: [] },
    metadata: {
      plan_key: "monthly",
      device_name: "iPhone",
      supabase_user_id: "user-abc",
    },
    ...overrides,
  } as never;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("provisionSubscription", () => {
  it("not_found → 自己修復 (syncSubscription) → 再試行で ok になる", async () => {
    const sub = makeSub();
    const calls: { url: string; method: string }[] = [];
    let rpcCallCount = 0;

    // makeStripe() は Stripe.createFetchHttpClient() 内で構築時点の globalThis.fetch を
    // 束縛するため、必ず vi.stubGlobal の後に makeStripe を呼ぶこと。順序を間違えると
    // スタブされないまま実際の api.stripe.com に到達してしまう。
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        calls.push({ url, method });

        // Stripe: customer lookup (email) — provisionSubscription 冒頭
        if (url.includes("api.stripe.com/v1/customers/")) {
          return jsonRes(200, { id: "cus_123", object: "customer", email: "a@example.com", deleted: false });
        }
        // Stripe: subscription retrieve (syncSubscription 内)
        if (url.includes("api.stripe.com/v1/subscriptions/")) {
          return jsonRes(200, sub);
        }
        // Supabase RPC: auto_assign_pool_container — 1回目 not_found, 2回目 ok
        if (url.includes("/rest/v1/rpc/auto_assign_pool_container")) {
          rpcCallCount += 1;
          if (rpcCallCount === 1) {
            return jsonRes(200, [
              { reason: "not_found", container_name: null, scrcpy_port: null, remaining_pool: null, user_id_assigned: null },
            ]);
          }
          return jsonRes(200, [
            { reason: "ok", container_name: "c1", scrcpy_port: 5555, remaining_pool: 10, user_id_assigned: "user-abc" },
          ]);
        }
        // Supabase: stripe_subscriptions upsert (syncSubscription 内)
        if (url.includes("/rest/v1/stripe_subscriptions") && method === "POST") {
          return jsonRes(201, {});
        }
        // Supabase: recomputeContractStatus の GET
        if (url.includes("/rest/v1/stripe_subscriptions") && method === "GET") {
          return jsonRes(200, [{ status: "trialing" }]);
        }
        // Supabase: updateUserContractStatus の PATCH
        if (url.includes("/rest/v1/users") && method === "PATCH") {
          return jsonRes(200, {});
        }
        throw new Error(`unexpected call: ${method} ${url}`);
      }),
    );
    const stripe = makeStripe(env.STRIPE_SECRET_KEY);

    const reason = await provisionSubscription(stripe, env, sub, "evt_1", { emailOnAlready: false });

    expect(reason).toBe("ok");
    expect(rpcCallCount).toBe(2);

    // RPC が2回呼ばれ、その間に stripe_subscriptions への upsert (POST) が挟まっていること
    const rpcIndexes = calls
      .map((c, i) => ({ ...c, i }))
      .filter((c) => c.url.includes("/rest/v1/rpc/auto_assign_pool_container"))
      .map((c) => c.i);
    expect(rpcIndexes.length).toBe(2);
    const upsertIndex = calls.findIndex(
      (c) => c.url.includes("/rest/v1/stripe_subscriptions") && c.method === "POST" && !c.url.includes("rpc"),
    );
    expect(upsertIndex).toBeGreaterThan(rpcIndexes[0]);
    expect(upsertIndex).toBeLessThan(rpcIndexes[1]);
  });

  it("already + emailOnAlready:false ではメールを送らない", async () => {
    const testEnv = { ...env, RESEND_API_KEY: "resend-key" } as never;
    const sub = makeSub();
    const calls: { url: string; method: string }[] = [];

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        calls.push({ url, method });

        if (url.includes("api.stripe.com/v1/customers/")) {
          return jsonRes(200, { id: "cus_123", object: "customer", email: "a@example.com", deleted: false });
        }
        if (url.includes("/rest/v1/rpc/auto_assign_pool_container")) {
          return jsonRes(200, [
            { reason: "already", container_name: "c1", scrcpy_port: 5555, remaining_pool: 10, user_id_assigned: "user-abc" },
          ]);
        }
        if (url.includes("api.resend.com/emails")) {
          return jsonRes(200, { id: "email_1" });
        }
        throw new Error(`unexpected call: ${method} ${url}`);
      }),
    );
    const stripe = makeStripe(env.STRIPE_SECRET_KEY);

    const reason = await provisionSubscription(stripe, testEnv, sub, "evt_2", { emailOnAlready: false });

    expect(reason).toBe("already");
    expect(calls.some((c) => c.url.includes("api.resend.com"))).toBe(false);
  });

  it("already + emailOnAlready:true ではメールを送る (上記の対比・回帰テスト)", async () => {
    const testEnv = { ...env, RESEND_API_KEY: "resend-key" } as never;
    const sub = makeSub();
    const calls: { url: string; method: string }[] = [];

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        calls.push({ url, method });

        if (url.includes("api.stripe.com/v1/customers/")) {
          return jsonRes(200, { id: "cus_123", object: "customer", email: "a@example.com", deleted: false });
        }
        if (url.includes("/rest/v1/rpc/auto_assign_pool_container")) {
          return jsonRes(200, [
            { reason: "already", container_name: "c1", scrcpy_port: 5555, remaining_pool: 10, user_id_assigned: "user-abc" },
          ]);
        }
        if (url.includes("api.resend.com/emails")) {
          return jsonRes(200, { id: "email_1" });
        }
        throw new Error(`unexpected call: ${method} ${url}`);
      }),
    );
    const stripe = makeStripe(env.STRIPE_SECRET_KEY);

    const reason = await provisionSubscription(stripe, testEnv, sub, "evt_3", { emailOnAlready: true });

    expect(reason).toBe("already");
    expect(calls.some((c) => c.url.includes("api.resend.com"))).toBe(true);
  });
});

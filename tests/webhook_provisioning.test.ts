import { describe, it, expect, vi, afterEach } from "vitest";
import { handleStripeEvent } from "../functions/api/stripe/webhook";
import { makeStripe } from "../functions/_lib/stripe";

const DISCORD_URL = "https://discord.example/webhook-not-real";

const env = {
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_SECRET_KEY: "svc-key",
  STRIPE_SECRET_KEY: "stripe-key-not-used",
  STRIPE_WEBHOOK_SECRET: "whsec_dummy",
  // Resend / Discord は未設定にして送信経路を no-op にする。
  // 観測したいテストだけ個別に足す。
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

interface StubOpts {
  /** stripe.subscriptions.list が返す一覧 (既定: SUB 1件) */
  subs?: unknown[];
  /** auto_assign_pool_container RPC が返す reason (既定: ok) */
  rpcReason?: "ok" | "already";
}

/** 叩かれた URL を記録しつつ、経路ごとに最小限の応答を返す */
function stubFetch(opts: StubOpts = {}) {
  const calls: string[] = [];
  const subs = opts.subs ?? [SUB];
  const rpcReason = opts.rpcReason ?? "ok";
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      calls.push(url);

      if (url.includes("/rest/v1/rpc/auto_assign_pool_container")) {
        return jsonRes([
          {
            reason: rpcReason,
            container_name: "container-1",
            scrcpy_port: 1,
            remaining_pool: 10,
            user_id_assigned: "user_1",
          },
        ]);
      }
      // Stripe: subscription retrieve (syncSubscription 内)
      if (url.includes("api.stripe.com/v1/subscriptions/")) return jsonRes(SUB);
      // Stripe: subscription list (setup_intent.succeeded 経路)
      if (url.includes("api.stripe.com/v1/subscriptions")) {
        return jsonRes({ object: "list", data: subs });
      }
      // Stripe: customer retrieve (メールアドレス取得)
      if (url.includes("api.stripe.com/v1/customers/")) {
        return jsonRes({ id: "cus_TEST", object: "customer", email: "t@example.com", deleted: false });
      }
      // Supabase: stripe_subscriptions upsert (syncSubscription 内)
      if (url.includes("/rest/v1/stripe_subscriptions") && method === "POST") {
        return jsonRes({}, 201);
      }
      // Supabase: recomputeContractStatus の GET (status 列の配列を読む)
      if (url.includes("/rest/v1/stripe_subscriptions") && method === "GET") {
        return jsonRes([{ status: "trialing" }]);
      }
      // Supabase: users.contract_status の PATCH
      if (url.includes("/rest/v1/users") && method === "PATCH") return jsonRes({});
      if (url.startsWith(DISCORD_URL)) return jsonRes({});
      if (url.includes("api.resend.com/emails")) return jsonRes({ id: "email_1" });

      throw new Error(`unexpected call: ${method} ${url}`);
    }),
  );
  return calls;
}

const assigned = (calls: string[]) =>
  calls.some((u) => u.includes("/rest/v1/rpc/auto_assign_pool_container"));
const notifiedDiscord = (calls: string[]) => calls.some((u) => u.startsWith(DISCORD_URL));
const mailed = (calls: string[]) => calls.some((u) => u.includes("api.resend.com"));

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("handleStripeEvent — 割当はカード確定後のみ", () => {
  it("customer.subscription.created では割当しない (カード入力前に発火するため)", async () => {
    const calls = stubFetch();
    // makeStripe() は Stripe.createFetchHttpClient() 内で構築時点の globalThis.fetch を
    // 束縛するため、必ず vi.stubGlobal (= stubFetch) の後に呼ぶこと。順序を間違えると
    // スタブされないまま実際の api.stripe.com に到達してしまう。
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
    const stripe = makeStripe("stripe-key-not-used"); // stubFetch の後に構築すること
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
    const withTransition = stubFetch();
    const stripe = makeStripe("stripe-key-not-used"); // stubFetch の後に構築すること
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
    // fetch を張り直したので Stripe クライアントも作り直す (旧 fetch を掴んだままになる)
    const stripe2 = makeStripe("stripe-key-not-used");
    await handleStripeEvent(stripe2, env, {
      id: "evt_4",
      type: "customer.subscription.updated",
      data: { object: SUB, previous_attributes: { status: "trialing" } },
    } as never);
    expect(assigned(withoutTransition)).toBe(false);
  });
});

describe("handleStripeEvent — setup_intent.succeeded の契約特定", () => {
  const envWithDiscord = { ...env, DISCORD_WEBHOOK_URL: DISCORD_URL } as never;

  it("metadata が指す契約が一覧に無いとき critical が鳴り、割当はしない", async () => {
    // こちらで紐付けたはずの契約を見失った = 本当の異常。人間が調べる必要がある。
    const calls = stubFetch({ subs: [{ ...SUB, id: "sub_OTHER" }] });
    const stripe = makeStripe("stripe-key-not-used"); // stubFetch の後に構築すること
    await handleStripeEvent(stripe, envWithDiscord, {
      id: "evt_5",
      type: "setup_intent.succeeded",
      data: {
        object: {
          id: "seti_lost",
          customer: "cus_TEST",
          metadata: { subscription_id: "sub_TEST" },
        },
      },
    } as never);

    expect(notifiedDiscord(calls)).toBe(true);
    expect(assigned(calls)).toBe(false);
  });

  it("metadata が無く候補も無いときは critical を鳴らさない (ポータルでのカード登録)", async () => {
    // 非解約サブスクが 0 件の顧客がポータルでカードを登録しただけ。割当先が存在しない
    // だけで異常ではないので、オンコールを起こしてはいけない。
    const calls = stubFetch({ subs: [] });
    const stripe = makeStripe("stripe-key-not-used"); // stubFetch の後に構築すること
    await handleStripeEvent(stripe, envWithDiscord, {
      id: "evt_6",
      type: "setup_intent.succeeded",
      data: { object: { id: "seti_portal", customer: "cus_TEST", metadata: {} } },
    } as never);

    expect(notifiedDiscord(calls)).toBe(false);
    expect(assigned(calls)).toBe(false);
  });

  it("si.customer が無いときは何もしない", async () => {
    const calls = stubFetch();
    const stripe = makeStripe("stripe-key-not-used"); // stubFetch の後に構築すること
    await handleStripeEvent(stripe, envWithDiscord, {
      id: "evt_7",
      type: "setup_intent.succeeded",
      data: { object: { id: "seti_nocus", customer: null, metadata: {} } },
    } as never);

    expect(calls).toEqual([]);
  });
});

describe("handleStripeEvent — already での Welcome メール抑止", () => {
  // カスタマーポータルでのカード更新でも metadata 無しの setup_intent.succeeded が飛ぶ。
  // 推測で契約を拾った場合は「新規申込」か「カード更新」か区別できないので、
  // 既に割当済み (already) の契約へ Welcome メールを送ってはならない。
  const envWithResend = { ...env, RESEND_API_KEY: "resend-key-not-real" } as never;

  it("metadata で特定できた already ではメールを送る", async () => {
    const calls = stubFetch({ rpcReason: "already" });
    const stripe = makeStripe("stripe-key-not-used"); // stubFetch の後に構築すること
    await handleStripeEvent(stripe, envWithResend, {
      id: "evt_8",
      type: "setup_intent.succeeded",
      data: {
        object: {
          id: "seti_linked",
          customer: "cus_TEST",
          metadata: { subscription_id: "sub_TEST" },
        },
      },
    } as never);

    expect(assigned(calls)).toBe(true);
    expect(mailed(calls)).toBe(true);
  });

  it("推測で拾った already ではメールを送らない (ポータルでのカード更新)", async () => {
    const calls = stubFetch({ rpcReason: "already" });
    const stripe = makeStripe("stripe-key-not-used"); // stubFetch の後に構築すること
    await handleStripeEvent(stripe, envWithResend, {
      id: "evt_9",
      type: "setup_intent.succeeded",
      data: { object: { id: "seti_guess", customer: "cus_TEST", metadata: {} } },
    } as never);

    expect(assigned(calls)).toBe(true);
    expect(mailed(calls)).toBe(false);
  });
});

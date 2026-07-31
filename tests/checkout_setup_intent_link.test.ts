import { describe, it, expect, vi, afterEach } from "vitest";
import { onRequestPost } from "../functions/api/checkout";

const env = {
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_SECRET_KEY: "svc-key",
  // Stripe は全てスタブ経由なので、明らかに無効な値を置く
  STRIPE_SECRET_KEY: "stripe-key-not-used",
  STRIPE_PRICE_MONTHLY: "price_monthly",
  STRIPE_PRICE_YEARLY: "price_yearly",
  STRIPE_PRICE_TWO_YEAR: "price_two_year",
  STRIPE_PRICE_SMS_OPTION: "price_sms",
} as never;

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

interface StubOpts {
  /** setup_intents.update が失敗する場合の応答 (既定: 成功) */
  setupIntentUpdate?: () => Response;
}

/** 申込フローが叩く経路を最小限だけ返す。未知の呼び出しは throw して気付けるようにする */
function stubFetch(opts: StubOpts = {}) {
  const calls: { url: string; method: string; body: string }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      calls.push({ url, method, body: String(init?.body ?? "") });

      // Supabase Auth: ユーザー新規作成成功
      if (url.includes("/auth/v1/admin/users")) {
        return jsonRes({ id: "user_1", email: "new@example.com" });
      }
      // Stripe: SetupIntent の metadata 更新 (今回の観測対象)
      if (url.includes("api.stripe.com/v1/setup_intents/")) {
        return opts.setupIntentUpdate ? opts.setupIntentUpdate() : jsonRes({ id: "seti_1" });
      }
      // Stripe: 既存 Customer 検索 (0 件) → 作成
      if (url.includes("api.stripe.com/v1/customers")) {
        if (method === "POST") return jsonRes({ id: "cus_1", object: "customer", email: "new@example.com" });
        return jsonRes({ object: "list", data: [] });
      }
      // Stripe: Subscription 作成 (pending_setup_intent を expand 済み)
      if (url.includes("api.stripe.com/v1/subscriptions")) {
        return jsonRes({
          id: "sub_1",
          object: "subscription",
          pending_setup_intent: { id: "seti_1", object: "setup_intent", client_secret: "seti_1_secret_x" },
        });
      }
      // Stripe: 初期費用の invoice item
      if (url.includes("api.stripe.com/v1/invoiceitems")) return jsonRes({ id: "ii_1" });

      throw new Error(`unexpected call: ${method} ${url}`);
    }),
  );
  return calls;
}

function ctx() {
  return {
    request: new Request("https://smamo.jp/api/checkout", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        plan: "monthly",
        with_sms: false,
        email: "new@example.com",
        name: "テスト",
        password: "password123",
        terms_accepted: true,
      }),
    }),
    env,
  } as never;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("POST /api/checkout — SetupIntent への契約紐付け", () => {
  it("SetupIntent の metadata に subscription_id を書き込んでから client_secret を返す", async () => {
    const calls = stubFetch();

    const res = await onRequestPost(ctx());

    expect(res.status).toBe(200);
    const body = (await res.json()) as { client_secret?: string };
    expect(body.client_secret).toBe("seti_1_secret_x");

    const link = calls.find((c) => c.url.includes("/v1/setup_intents/seti_1"));
    expect(link, "SetupIntent の metadata 更新が呼ばれていない").toBeTruthy();
    const params = decodeURIComponent(link!.body);
    expect(params).toContain("metadata[subscription_id]=sub_1");
    expect(params).toContain("metadata[supabase_user_id]=user_1");
  });

  it("metadata 更新が失敗しても申込は 200 で通す (webhook 側が推測にフォールバックするため)", async () => {
    const calls = stubFetch({
      setupIntentUpdate: () => jsonRes({ error: { message: "boom" } }, 500),
    });

    const res = await onRequestPost(ctx());

    expect(res.status).toBe(200);
    const body = (await res.json()) as { client_secret?: string; subscription_id?: string };
    expect(body.client_secret).toBe("seti_1_secret_x");
    expect(body.subscription_id).toBe("sub_1");
    // 呼びには行っている (握り潰したのは結果だけ)
    expect(calls.some((c) => c.url.includes("/v1/setup_intents/seti_1"))).toBe(true);
  });
});

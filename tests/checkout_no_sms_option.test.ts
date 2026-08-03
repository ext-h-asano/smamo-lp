import { describe, it, expect, vi, afterEach } from "vitest";
import { onRequestPost } from "../functions/api/checkout";

const env = {
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_SECRET_KEY: "svc-key",
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

function stubFetch() {
  const calls: { url: string; method: string; body: string }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      calls.push({ url, method, body: String(init?.body ?? "") });

      if (url.includes("/auth/v1/admin/users")) {
        return jsonRes({ id: "user_1", email: "new@example.com" });
      }
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

function ctx(body: Record<string, unknown>) {
  return {
    request: new Request("https://smamo.jp/api/checkout", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        plan: "monthly",
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

// 2026-07 の v8 料金改定で SMS 受信番号は全プランの基本料金に内包された。
// STRIPE_PRICE_SMS_OPTION (+¥550/月) を申込に足すと二重課金になるため、
// クライアントが with_sms を送ってきても絶対に足さないことを固定する。
describe("POST /api/checkout — SMS オプションの二重課金防止", () => {
  it("with_sms:true が送られても SMS オプション price を subscription に足さない", async () => {
    const calls = stubFetch();

    const res = await onRequestPost(ctx({ with_sms: true }));
    expect(res.status).toBe(200);

    const subCall = calls.find(
      (c) => c.url.includes("api.stripe.com/v1/subscriptions") && c.method === "POST",
    );
    expect(subCall, "subscription 作成が呼ばれていること").toBeTruthy();
    expect(subCall!.body).toContain("price_monthly");
    expect(subCall!.body).not.toContain("price_sms");
  });

  it("with_sms を一切送らなくても申込が成立する", async () => {
    const calls = stubFetch();

    const res = await onRequestPost(ctx({}));
    expect(res.status).toBe(200);

    const subCall = calls.find(
      (c) => c.url.includes("api.stripe.com/v1/subscriptions") && c.method === "POST",
    );
    expect(subCall!.body).not.toContain("price_sms");
    // metadata に "undefined" のようなゴミが載らないこと
    expect(subCall!.body).not.toContain("undefined");
  });
});

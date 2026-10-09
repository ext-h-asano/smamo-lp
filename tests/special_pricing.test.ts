import { describe, it, expect, vi, afterEach } from "vitest";
import { onRequestPost } from "../functions/api/checkout";
import { firstChargeAmountForSubscription } from "../functions/_lib/initial_fee";

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
      if (url.includes("api.stripe.com/v1/coupons/")) {
        return jsonRes({ error: { type: "invalid_request_error", code: "resource_missing", message: "No such coupon" } }, 404);
      }
      if (url.includes("api.stripe.com/v1/coupons")) {
        return jsonRes({ id: "smamo_special_monthly_2480", object: "coupon", valid: true });
      }

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

const SPECIAL = "pb.kanada@gmail.com";
const post = (calls: { url: string; method: string; body: string }[], path: string) =>
  calls.filter((c) => c.url.includes(`api.stripe.com/v1/${path}`) && c.method === "POST");

// 2026-10-09 ユーザー指示: pb.kanada@gmail.com だけ初期費用なし・月額¥2,480 を永久に。
describe("POST /api/checkout — 特別対応アカウント", () => {
  it("対象メールの月額プランは初期費用なし＋¥1,348引きの forever クーポン", async () => {
    const calls = stubFetch();
    const res = await onRequestPost(ctx({ email: SPECIAL }));
    expect(res.status).toBe(200);

    expect(post(calls, "invoiceitems")).toHaveLength(0);
    const coupon = post(calls, "coupons")[0];
    expect(coupon.body).toContain("amount_off=1348");
    expect(coupon.body).toContain("duration=forever");
    expect(coupon.body).toContain("currency=jpy");

    const sub = decodeURIComponent(post(calls, "subscriptions")[0].body);
    expect(sub).toContain("discounts[0][coupon]=smamo_special_monthly_2480");
    expect(sub).toContain("metadata[initial_fee_waived]=special_account");
    expect(sub).toContain("metadata[special_monthly_jpy]=2480");
  });

  it("大文字・前後空白でも同じ扱い", async () => {
    const calls = stubFetch();
    await onRequestPost(ctx({ email: " PB.Kanada@Gmail.com " }));
    expect(post(calls, "invoiceitems")).toHaveLength(0);
  });

  it("対象メールでも年払いは月額割引なし（初期費用だけ免除）", async () => {
    const calls = stubFetch();
    await onRequestPost(ctx({ email: SPECIAL, plan: "yearly" }));
    expect(post(calls, "invoiceitems")).toHaveLength(0);
    expect(post(calls, "coupons")).toHaveLength(0);
    expect(decodeURIComponent(post(calls, "subscriptions")[0].body)).not.toContain("discounts");
  });

  it("他のメールは通常どおり初期費用あり・割引なし", async () => {
    const calls = stubFetch();
    await onRequestPost(ctx({}));
    expect(post(calls, "invoiceitems")).toHaveLength(1);
    expect(post(calls, "coupons")).toHaveLength(0);
    expect(decodeURIComponent(post(calls, "subscriptions")[0].body)).not.toContain("discounts");
  });

  it("ウェルカムメールの初回請求額は ¥2,480", () => {
    expect(
      firstChargeAmountForSubscription({
        plan_key: "monthly",
        initial_fee_waived: "special_account",
        special_monthly_jpy: "2480",
      }),
    ).toBe(2480);
    expect(firstChargeAmountForSubscription({ plan_key: "monthly" })).toBe(3828 + 33000);
  });
});

import { describe, it, expect, vi, afterEach } from "vitest";
import { onRequestPost } from "../functions/api/checkout";

function jsonRes(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const env = {
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_SECRET_KEY: "svc-key",
  // このテストでは Stripe に到達しないので、明らかに無効な値を置く
  STRIPE_SECRET_KEY: "stripe-key-not-used",
  STRIPE_PRICE_MONTHLY: "price_monthly",
  STRIPE_PRICE_YEARLY: "price_yearly",
  STRIPE_PRICE_TWO_YEAR: "price_two_year",
  STRIPE_PRICE_SMS_OPTION: "price_sms",
} as never;

function ctx(body: unknown) {
  return {
    request: new Request("https://smamo.jp/api/checkout", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    env,
  } as never;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("POST /api/checkout — 登録済みメール", () => {
  it("パスワードが違えば 409 を返し、Stripe には一切触らない", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown, init?: RequestInit) => {
        const url = String(input);
        calls.push(url);
        if (url.includes("/auth/v1/admin/users") && init?.method === "POST") {
          return jsonRes(422, { msg: "A user with this email address has already been registered" });
        }
        if (url.includes("grant_type=password")) {
          return jsonRes(400, { error: "invalid_grant" });
        }
        throw new Error(`unexpected call: ${url}`);
      }),
    );

    const resp = await onRequestPost(
      ctx({
        plan: "monthly",
        with_sms: false,
        email: "a@example.com",
        name: "山田",
        password: "wrongpassword",
        terms_accepted: true,
      }),
    );

    expect(resp.status).toBe(409);
    const body = (await resp.json()) as { code?: string };
    expect(body.code).toBe("account_exists_password_mismatch");
    expect(calls.some((u) => u.includes("stripe.com"))).toBe(false);
  });
});

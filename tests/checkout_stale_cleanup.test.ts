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

const NOW_SEC = Math.floor(Date.now() / 1000);

/** 既存 Customer の subscription 一覧（幽霊 / 正常 / 他ユーザー が混在） */
function existingSubs() {
  return [
    // 今回のユーザーの幽霊契約（カード未確定）→ キャンセル対象
    {
      id: "sub_ghost",
      object: "subscription",
      status: "trialing",
      created: NOW_SEC - 120,
      customer: "cus_1",
      pending_setup_intent: "seti_old",
      default_payment_method: null,
      metadata: { supabase_user_id: "user_1" },
    },
    // 同じユーザーのカード確定済み契約 → 絶対に触らない
    {
      id: "sub_paid",
      object: "subscription",
      status: "active",
      created: NOW_SEC - 86400,
      customer: "cus_1",
      pending_setup_intent: null,
      default_payment_method: "pm_1",
      metadata: { supabase_user_id: "user_1" },
    },
    // 別ユーザーの幽霊契約（同一 Customer にぶら下がっていても）→ 絶対に触らない
    {
      id: "sub_other_user",
      object: "subscription",
      status: "trialing",
      created: NOW_SEC - 120,
      customer: "cus_1",
      pending_setup_intent: "seti_other",
      default_payment_method: null,
      metadata: { supabase_user_id: "user_2" },
    },
  ];
}

interface StubOpts {
  /** subscription のキャンセルを失敗させる */
  cancelFails?: boolean;
  /** invoice item 一覧 */
  invoiceItems?: unknown[];
}

function stubFetch(opts: StubOpts = {}) {
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

      // 既存 Customer が 1 件ヒットする（preferred_locales 設定済み＝更新不要）
      if (url.includes("api.stripe.com/v1/customers")) {
        if (method === "POST") throw new Error("既存 Customer があるのに customers.create が呼ばれた");
        return jsonRes({
          object: "list",
          data: [{ id: "cus_1", object: "customer", email: "new@example.com", preferred_locales: ["ja"] }],
        });
      }

      // invoice item: 一覧 / 削除
      if (url.includes("api.stripe.com/v1/invoiceitems")) {
        if (method === "DELETE") return jsonRes({ id: url.split("/").pop(), deleted: true });
        if (method === "GET") {
          return jsonRes({ object: "list", has_more: false, data: opts.invoiceItems ?? [] });
        }
        return jsonRes({ id: "ii_new" });
      }

      if (url.includes("api.stripe.com/v1/subscriptions")) {
        if (method === "DELETE") {
          if (opts.cancelFails) return jsonRes({ error: { message: "boom" } }, 500);
          return jsonRes({ id: url.split("/").pop(), object: "subscription", status: "canceled" });
        }
        if (method === "GET") {
          return jsonRes({ object: "list", has_more: false, data: existingSubs() });
        }
        return jsonRes({
          id: "sub_new",
          object: "subscription",
          pending_setup_intent: { id: "seti_1", object: "setup_intent", client_secret: "seti_1_secret_x" },
        });
      }

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
        email: "new@example.com",
        name: "テスト",
        password: "password123",
        terms_accepted: true,
      }),
    }),
    env,
  } as never;
}

function canceledSubIds(calls: { url: string; method: string }[]): string[] {
  return calls
    .filter((c) => c.method === "DELETE" && /\/v1\/subscriptions\/sub_/.test(c.url))
    .map((c) => c.url.split("/").pop()!);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("POST /api/checkout — 既存 Customer のカード未確定残骸クリーンアップ (層1)", () => {
  it("同一ユーザーの幽霊契約だけをキャンセルしてから新規契約を作る", async () => {
    const calls = stubFetch();

    const res = await onRequestPost(ctx());

    expect(res.status).toBe(200);
    expect(canceledSubIds(calls)).toEqual(["sub_ghost"]);
    // 正常契約・他ユーザー契約は絶対にキャンセルしない
    expect(canceledSubIds(calls)).not.toContain("sub_paid");
    expect(canceledSubIds(calls)).not.toContain("sub_other_user");

    // クリーンアップは subscriptions.create より前に走る
    const cancelIdx = calls.findIndex((c) => c.method === "DELETE" && c.url.includes("/v1/subscriptions/"));
    const createIdx = calls.findIndex(
      (c) => c.method === "POST" && c.url.endsWith("api.stripe.com/v1/subscriptions"),
    );
    expect(cancelIdx).toBeGreaterThanOrEqual(0);
    expect(createIdx).toBeGreaterThan(cancelIdx);
  });

  it("幽霊契約に紐づく未請求の初期費用 invoice item を削除する", async () => {
    const calls = stubFetch({
      invoiceItems: [
        { id: "ii_fee", object: "invoiceitem", invoice: null, subscription: "sub_ghost", metadata: { kind: "initial_fee" } },
        { id: "ii_other", object: "invoiceitem", invoice: null, subscription: "sub_other_user", metadata: { kind: "initial_fee" } },
      ],
    });

    const res = await onRequestPost(ctx());

    expect(res.status).toBe(200);
    const deleted = calls
      .filter((c) => c.method === "DELETE" && c.url.includes("/v1/invoiceitems/"))
      .map((c) => c.url.split("/").pop());
    expect(deleted).toEqual(["ii_fee"]);
  });

  it("キャンセル処理が失敗しても申込は 200 で完走する", async () => {
    const calls = stubFetch({ cancelFails: true });

    const res = await onRequestPost(ctx());

    expect(res.status).toBe(200);
    const body = (await res.json()) as { client_secret?: string; subscription_id?: string };
    expect(body.client_secret).toBe("seti_1_secret_x");
    expect(body.subscription_id).toBe("sub_new");
    // 新規契約はちゃんと作られている
    expect(
      calls.some((c) => c.method === "POST" && c.url.endsWith("api.stripe.com/v1/subscriptions")),
    ).toBe(true);
  });
});

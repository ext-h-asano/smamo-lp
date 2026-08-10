import { describe, it, expect, vi, afterEach } from "vitest";
import { onRequestPost } from "../functions/api/account-delete";

const env = {
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_SECRET_KEY: "svc-key",
  STRIPE_SECRET_KEY: "stripe-key-not-used",
} as never;

function jsonRes(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const DAY_MS = 86400_000;
const committedUntil = (days: number) =>
  new Date(Date.now() + days * DAY_MS).toISOString();

function subRow(o: Record<string, unknown> = {}) {
  return {
    stripe_subscription_id: "sub_monthly",
    stripe_customer_id: "cus_1",
    plan_key: "monthly",
    status: "active",
    committed_until: null,
    raw_metadata: { device_name: "device1" },
    ...o,
  };
}

function stripeSub(o: Record<string, unknown> = {}) {
  return {
    id: "sub_monthly",
    object: "subscription",
    customer: "cus_1",
    status: "active",
    items: { data: [{ price: { unit_amount: 3828 } }] },
    metadata: { plan_key: "monthly" },
    ...o,
  };
}

interface Call {
  url: string;
  method: string;
  body: string | null;
}

/**
 * @param rows      stripe_subscriptions が返す行
 * @param stripeSubs Stripe subscription retrieve の応答 (id -> object)
 * @param failCancel true なら DELETE /v1/subscriptions/... を 500 で落とす
 */
function stubFetch(opts: {
  rows?: unknown[];
  stripeSubs?: Record<string, unknown>;
  failCancel?: boolean;
  user?: unknown;
}): Call[] {
  const calls: Call[] = [];
  const rows = opts.rows ?? [];
  const stripeSubs = opts.stripeSubs ?? { sub_monthly: stripeSub() };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      calls.push({ url, method, body: (init?.body as string) ?? null });

      if (url.includes("/auth/v1/user")) {
        return opts.user === null
          ? jsonRes(401, { msg: "invalid" })
          : jsonRes(200, opts.user ?? { id: "user-abc", email: "a@example.com" });
      }
      if (url.includes("/auth/v1/admin/users/")) return jsonRes(200, {});
      if (url.includes("/rest/v1/stripe_subscriptions")) return jsonRes(200, rows);
      if (url.includes("api.stripe.com/v1/subscriptions/")) {
        if (method === "DELETE") {
          return opts.failCancel
            ? jsonRes(500, { error: { message: "stripe down" } })
            : jsonRes(200, { id: "x", object: "subscription", status: "canceled" });
        }
        const id = url.split("/v1/subscriptions/")[1].split("?")[0];
        return jsonRes(200, stripeSubs[id] ?? stripeSub({ id }));
      }
      return jsonRes(404, { msg: `unexpected ${method} ${url}` });
    }),
  );
  return calls;
}

function ctx(body: unknown, authHeader?: string) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (authHeader !== undefined) headers.authorization = authHeader;
  return {
    request: new Request("https://smamo.jp/api/account-delete", {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    }),
    env,
  } as never;
}

const banCalls = (calls: Call[]) =>
  calls.filter((c) => c.url.includes("/auth/v1/admin/users/") && c.method === "PUT");
const cancelCalls = (calls: Call[]) =>
  calls.filter((c) => c.url.includes("api.stripe.com/v1/subscriptions/") && c.method === "DELETE");

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("POST /api/account-delete — 認証", () => {
  it("Bearer が無ければ 401", async () => {
    stubFetch({});
    const res = await onRequestPost(ctx({}));
    expect(res.status).toBe(401);
  });

  it("JWT が無効なら 401", async () => {
    stubFetch({ user: null });
    const res = await onRequestPost(ctx({}, "Bearer bad"));
    expect(res.status).toBe(401);
  });
});

describe("POST /api/account-delete — 事前見積り (confirm なし)", () => {
  it("2年プランの解約手数料を返し、まだ何も解約しない", async () => {
    const calls = stubFetch({
      rows: [
        subRow({
          stripe_subscription_id: "sub_two_year",
          plan_key: "two_year",
          committed_until: committedUntil(300),
        }),
      ],
      stripeSubs: {
        sub_two_year: stripeSub({
          id: "sub_two_year",
          items: { data: [{ price: { unit_amount: 6028 } }] },
          metadata: { plan_key: "two_year", committed_until: committedUntil(300) },
        }),
      },
    });

    const res = await onRequestPost(ctx({}, "Bearer good"));
    const body = (await res.json()) as {
      requires_confirmation: boolean;
      total_cancellation_fee: number;
      subscriptions: { stripe_subscription_id: string; cancellation_fee: number }[];
    };

    expect(res.status).toBe(200);
    expect(body.requires_confirmation).toBe(true);
    expect(body.total_cancellation_fee).toBe(10 * 6028);
    expect(body.subscriptions[0].cancellation_fee).toBe(10 * 6028);
    // 見積りだけで解約もBANも起きてはいけない
    expect(cancelCalls(calls)).toHaveLength(0);
    expect(banCalls(calls)).toHaveLength(0);
  });

  it("月額プランなら手数料は 0", async () => {
    stubFetch({ rows: [subRow()] });
    const res = await onRequestPost(ctx({}, "Bearer good"));
    const body = (await res.json()) as { total_cancellation_fee: number };
    expect(body.total_cancellation_fee).toBe(0);
  });
});

describe("POST /api/account-delete — 実行 (confirm: true)", () => {
  it("契約中のサブスクを全て即時解約してから削除待ちにする", async () => {
    const calls = stubFetch({
      rows: [
        subRow({ stripe_subscription_id: "sub_a" }),
        subRow({ stripe_subscription_id: "sub_b" }),
      ],
      stripeSubs: {
        sub_a: stripeSub({ id: "sub_a" }),
        sub_b: stripeSub({ id: "sub_b" }),
      },
    });

    const res = await onRequestPost(ctx({ confirm: true }, "Bearer good"));
    expect(res.status).toBe(200);
    expect((await res.json()) as { deleted: boolean }).toMatchObject({ deleted: true });

    const cancelled = cancelCalls(calls).map((c) => c.url);
    expect(cancelled.some((u) => u.includes("sub_a"))).toBe(true);
    expect(cancelled.some((u) => u.includes("sub_b"))).toBe(true);

    // 解約が先、BAN が後 (先に BAN すると課金継続のままログイン不能になる)
    const lastCancelIdx = calls.findLastIndex(
      (c) => c.url.includes("api.stripe.com/v1/subscriptions/") && c.method === "DELETE",
    );
    const banIdx = calls.findIndex(
      (c) => c.url.includes("/auth/v1/admin/users/") && c.method === "PUT",
    );
    expect(banIdx).toBeGreaterThan(lastCancelIdx);
  });

  it("BAN と同時に pending_deletion の目印を立てる (Go の削除スイープが拾う)", async () => {
    const calls = stubFetch({ rows: [subRow()] });
    await onRequestPost(ctx({ confirm: true }, "Bearer good"));

    const ban = banCalls(calls)[0];
    expect(ban).toBeDefined();
    expect(ban.url).toContain("/auth/v1/admin/users/user-abc");
    const payload = JSON.parse(ban.body ?? "{}");
    expect(payload.app_metadata?.pending_deletion).toBe(true);
    expect(payload.ban_duration).toBeTruthy();
  });

  it("契約が1件も無くても削除できる (登録しただけのユーザー)", async () => {
    const calls = stubFetch({ rows: [] });
    const res = await onRequestPost(ctx({ confirm: true }, "Bearer good"));
    expect(res.status).toBe(200);
    expect(banCalls(calls)).toHaveLength(1);
  });

  it("解約に失敗したら BAN せず 502 を返す (課金継続のまま締め出さない)", async () => {
    const calls = stubFetch({ rows: [subRow()], failCancel: true });
    const res = await onRequestPost(ctx({ confirm: true }, "Bearer good"));
    expect(res.status).toBe(502);
    expect(banCalls(calls)).toHaveLength(0);
  });

  it("解約済みのサブスクは解約対象にしない", async () => {
    const calls = stubFetch({
      rows: [subRow({ stripe_subscription_id: "sub_dead", status: "canceled" })],
    });
    const res = await onRequestPost(ctx({ confirm: true }, "Bearer good"));
    expect(res.status).toBe(200);
    expect(cancelCalls(calls)).toHaveLength(0);
    expect(banCalls(calls)).toHaveLength(1);
  });
});

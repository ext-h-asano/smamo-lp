import { describe, it, expect, vi, afterEach } from "vitest";
import { onRequestPost } from "../functions/api/sweep-stale-signups";

const env = {
  STRIPE_SECRET_KEY: "stripe-key-not-used",
  DRAIN_SECRET: "drain-secret",
} as never;

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const NOW_SEC = Math.floor(Date.now() / 1000);

function subs() {
  return {
    trialing: [
      // 1 時間以上経過したカード未確定 = 回収対象
      {
        id: "sub_ghost_old",
        object: "subscription",
        status: "trialing",
        created: NOW_SEC - 7200,
        customer: "cus_1",
        pending_setup_intent: "seti_1",
        default_payment_method: null,
        metadata: { supabase_user_id: "user_1" },
      },
      // まだ 10 分 = カード入力中かもしれないので触らない
      {
        id: "sub_ghost_new",
        object: "subscription",
        status: "trialing",
        created: NOW_SEC - 600,
        customer: "cus_2",
        pending_setup_intent: "seti_2",
        default_payment_method: null,
        metadata: { supabase_user_id: "user_2" },
      },
      // カード確定済みの正常なトライアル契約 = 絶対に触らない
      {
        id: "sub_paid",
        object: "subscription",
        status: "trialing",
        created: NOW_SEC - 86400,
        customer: "cus_3",
        pending_setup_intent: null,
        default_payment_method: "pm_3",
        metadata: { supabase_user_id: "user_3" },
      },
    ],
    incomplete: [
      {
        id: "sub_incomplete_old",
        object: "subscription",
        status: "incomplete",
        created: NOW_SEC - 10800,
        customer: "cus_4",
        pending_setup_intent: "seti_4",
        default_payment_method: null,
        metadata: {},
      },
    ],
  };
}

interface StubOpts {
  cancelFailsFor?: string;
  invoiceItems?: unknown[];
}

function stubFetch(opts: StubOpts = {}) {
  const calls: { url: string; method: string }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      calls.push({ url, method });

      if (url.includes("api.stripe.com/v1/invoiceitems")) {
        if (method === "DELETE") return jsonRes({ id: url.split("/").pop(), deleted: true });
        return jsonRes({ object: "list", has_more: false, data: opts.invoiceItems ?? [] });
      }

      if (url.includes("api.stripe.com/v1/subscriptions")) {
        if (method === "DELETE") {
          const id = url.split("/").pop()!;
          if (opts.cancelFailsFor === id) return jsonRes({ error: { message: "boom" } }, 500);
          return jsonRes({ id, object: "subscription", status: "canceled" });
        }
        const data = url.includes("status=incomplete") ? subs().incomplete : subs().trialing;
        return jsonRes({ object: "list", has_more: false, data });
      }

      throw new Error(`unexpected call: ${method} ${url}`);
    }),
  );
  return calls;
}

function ctx(secret: string | null = "drain-secret") {
  const headers: Record<string, string> = {};
  if (secret !== null) headers["x-drain-secret"] = secret;
  return {
    request: new Request("https://smamo.jp/api/sweep-stale-signups", { method: "POST", headers }),
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

describe("POST /api/sweep-stale-signups (層2: 幽霊契約の定期回収)", () => {
  it("drain secret が違えば 401 で Stripe を一切叩かない", async () => {
    const calls = stubFetch();
    const res = await onRequestPost(ctx("wrong"));
    expect(res.status).toBe(401);
    expect(calls.length).toBe(0);

    const res2 = await onRequestPost(ctx(null));
    expect(res2.status).toBe(401);
    expect(calls.length).toBe(0);
  });

  it("1 時間以上経ったカード未確定契約だけをキャンセルする", async () => {
    const calls = stubFetch();

    const res = await onRequestPost(ctx());

    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, number>;
    expect(body).toEqual({ checked: 4, matched: 2, canceled: 2, failed: 0 });

    const canceled = canceledSubIds(calls).sort();
    expect(canceled).toEqual(["sub_ghost_old", "sub_incomplete_old"]);
    expect(canceled).not.toContain("sub_ghost_new"); // 1 時間未満
    expect(canceled).not.toContain("sub_paid"); // カード確定済み
  });

  it("紐づく未請求の初期費用 invoice item も削除する", async () => {
    const calls = stubFetch({
      invoiceItems: [
        { id: "ii_fee", object: "invoiceitem", invoice: null, subscription: "sub_ghost_old", metadata: { kind: "initial_fee" } },
        { id: "ii_keep", object: "invoiceitem", invoice: null, subscription: "sub_paid", metadata: { kind: "initial_fee" } },
      ],
    });

    const res = await onRequestPost(ctx());
    expect(res.status).toBe(200);

    const deleted = calls
      .filter((c) => c.method === "DELETE" && c.url.includes("/v1/invoiceitems/"))
      .map((c) => c.url.split("/").pop());
    expect(deleted).toContain("ii_fee");
    expect(deleted).not.toContain("ii_keep");
  });

  it("一部のキャンセルが失敗しても残りを処理し failed に数える", async () => {
    const calls = stubFetch({ cancelFailsFor: "sub_ghost_old" });

    const res = await onRequestPost(ctx());

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ checked: 4, matched: 2, canceled: 1, failed: 1 });
    expect(canceledSubIds(calls)).toContain("sub_incomplete_old");
  });
});

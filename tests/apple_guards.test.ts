/**
 * App Store の契約（stripe_subscription_id = 'apple:...'）を Stripe API に渡さないことの確認。
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { syncSubscription } from "../functions/_lib/subscription_sync";
import { getCustomerIdForUser } from "../functions/_lib/supabase";
import { onRequestPost as portal } from "../functions/api/portal";
import { onRequestPost as toggleSms } from "../functions/api/toggle-sms";
import { onRequestPost as drain } from "../functions/api/drain-waitlist";
import { autoAssignContainer } from "../functions/_lib/auto_provisioning";
import { makeStripe } from "../functions/_lib/stripe";

const env = {
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_SECRET_KEY: "svc",
  STRIPE_SECRET_KEY: "stripe-key-not-used",
  DRAIN_SECRET: "drain",
} as never;

function jsonRes(status: number, body?: unknown) {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

interface Call {
  url: string;
  method: string;
}

function stub(handler: (url: string, method: string) => Response | undefined): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      calls.push({ url, method });
      if (url.includes("/auth/v1/user")) return jsonRes(200, { id: "user-1", email: "u@example.com" });
      return handler(url, method) ?? jsonRes(404, { message: `unexpected ${method} ${url}` });
    }),
  );
  return calls;
}
const stripeCalls = (calls: Call[]) => calls.filter((c) => c.url.includes("api.stripe.com"));

function req(path: string, body: unknown, headers: Record<string, string> = { authorization: "Bearer t" }) {
  return {
    request: new Request(`https://smamo.jp${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    }),
    env,
  } as never;
}

afterEach(() => vi.unstubAllGlobals());

describe("Apple ガード", () => {
  it("syncSubscription は apple: の契約で Stripe を呼ばない", async () => {
    const calls = stub(() => undefined);
    await syncSubscription(makeStripe("stripe-key-not-used"), env, "apple:2000000111");
    expect(calls).toEqual([]);
  });

  it("getCustomerIdForUser は App Store の行を除いて探す", async () => {
    const calls = stub((url) => (url.includes("/rest/v1/stripe_subscriptions") ? jsonRes(200, []) : undefined));
    expect(await getCustomerIdForUser({ url: "https://example.supabase.co", serviceRoleKey: "svc" }, "user-1")).toBeNull();
    expect(calls[0].url).toContain("stripe_customer_id=neq.apple");
  });

  it("portal: App Store の契約を指定されたら 400（Stripe を呼ばない）", async () => {
    const calls = stub((url) => (url.includes("stripe_subscriptions") ? jsonRes(200, [{ stripe_customer_id: "cus_1" }]) : undefined));
    const res = await portal(req("/api/portal", { flow: "cancel", subscription_id: "apple:2000000111" }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "apple_subscription" });
    expect(stripeCalls(calls)).toEqual([]);
  });

  it("portal: App Store の契約しか無ければ 404（Stripe を呼ばない）", async () => {
    const calls = stub((url) => (url.includes("stripe_subscriptions") ? jsonRes(200, []) : undefined));
    const res = await portal(req("/api/portal", {}));
    expect(res.status).toBe(404);
    expect(stripeCalls(calls)).toEqual([]);
  });

  it("toggle-sms: App Store の契約なら 400（Stripe を呼ばない）", async () => {
    const calls = stub((url) => (url.includes("stripe_subscriptions") ? jsonRes(200, [{ stripe_customer_id: "cus_1" }]) : undefined));
    const res = await toggleSms(req("/api/toggle-sms", { subscription_id: "apple:2000000111", enable: true }));
    expect(res.status).toBe(400);
    expect(stripeCalls(calls)).toEqual([]);
  });

  it("drain-waitlist: App Store の契約は trial_end を戻さず割当だけ数える", async () => {
    let n = 0;
    const calls = stub((url) => {
      if (url.includes("/rpc/assign_next_waitlisted")) {
        n++;
        return n === 1
          ? jsonRes(200, [{ reason: "ok", subscription_id: "apple:2000000111", user_id_assigned: "user-1", container_name: "abc", remaining_pool: 2 }])
          : jsonRes(200, [{ reason: "no_waiter" }]);
      }
      return undefined;
    });
    const res = await drain(req("/api/drain-waitlist", {}, { "x-drain-secret": "drain" }));
    expect(await res.json()).toEqual({ assigned: 1, stopped: "no_waiter" });
    expect(stripeCalls(calls)).toEqual([]);
  });

  it("autoAssignContainer: 枯渇時、App Store の契約では trial_end を凍結しない", async () => {
    const calls = stub((url) => {
      if (url.includes("/rpc/auto_assign_pool_container")) return jsonRes(200, [{ reason: "exhausted" }]);
      if (url.includes("/rpc/mark_waitlisted")) return jsonRes(200, true);
      return undefined;
    });
    const reason = await autoAssignContainer({
      env,
      stripe: makeStripe("stripe-key-not-used"),
      subscriptionId: "apple:2000000111",
      triggerId: "t",
    });
    expect(reason).toBe("exhausted");
    expect(stripeCalls(calls)).toEqual([]);
    expect(calls.some((c) => c.url.includes("/rpc/mark_waitlisted"))).toBe(true);
  });
});

/**
 * Apple 系テスト用の fetch スタブ。stripe_subscriptions を小さなインメモリ表として持ち、
 * PostgREST / GoTrue / RPC の必要な分だけ真似る。Stripe API が呼ばれたら記録する（呼ばれてはいけない）。
 */
import { vi } from "vitest";

export interface FakeRow {
  user_id: string;
  stripe_subscription_id: string;
  status: string;
  waitlisted_at?: string | null;
  raw_metadata?: Record<string, unknown> | null;
  [k: string]: unknown;
}

export interface FakeDb {
  rows: FakeRow[];
  calls: { url: string; method: string; body: unknown }[];
  stripeCalls: string[];
  assign: { reason: string; container_name?: string | null; remaining_pool?: number | null } | "error";
  poolCount: number | "error";
  user: { id: string; email: string } | null;
  failLookup?: boolean;
  /** 次の INSERT を 1 回だけこの PostgREST エラーで落とす */
  insertError?: { status: number; code: string; thenRow?: FakeRow };
  contractStatus: Record<string, string>;
}

function res(status: number, body?: unknown): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function param(url: URL, key: string): string | null {
  const v = url.searchParams.get(key);
  return v && v.startsWith("eq.") ? v.slice(3) : null;
}

export function installFakeSupabase(init: Partial<FakeDb> = {}): FakeDb {
  const db: FakeDb = {
    rows: [],
    calls: [],
    stripeCalls: [],
    assign: { reason: "ok", container_name: "c-new", remaining_pool: 10 },
    poolCount: 3,
    user: { id: "11111111-1111-4111-8111-111111111111", email: "u@example.com" },
    contractStatus: {},
    ...init,
  };

  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown, reqInit?: RequestInit) => {
      const url = new URL(String(input));
      const method = (reqInit?.method ?? "GET").toUpperCase();
      let body: unknown = reqInit?.body ?? null;
      if (typeof body === "string") {
        try {
          body = JSON.parse(body);
        } catch {
          /* keep */
        }
      }
      db.calls.push({ url: url.toString(), method, body });

      if (url.hostname === "api.stripe.com") {
        db.stripeCalls.push(`${method} ${url.pathname}`);
        return res(500, { error: { message: "stripe must not be called" } });
      }

      const path = url.pathname;
      if (path === "/auth/v1/user") return db.user ? res(200, db.user) : res(401, { msg: "bad jwt" });

      if (path === "/rest/v1/stripe_subscriptions") {
        const subId = param(url, "stripe_subscription_id");
        const userId = param(url, "user_id");
        if (method === "GET") {
          if (db.failLookup) return res(503, { message: "down" });
          return res(
            200,
            db.rows.filter(
              (r) => (!subId || r.stripe_subscription_id === subId) && (!userId || r.user_id === userId),
            ),
          );
        }
        if (method === "POST") {
          if (db.insertError) {
            const e = db.insertError;
            db.insertError = undefined;
            if (e.thenRow) db.rows.push(e.thenRow);
            return res(e.status, { code: e.code, message: "pg error" });
          }
          db.rows.push({ waitlisted_at: null, ...(body as FakeRow) });
          return res(201);
        }
        if (method === "PATCH") {
          for (const r of db.rows) {
            if ((!subId || r.stripe_subscription_id === subId) && (!userId || r.user_id === userId)) {
              Object.assign(r, body as object);
            }
          }
          return res(204);
        }
      }

      if (path === "/rest/v1/users" && method === "PATCH") {
        const id = param(url, "id");
        if (id) db.contractStatus[id] = (body as { contract_status: string }).contract_status;
        return res(204);
      }

      if (path === "/rest/v1/rpc/auto_assign_pool_container") {
        if (db.assign === "error") return res(500, { message: "rpc down" });
        return res(200, [{ container_name: null, scrcpy_port: null, remaining_pool: null, user_id_assigned: null, ...db.assign }]);
      }
      if (path === "/rest/v1/rpc/mark_waitlisted") {
        const id = (body as { p_subscription_id: string }).p_subscription_id;
        for (const r of db.rows) if (r.stripe_subscription_id === id) r.waitlisted_at ??= new Date().toISOString();
        return res(200, true);
      }
      if (path === "/rest/v1/rpc/pool_available_count") {
        return db.poolCount === "error" ? res(500, { message: "down" }) : res(200, db.poolCount);
      }

      return res(404, { message: `unhandled ${method} ${path}` });
    }),
  );
  return db;
}

export function rpcCalls(db: FakeDb, name: string) {
  return db.calls.filter((c) => c.url.includes(`/rest/v1/rpc/${name}`));
}

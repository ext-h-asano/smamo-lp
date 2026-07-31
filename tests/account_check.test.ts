import { describe, it, expect, vi, afterEach } from "vitest";
import { onRequestPost } from "../functions/api/account-check";

function jsonRes(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const env = {
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_SECRET_KEY: "svc-key",
} as never;

function ctx(body: unknown) {
  return {
    request: new Request("https://smamo.jp/api/account-check", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    env,
  } as never;
}

function stubFetch(handler: (url: string) => Response): string[] {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown) => {
      const url = String(input);
      calls.push(url);
      return handler(url);
    }),
  );
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("POST /api/account-check", () => {
  it("未登録なら exists:false を返し、認証は試みない", async () => {
    const calls = stubFetch(() => jsonRes(200, { users: [] }));

    const resp = await onRequestPost(ctx({ email: "new@example.com", password: "password123" }));

    expect(resp.status).toBe(200);
    expect(await resp.json()).toEqual({ exists: false });
    expect(calls.some((u) => u.includes("grant_type=password"))).toBe(false);
  });

  it("登録済み＋パスワード一致なら authenticated:true", async () => {
    stubFetch((url) => {
      if (url.includes("grant_type=password")) return jsonRes(200, { access_token: "t" });
      return jsonRes(200, { users: [{ id: "u1", email: "a@example.com" }] });
    });

    const resp = await onRequestPost(ctx({ email: "a@example.com", password: "password123" }));

    expect(await resp.json()).toEqual({ exists: true, authenticated: true });
  });

  it("登録済み＋パスワード不一致なら authenticated:false", async () => {
    stubFetch((url) => {
      if (url.includes("grant_type=password")) return jsonRes(400, { error: "invalid_grant" });
      return jsonRes(200, { users: [{ id: "u1", email: "a@example.com" }] });
    });

    const resp = await onRequestPost(ctx({ email: "a@example.com", password: "wrongpassword" }));

    expect(await resp.json()).toEqual({ exists: true, authenticated: false });
  });

  it("メール形式が不正なら 400", async () => {
    const resp = await onRequestPost(ctx({ email: "not-an-email", password: "password123" }));
    expect(resp.status).toBe(400);
  });

  it("パスワードが 8 文字未満なら 400", async () => {
    const resp = await onRequestPost(ctx({ email: "a@example.com", password: "short" }));
    expect(resp.status).toBe(400);
  });

  it("Supabase 障害なら 500（exists を捏造しない）", async () => {
    stubFetch(() => jsonRes(500, { msg: "boom" }));

    const resp = await onRequestPost(ctx({ email: "a@example.com", password: "password123" }));

    expect(resp.status).toBe(500);
  });
});

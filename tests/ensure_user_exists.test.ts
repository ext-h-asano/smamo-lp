import { describe, it, expect, vi, afterEach } from "vitest";
import {
  AccountPasswordMismatchError,
  activatePendingUser,
  ensureUserExists,
  findUserByEmail,
  verifyPassword,
} from "../functions/_lib/supabase";

const cfg = { url: "https://example.supabase.co", serviceRoleKey: "svc-key" };

function jsonRes(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * fetch をスタブし、呼ばれた URL を記録する。
 * handler が未知の URL で throw することで「呼ばれるべきでない API を呼んだ」を検出する。
 */
function stubFetch(handler: (url: string, init?: RequestInit) => Response): string[] {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      calls.push(url);
      return handler(url, init);
    }),
  );
  return calls;
}

const ALREADY_EXISTS = {
  msg: "A user with this email address has already been registered",
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ensureUserExists", () => {
  it("新規作成に成功したら、パスワード検証をせずにそのユーザーを返す", async () => {
    const calls = stubFetch((url) => {
      if (url.includes("/auth/v1/admin/users")) {
        return jsonRes(200, { id: "u1", email: "a@example.com" });
      }
      throw new Error(`unexpected call: ${url}`);
    });

    const user = await ensureUserExists(cfg, "a@example.com", "password123", "山田");

    expect(user.id).toBe("u1");
    expect(calls.some((u) => u.includes("grant_type=password"))).toBe(false);
  });

  it("既存アカウントでもパスワードが一致すれば既存ユーザーを返す", async () => {
    stubFetch((url, init) => {
      if (url.includes("/auth/v1/admin/users") && init?.method === "POST") {
        return jsonRes(422, ALREADY_EXISTS);
      }
      if (url.includes("grant_type=password")) return jsonRes(200, { access_token: "t" });
      if (url.includes("/auth/v1/admin/users")) {
        return jsonRes(200, { users: [{ id: "u9", email: "a@example.com" }] });
      }
      throw new Error(`unexpected call: ${url}`);
    });

    const user = await ensureUserExists(cfg, "a@example.com", "password123", "山田");

    expect(user.id).toBe("u9");
  });

  it("既存アカウントでパスワードが不一致なら AccountPasswordMismatchError を投げる", async () => {
    const calls = stubFetch((url, init) => {
      if (url.includes("/auth/v1/admin/users") && init?.method === "POST") {
        return jsonRes(422, ALREADY_EXISTS);
      }
      if (url.includes("grant_type=password")) {
        return jsonRes(400, { error: "invalid_grant", error_description: "Invalid login credentials" });
      }
      if (url.includes("filter=")) return jsonRes(200, { users: [{ id: "u1", email: "a@example.com", app_metadata: {} }] });
      throw new Error(`unexpected call: ${url}`);
    });

    await expect(
      ensureUserExists(cfg, "a@example.com", "wrongpassword", "山田"),
    ).rejects.toBeInstanceOf(AccountPasswordMismatchError);

    // 仮アカウントかどうかを見るために引くが、更新はしない
    expect(calls.filter((u) => /admin\/users\/u1/.test(u)).length).toBe(0);
  });

  it("パスワード検証中の Supabase 障害は不一致に化けさせない", async () => {
    stubFetch((url, init) => {
      if (url.includes("/auth/v1/admin/users") && init?.method === "POST") {
        return jsonRes(422, ALREADY_EXISTS);
      }
      if (url.includes("grant_type=password")) return jsonRes(503, { msg: "service unavailable" });
      throw new Error(`unexpected call: ${url}`);
    });

    const err = await ensureUserExists(cfg, "a@example.com", "password123", "山田").catch((e) => e);

    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(AccountPasswordMismatchError);
  });

  it("already exists 以外の作成失敗はそのままエラーにする", async () => {
    stubFetch((url) => {
      if (url.includes("/auth/v1/admin/users")) return jsonRes(500, { msg: "boom" });
      throw new Error(`unexpected call: ${url}`);
    });

    await expect(
      ensureUserExists(cfg, "a@example.com", "password123", "山田"),
    ).rejects.toThrow(/createUser failed/);
  });
});

describe("findUserByEmail", () => {
  it("部分一致で返ってきた別アドレスは拾わない", async () => {
    stubFetch(() => jsonRes(200, { users: [{ id: "u2", email: "other-a@example.com" }] }));

    expect(await findUserByEmail(cfg, "a@example.com")).toBeNull();
  });

  it("大文字小文字の違いは吸収する", async () => {
    stubFetch(() => jsonRes(200, { users: [{ id: "u3", email: "a@example.com" }] }));

    const user = await findUserByEmail(cfg, "A@Example.com");

    expect(user?.id).toBe("u3");
  });

  it("Supabase が失敗を返したら throw する（存在しない扱いにしない）", async () => {
    stubFetch(() => jsonRes(500, { msg: "boom" }));

    await expect(findUserByEmail(cfg, "a@example.com")).rejects.toThrow(/lookup failed/);
  });
});

describe("verifyPassword", () => {
  it("200 なら true", async () => {
    stubFetch(() => jsonRes(200, { access_token: "t" }));
    expect(await verifyPassword(cfg, "a@example.com", "password123")).toBe(true);
  });

  it("400 / 401 なら false", async () => {
    stubFetch(() => jsonRes(400, { error: "invalid_grant" }));
    expect(await verifyPassword(cfg, "a@example.com", "bad")).toBe(false);

    vi.unstubAllGlobals();
    stubFetch(() => jsonRes(401, { error: "invalid_grant" }));
    expect(await verifyPassword(cfg, "a@example.com", "bad")).toBe(false);
  });

  it("service-role の Authorization ヘッダを送らない（本人のログイン試行として扱わせる）", async () => {
    let sentHeaders: Record<string, string> = {};
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: unknown, init?: RequestInit) => {
        sentHeaders = (init?.headers ?? {}) as Record<string, string>;
        return jsonRes(200, { access_token: "t" });
      }),
    );

    await verifyPassword(cfg, "a@example.com", "password123");

    expect(sentHeaders.apikey).toBe("svc-key");
    expect(sentHeaders.Authorization).toBeUndefined();
  });

  it("500 は throw する", async () => {
    stubFetch(() => jsonRes(500, { msg: "boom" }));
    await expect(verifyPassword(cfg, "a@example.com", "password123")).rejects.toThrow();
  });
});

describe("ensureUserExists — カード未登録の仮アカウント", () => {
  it("新規作成は仮アカウント（pending_card + ban）で作る", async () => {
    const bodies: string[] = [];
    stubFetch((url, init) => {
      if (url.includes("/auth/v1/admin/users") && init?.method === "POST") {
        bodies.push(String(init.body));
        return jsonRes(200, { id: "u1", email: "a@example.com" });
      }
      throw new Error(`unexpected call: ${url}`);
    });
    await ensureUserExists(cfg, "a@example.com", "password123", "山田");
    const body = JSON.parse(bodies[0]);
    expect(body.app_metadata).toEqual({ pending_card: true });
    expect(body.ban_duration).toBe("876000h");
  });

  it("前回離脱した仮アカウントはパスワードを上書きして使い回す", async () => {
    const puts: string[] = [];
    stubFetch((url, init) => {
      if (url.includes("/auth/v1/admin/users") && init?.method === "POST") return jsonRes(422, ALREADY_EXISTS);
      if (url.includes("grant_type=password")) return jsonRes(400, { error: "user_banned" });
      if (url.includes("filter=")) {
        return jsonRes(200, { users: [{ id: "u1", email: "a@example.com", app_metadata: { pending_card: true } }] });
      }
      if (url.includes("/auth/v1/admin/users/u1") && init?.method === "PUT") {
        puts.push(String(init.body));
        return jsonRes(200, { id: "u1" });
      }
      throw new Error(`unexpected call: ${url}`);
    });
    const u = await ensureUserExists(cfg, "a@example.com", "newpassword1", "山田");
    expect(u.id).toBe("u1");
    expect(JSON.parse(puts[0])).toEqual({ password: "newpassword1", user_metadata: { name: "山田" } });
  });
});

describe("activatePendingUser", () => {
  it("仮アカウントなら ban を解いて目印を外す", async () => {
    const puts: string[] = [];
    stubFetch((url, init) => {
      if (url.endsWith("/auth/v1/admin/users/u1") && (init?.method ?? "GET") === "GET") {
        return jsonRes(200, { id: "u1", app_metadata: { pending_card: true } });
      }
      if (url.endsWith("/auth/v1/admin/users/u1") && init?.method === "PUT") {
        puts.push(String(init.body));
        return jsonRes(200, { id: "u1" });
      }
      throw new Error(`unexpected call: ${url}`);
    });
    expect(await activatePendingUser(cfg, "u1")).toBe(true);
    expect(JSON.parse(puts[0])).toEqual({ ban_duration: "none", app_metadata: { pending_card: false } });
  });

  it("仮アカウントでなければ触らない（退会者の ban を解かない）", async () => {
    stubFetch((url, init) => {
      if ((init?.method ?? "GET") === "GET") return jsonRes(200, { id: "u1", app_metadata: { pending_deletion: true } });
      throw new Error(`unexpected call: ${init?.method} ${url}`);
    });
    expect(await activatePendingUser(cfg, "u1")).toBe(false);
  });
});

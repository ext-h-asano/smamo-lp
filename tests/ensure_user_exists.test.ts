import { describe, it, expect, vi, afterEach } from "vitest";
import {
  AccountPasswordMismatchError,
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
      throw new Error(`unexpected call: ${url}`);
    });

    await expect(
      ensureUserExists(cfg, "a@example.com", "wrongpassword", "山田"),
    ).rejects.toBeInstanceOf(AccountPasswordMismatchError);

    // 不一致のときはユーザー情報を引きに行かない（存在情報を余計に触らない）
    expect(calls.filter((u) => u.includes("filter=")).length).toBe(0);
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

import { describe, it, expect, vi, afterEach } from "vitest";
import { onRequestPost as passwordReset } from "../functions/api/password-reset";
import { onRequestPost as passwordUpdate } from "../functions/api/password-update";

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

function ctx(path: string, body: unknown) {
  return {
    request: new Request(`https://smamo.jp${path}`, {
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

describe("POST /api/password-reset", () => {
  it("リクエスト元のオリジンの /reset を redirect_to に指定する", async () => {
    let calledUrl = "";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown) => {
        calledUrl = String(input);
        return jsonRes(200, {});
      }),
    );

    const resp = await passwordReset(ctx("/api/password-reset", { email: "a@example.com" }));

    expect(resp.status).toBe(200);
    expect(calledUrl).toContain("/auth/v1/recover");
    expect(decodeURIComponent(calledUrl)).toContain("https://smamo.jp/reset");
  });

  it("Supabase が失敗しても 200 を返す（存在有無を推定させない）", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonRes(429, { msg: "rate limited" })));

    const resp = await passwordReset(ctx("/api/password-reset", { email: "a@example.com" }));

    expect(resp.status).toBe(200);
    expect(await resp.json()).toEqual({ ok: true });
  });

  it("メール形式が不正でも 200 を返し、Supabase を呼ばない", async () => {
    const fetchMock = vi.fn(async () => jsonRes(200, {}));
    vi.stubGlobal("fetch", fetchMock);

    const resp = await passwordReset(ctx("/api/password-reset", { email: "nope" }));

    expect(resp.status).toBe(200);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("POST /api/password-update", () => {
  it("トークンが無ければ 401", async () => {
    const resp = await passwordUpdate(ctx("/api/password-update", { password: "newpassword" }));
    expect(resp.status).toBe(401);
    expect(((await resp.json()) as { code?: string }).code).toBe("invalid_token");
  });

  it("パスワードが 8 文字未満なら 400", async () => {
    const resp = await passwordUpdate(ctx("/api/password-update", { access_token: "t", password: "short" }));
    expect(resp.status).toBe(400);
  });

  it("Supabase が 401 を返したら 401 invalid_token", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonRes(401, { msg: "expired" })));

    const resp = await passwordUpdate(ctx("/api/password-update", { access_token: "t", password: "newpassword" }));

    expect(resp.status).toBe(401);
    expect(((await resp.json()) as { code?: string }).code).toBe("invalid_token");
  });

  it("成功したら 200 で、Bearer に recovery トークンを載せる", async () => {
    let sentHeaders: Record<string, string> = {};
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: unknown, init?: RequestInit) => {
        sentHeaders = (init?.headers ?? {}) as Record<string, string>;
        return jsonRes(200, { id: "u1" });
      }),
    );

    const resp = await passwordUpdate(
      ctx("/api/password-update", { access_token: "recovery-token", password: "newpassword" }),
    );

    expect(resp.status).toBe(200);
    expect(sentHeaders.Authorization).toBe("Bearer recovery-token");
  });
});

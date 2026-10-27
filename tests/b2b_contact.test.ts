import { describe, it, expect, vi, afterEach } from "vitest";
import { onRequestPost } from "../functions/api/b2b-contact";

const env = { RESEND_API_KEY: "re_test" } as never;

const valid = {
  company: "株式会社テスト",
  name: "山田 太郎",
  email: "taro@example.com",
  tel: "",
  message: "10台ほど検討しています",
  privacy: "agree",
  website: "",
};

function ctx(fields: Record<string, string>) {
  return {
    request: new Request("https://smamo.jp/api/b2b-contact", {
      method: "POST",
      body: new URLSearchParams(fields),
    }),
    env,
  } as never;
}

function stubResend(status = 200) {
  const sent: { to: string[]; reply_to: string; idem: string | null }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: unknown, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      sent.push({ to: body.to, reply_to: body.reply_to, idem: (init.headers as Record<string, string>)["Idempotency-Key"] ?? null });
      return new Response(JSON.stringify(status === 200 ? { id: "x" } : { message: "ng" }), { status });
    }),
  );
  return sent;
}

afterEach(() => vi.unstubAllGlobals());

describe("POST /api/b2b-contact", () => {
  it("担当者2名と申込者に送信して thanks へ 303", async () => {
    const sent = stubResend();
    const res = await onRequestPost(ctx(valid));
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/b2b/contact-thanks.html");
    expect(sent.map((s) => s.to[0])).toEqual(["info@ext.cx", "kato@ext.cx", "taro@example.com"]);
    expect(sent[0].reply_to).toBe("taro@example.com");
    expect(sent.every((s) => s.idem)).toBe(true);
  });

  it("同じ内容の再送は同じ Idempotency-Key になる", async () => {
    const a = stubResend();
    await onRequestPost(ctx(valid));
    const b = stubResend();
    await onRequestPost(ctx(valid));
    expect(b.map((s) => s.idem)).toEqual(a.map((s) => s.idem));
  });

  it("honeypot が埋まっていたら送信しない", async () => {
    const sent = stubResend();
    const res = await onRequestPost(ctx({ ...valid, website: "spam" }));
    expect(res.status).toBe(422);
    expect(sent).toHaveLength(0);
  });

  it("同意なし・メール不正・必須欠落は 422", async () => {
    stubResend();
    expect((await onRequestPost(ctx({ ...valid, privacy: "" }))).status).toBe(422);
    expect((await onRequestPost(ctx({ ...valid, email: "bad" }))).status).toBe(422);
    expect((await onRequestPost(ctx({ ...valid, company: "" }))).status).toBe(422);
  });

  it("Resend が失敗したら 503 でエラーページ", async () => {
    stubResend(500);
    const res = await onRequestPost(ctx(valid));
    expect(res.status).toBe(503);
    expect(await res.text()).toContain("メール送信に失敗しました");
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { onRequestPost } from "../functions/api/line/webhook";
import { describeLineMessage } from "../functions/_lib/line";

const SECRET = "line-channel-secret-not-real";
const DISCORD_URL = "https://discord.example/line-webhook-not-real";

async function sign(body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const bytes = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)));
  return btoa(String.fromCharCode(...bytes));
}

async function invoke(bodyObject: unknown, envOverrides: Record<string, string | undefined> = {}) {
  const rawBody = JSON.stringify(bodyObject);
  const pending: Promise<unknown>[] = [];
  const env = {
    LINE_CHANNEL_SECRET: SECRET,
    LINE_DISCORD_WEBHOOK_URL: DISCORD_URL,
    ...envOverrides,
  } as never;
  const response = await onRequestPost({
    request: new Request("https://dev.smamo.jp/api/line/webhook", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-line-signature": await sign(rawBody),
      },
      body: rawBody,
    }),
    env,
    waitUntil: (promise: Promise<unknown>) => pending.push(promise),
  } as never);
  await Promise.all(pending);
  return response;
}

afterEach(() => vi.unstubAllGlobals());

describe("POST /api/line/webhook", () => {
  it("LINE の検証リクエスト events:[] に 200 を返す", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await invoke({ destination: "Ubot", events: [] });

    expect(response.status).toBe(200);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("署名が不正なら拒否する", async () => {
    const rawBody = JSON.stringify({ events: [] });
    const response = await onRequestPost({
      request: new Request("https://dev.smamo.jp/api/line/webhook", {
        method: "POST",
        headers: { "x-line-signature": "invalid" },
        body: rawBody,
      }),
      env: { LINE_CHANNEL_SECRET: SECRET, LINE_DISCORD_WEBHOOK_URL: DISCORD_URL },
      waitUntil: vi.fn(),
    } as never);

    expect(response.status).toBe(401);
  });

  it("テキストメッセージを Discord embed に転送する", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    const response = await invoke({
      destination: "Ubot",
      events: [
        {
          type: "message",
          webhookEventId: "evt-line-1",
          timestamp: 1_700_000_000_000,
          source: { type: "user", userId: "U123" },
          message: { id: "msg-1", type: "text", text: "お問い合わせです" },
        },
      ],
    });

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(DISCORD_URL);
    const payload = JSON.parse(String(init?.body));
    expect(payload.allowed_mentions).toEqual({ parse: [] });
    expect(payload.embeds[0].description).toBe("お問い合わせです");
    expect(payload.embeds[0].fields).toContainEqual({ name: "送信者", value: "U123", inline: true });
  });

  it("アクセストークンがあれば表示名を取得して通知する", async () => {
    const fetchMock = vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url.startsWith("https://api.line.me/")) {
        return new Response(JSON.stringify({ displayName: "テスト太郎" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(null, { status: 204 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const response = await invoke(
      {
        events: [
          {
            type: "message",
            source: { type: "user", userId: "U123" },
            message: { id: "msg-1", type: "image" },
          },
        ],
      },
      { LINE_CHANNEL_ACCESS_TOKEN: "access-token-not-real" },
    );

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const discordCall = fetchMock.mock.calls.find(([url]) => String(url) === DISCORD_URL);
    const payload = JSON.parse(String(discordCall?.[1]?.body));
    expect(payload.embeds[0].description).toBe("📷 画像を受信しました");
    expect(payload.embeds[0].fields[0].value).toBe("テスト太郎");
  });

  it("実メッセージ受信時に Discord URL が無ければ 503", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const response = await invoke(
      { events: [{ type: "message", message: { id: "msg-1", type: "text", text: "x" } }] },
      { LINE_DISCORD_WEBHOOK_URL: undefined },
    );
    expect(response.status).toBe(503);
  });
});

describe("describeLineMessage", () => {
  it("代表的な非テキスト種別を人が読める形にする", () => {
    expect(describeLineMessage({ type: "sticker", packageId: "1", stickerId: "2" })).toContain(
      "スタンプ",
    );
    expect(describeLineMessage({ type: "file", fileName: "sample.pdf", fileSize: 42 })).toContain(
      "sample.pdf",
    );
    expect(describeLineMessage({ type: "location", title: "店舗", latitude: 35, longitude: 139 })).toContain(
      "35, 139",
    );
  });
});

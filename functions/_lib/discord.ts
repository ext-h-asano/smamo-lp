import type { Env } from "./stripe";

export type DiscordLevel = "info" | "warn" | "critical";

const COLOR: Record<DiscordLevel, number> = {
  info: 0x2ecc71,
  warn: 0xf1c40f,
  critical: 0xe74c3c,
};

export interface DiscordPayload {
  title: string;
  description?: string;
  fields?: { name: string; value: string; inline?: boolean }[];
}

/**
 * Discord に embed メッセージを送る。
 *
 * 設計上の不変条件: never throw。失敗は console.error のみ。
 * Stripe webhook が 200 を返すのを絶対に妨げない。
 */
export async function sendDiscord(
  env: Env,
  level: DiscordLevel,
  payload: DiscordPayload,
): Promise<void> {
  const url = env.DISCORD_WEBHOOK_URL;
  if (!url) {
    console.warn(`[discord] DISCORD_WEBHOOK_URL not set, skip (${level}: ${payload.title})`);
    return;
  }
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        embeds: [
          {
            title: payload.title,
            description: payload.description,
            color: COLOR[level],
            fields: payload.fields,
            timestamp: new Date().toISOString(),
          },
        ],
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "<no body>");
      console.error(`[discord] ${res.status} ${body}`);
    }
  } catch (e) {
    console.error("[discord] send failed", e);
  }
}

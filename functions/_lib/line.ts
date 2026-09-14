import type { Env } from "./stripe";

const encoder = new TextEncoder();

export interface LineSource {
  type?: "user" | "group" | "room";
  userId?: string;
  groupId?: string;
  roomId?: string;
}

export interface LineMessage {
  id?: string;
  type?: string;
  text?: string;
  packageId?: string;
  stickerId?: string;
  fileName?: string;
  fileSize?: number;
  title?: string;
  address?: string;
  latitude?: number;
  longitude?: number;
}

export interface LineWebhookEvent {
  type?: string;
  timestamp?: number;
  webhookEventId?: string;
  source?: LineSource;
  message?: LineMessage;
}

export interface LineWebhookBody {
  destination?: string;
  events?: LineWebhookEvent[];
}

function decodeBase64(value: string): Uint8Array | null {
  try {
    const decoded = atob(value);
    return Uint8Array.from(decoded, (char) => char.charCodeAt(0));
  } catch {
    return null;
  }
}

/** 生の request body を使い、LINE の X-Line-Signature を検証する。 */
export async function verifyLineSignature(
  rawBody: string,
  signature: string,
  channelSecret: string,
): Promise<boolean> {
  const signatureBytes = decodeBase64(signature);
  if (!signatureBytes) return false;

  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(channelSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  return crypto.subtle.verify("HMAC", key, signatureBytes, encoder.encode(rawBody));
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(0, max - 1))}…`;
}

export function describeLineMessage(message: LineMessage): string {
  switch (message.type) {
    case "text":
      return message.text?.trim() || "（空のテキスト）";
    case "image":
      return "📷 画像を受信しました";
    case "video":
      return "🎥 動画を受信しました";
    case "audio":
      return "🎵 音声を受信しました";
    case "file":
      return `📎 ファイル: ${message.fileName || "名前不明"}${
        typeof message.fileSize === "number" ? ` (${message.fileSize.toLocaleString("ja-JP")} bytes)` : ""
      }`;
    case "location": {
      const heading = message.title || message.address || "位置情報";
      const coords =
        typeof message.latitude === "number" && typeof message.longitude === "number"
          ? `\n${message.latitude}, ${message.longitude}`
          : "";
      return `📍 ${heading}${coords}`;
    }
    case "sticker":
      return `スタンプを受信しました (package=${message.packageId || "?"}, sticker=${
        message.stickerId || "?"
      })`;
    default:
      return `メッセージを受信しました (type=${message.type || "unknown"})`;
  }
}

function profileEndpoint(source: LineSource): string | null {
  if (!source.userId) return null;
  const userId = encodeURIComponent(source.userId);
  if (source.type === "group" && source.groupId) {
    return `https://api.line.me/v2/bot/group/${encodeURIComponent(source.groupId)}/member/${userId}`;
  }
  if (source.type === "room" && source.roomId) {
    return `https://api.line.me/v2/bot/room/${encodeURIComponent(source.roomId)}/member/${userId}`;
  }
  return `https://api.line.me/v2/bot/profile/${userId}`;
}

async function getDisplayName(env: Env, source: LineSource): Promise<string | null> {
  if (!env.LINE_CHANNEL_ACCESS_TOKEN) return null;
  const endpoint = profileEndpoint(source);
  if (!endpoint) return null;

  try {
    const response = await fetch(endpoint, {
      headers: { authorization: `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}` },
    });
    if (!response.ok) {
      console.warn(`[line] profile lookup failed status=${response.status}`);
      return null;
    }
    const profile = (await response.json()) as { displayName?: string };
    return profile.displayName?.trim() || null;
  } catch (error) {
    console.warn("[line] profile lookup failed", error);
    return null;
  }
}

function sourceLabel(source: LineSource): string {
  switch (source.type) {
    case "group":
      return "グループ";
    case "room":
      return "複数人トーク";
    default:
      return "1対1トーク";
  }
}

/** 署名検証済みの message event 1件を Discord へ通知する。 */
export async function forwardLineMessageToDiscord(
  env: Env,
  event: LineWebhookEvent,
): Promise<void> {
  const webhookUrl = env.LINE_DISCORD_WEBHOOK_URL;
  if (!webhookUrl) throw new Error("LINE_DISCORD_WEBHOOK_URL is not configured");

  const source = event.source ?? {};
  const message = event.message ?? {};
  const displayName = await getDisplayName(env, source);
  const sender = displayName || source.userId || "不明";
  const fields = [
    { name: "送信者", value: truncate(sender, 1024), inline: true },
    { name: "種別", value: sourceLabel(source), inline: true },
  ];
  if (message.id) fields.push({ name: "Message ID", value: truncate(message.id, 1024), inline: false });

  const response = await fetch(webhookUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      username: "LINE受信通知",
      allowed_mentions: { parse: [] },
      embeds: [
        {
          title: "💬 LINE公式アカウントに新着メッセージ",
          description: truncate(describeLineMessage(message), 4096),
          color: 0x06c755,
          fields,
          timestamp: event.timestamp ? new Date(event.timestamp).toISOString() : new Date().toISOString(),
          footer: event.webhookEventId
            ? { text: `Webhook Event ID: ${truncate(event.webhookEventId, 1800)}` }
            : undefined,
        },
      ],
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "<no body>");
    throw new Error(`Discord webhook failed: ${response.status} ${truncate(body, 500)}`);
  }
}

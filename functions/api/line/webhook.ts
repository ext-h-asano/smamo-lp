import type { Env } from "../../_lib/stripe";
import {
  forwardLineMessageToDiscord,
  type LineWebhookBody,
  verifyLineSignature,
} from "../../_lib/line";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });

export const onRequestPost: PagesFunction<Env> = async ({ request, env, waitUntil }) => {
  if (!env.LINE_CHANNEL_SECRET) {
    console.error("[line] LINE_CHANNEL_SECRET is not configured");
    return json({ error: "webhook is not configured" }, 503);
  }

  const signature = request.headers.get("x-line-signature");
  if (!signature) return json({ error: "missing x-line-signature" }, 401);

  const rawBody = await request.text();
  if (!(await verifyLineSignature(rawBody, signature, env.LINE_CHANNEL_SECRET))) {
    return json({ error: "invalid signature" }, 401);
  }

  let body: LineWebhookBody;
  try {
    body = JSON.parse(rawBody) as LineWebhookBody;
  } catch {
    return json({ error: "invalid JSON" }, 400);
  }

  const messageEvents = (Array.isArray(body.events) ? body.events : []).filter(
    (event) => event?.type === "message" && event.message,
  );

  // LINE Developers の「検証」は events: [] を送るため、設定済みならそのまま 200。
  if (messageEvents.length === 0) return json({ received: true });
  if (!env.LINE_DISCORD_WEBHOOK_URL) {
    console.error("[line] LINE_DISCORD_WEBHOOK_URL is not configured");
    return json({ error: "notification destination is not configured" }, 503);
  }

  // LINE 推奨どおり受信はすぐ acknowledge し、外部 API 呼び出しはバックグラウンドで行う。
  waitUntil(
    Promise.allSettled(messageEvents.map((event) => forwardLineMessageToDiscord(env, event))).then(
      (results) => {
        results.forEach((result, index) => {
          const eventId = messageEvents[index]?.webhookEventId || "unknown";
          if (result.status === "rejected") {
            console.error(`[line] Discord forwarding failed event=${eventId}`, result.reason);
          } else {
            console.log(`[line] Discord forwarding succeeded event=${eventId}`);
          }
        });
      },
    ),
  );

  return json({ received: true });
};

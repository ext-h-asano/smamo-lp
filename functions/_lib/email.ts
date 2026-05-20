/**
 * Resend API 経由の transactional email 送信ラッパー。
 *
 * - RESEND_API_KEY 未設定なら警告ログだけ吐いて no-op (本番事故防止)
 * - Idempotency-Key で再送による重複送信を防ぐ (Stripe webhook 再配信対策)
 */
export interface SendEmailParams {
  to: string;
  subject: string;
  html: string;
  text?: string;
  idempotencyKey?: string;
  from?: string;
  replyTo?: string;
}

const DEFAULT_FROM = "SMAMO <noreply@smamo.jp>";
const DEFAULT_REPLY_TO = "support@smamo.jp";

export async function sendEmail(
  apiKey: string | undefined,
  params: SendEmailParams,
): Promise<{ ok: boolean; id?: string; error?: string }> {
  if (!apiKey) {
    console.warn(`[email] RESEND_API_KEY 未設定のためスキップ: to=${params.to} subject="${params.subject}"`);
    return { ok: false, error: "RESEND_API_KEY not configured" };
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
    "content-type": "application/json",
  };
  if (params.idempotencyKey) {
    headers["Idempotency-Key"] = params.idempotencyKey;
  }

  const resp = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers,
    body: JSON.stringify({
      from: params.from ?? DEFAULT_FROM,
      to: [params.to],
      subject: params.subject,
      html: params.html,
      text: params.text,
      reply_to: params.replyTo ?? DEFAULT_REPLY_TO,
    }),
  });

  const body = (await resp.json()) as { id?: string; message?: string };
  if (!resp.ok) {
    console.error(`[email] send failed (${resp.status}): ${body.message ?? JSON.stringify(body)}`);
    return { ok: false, error: body.message ?? `${resp.status}` };
  }
  console.log(`[email] sent id=${body.id} to=${params.to}`);
  return { ok: true, id: body.id };
}

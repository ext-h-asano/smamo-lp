import { Env } from "../_lib/stripe";
import { sendEmail } from "../_lib/email";

// 法人LP (/b2b/) の導入相談フォーム。元は contact-form.php だったものを Pages Function に移植。
// フォームは通常の POST (application/x-www-form-urlencoded) で来て、成功時は thanks へ 303。
// 二重送信は Resend の Idempotency-Key（入力内容のハッシュ）で弾く。

const SITE = "SMAMO（スマモ）";
const ADMIN_EMAILS = ["info@ext.cx", "kato@ext.cx"];
const FROM = `${SITE} <noreply@smamo.jp>`;
const REPLY_TO = "info@ext.cx";
const THANKS_URL = "/b2b/contact-thanks.html";

const FIELDS = { company: 200, name: 100, email: 254, tel: 30, message: 5000, privacy: 10 } as const;
type Field = keyof typeof FIELDS;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

function failForm(message: string, status = 422): Response {
  const html = `<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>送信内容の確認 | SMAMO</title><link rel="stylesheet" href="/b2b/css/style.css"><body><main class="consultation-section"><div class="container consultation-inner"><h1>送信を完了できませんでした</h1><p style="margin:24px 0" role="alert">${escapeHtml(message)}</p><p>ブラウザの「戻る」で入力内容を確認して、再度お試しください。</p><p><a href="/b2b/#contact">相談フォームへ戻る</a></p></div></main></body></html>`;
  return new Response(html, {
    status,
    headers: { "content-type": "text/html; charset=UTF-8", "cache-control": "no-store" },
  });
}

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function textToHtml(s: string): string {
  return `<pre style="font-family:inherit;white-space:pre-wrap">${escapeHtml(s)}</pre>`;
}

export const onRequestGet: PagesFunction<Env> = async () =>
  new Response(null, { status: 303, headers: { location: "/b2b/#contact" } });

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return failForm("入力内容をご確認ください。");
  }

  const text = (key: string, max: number): string | null => {
    const raw = form.get(key) ?? "";
    if (typeof raw !== "string" || raw.includes("\0")) return null;
    const v = raw.replace(/\r\n?/g, "\n").trim();
    return [...v].length > max ? null : v;
  };

  if (text("website", 200) !== "") return failForm("送信内容を確認できませんでした。");

  const data = {} as Record<Field, string>;
  for (const [key, max] of Object.entries(FIELDS) as [Field, number][]) {
    const v = text(key, max);
    if (v === null) return failForm("入力文字数が上限を超えています。");
    data[key] = v;
  }
  if (!data.company || !data.name) return failForm("会社名とお名前を入力してください。");
  if (!EMAIL_RE.test(data.email) || /[\r\n]/.test(data.email)) return failForm("正しいメールアドレスを入力してください。");
  if (data.privacy !== "agree") return failForm("プライバシーポリシーへの同意が必要です。");

  const summary =
    `会社名：${data.company}\nお名前：${data.name}\nメールアドレス：${data.email}\n` +
    `電話番号：${data.tel || "未入力"}\n\nご相談内容：\n${data.message || "未入力"}\n`;
  const fingerprint = await sha256Hex(JSON.stringify(data));

  const adminText = `${SITE}のLPから導入相談がありました。\n\n${summary}`;
  for (const to of ADMIN_EMAILS) {
    const r = await sendEmail(env.RESEND_API_KEY, {
      to,
      from: FROM,
      replyTo: data.email,
      subject: `【${SITE}】導入相談のお問い合わせ`,
      text: adminText,
      html: textToHtml(adminText),
      idempotencyKey: `b2b-contact-admin-${to}-${fingerprint}`,
    });
    if (!r.ok) return failForm("メール送信に失敗しました。時間をおいて再度お試しください。", 503);
  }

  const replyText =
    `${data.company}\n${data.name} 様\n\nこの度は${SITE}の導入についてお問い合わせいただき、誠にありがとうございます。\n` +
    `以下の内容でご相談を受け付けました。\n\n内容を確認のうえ、担当者より改めてご連絡いたします。\n` +
    `恐れ入りますが、ご案内まで今しばらくお待ちくださいますようお願い申し上げます。\n\n【お問い合わせ内容】\n${summary}\n` +
    `このメールは、お問い合わせの受付時に自動送信しています。\nお心当たりのない場合は、お手数ですが本メールへの返信にてお知らせください。\n\n` +
    `-----------------------------------\n${SITE}\n運営会社：株式会社ext\n-----------------------------------\n`;
  const reply = await sendEmail(env.RESEND_API_KEY, {
    to: data.email,
    from: FROM,
    replyTo: REPLY_TO,
    subject: `【${SITE}】導入相談を受け付けました`,
    text: replyText,
    html: textToHtml(replyText),
    idempotencyKey: `b2b-contact-reply-${fingerprint}`,
  });
  if (!reply.ok) {
    return failForm(
      "ご相談は担当者へ送信されましたが、自動返信メールを送信できませんでした。入力内容を変えずに再送信すると、自動返信のみを再試行します。",
      503,
    );
  }

  return new Response(null, { status: 303, headers: { location: THANKS_URL, "cache-control": "no-store" } });
};

interface WelcomeEmailVars {
  name?: string | null;
  email: string;
  planLabel: string;
  trialEndDate: string;
  firstChargeAmount: number;
  portalUrl?: string;
}

const APP_DOWNLOAD_LINK = "https://smamo.jp/#download";

function escape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function welcomeEmail(vars: WelcomeEmailVars): { subject: string; html: string; text: string } {
  const greeting = vars.name && vars.name.trim() !== "" ? `${escape(vars.name)} 様` : "お客様";
  const subject = "SMAMO へようこそ — 3 日間の無料体験を開始しました";

  const text = `
${vars.name && vars.name.trim() !== "" ? `${vars.name} 様` : "SMAMO をご利用のお客様"}

このたびは SMAMO へお申し込みいただきありがとうございます。
3 日間の無料体験を開始しました。

【お申し込み内容】
プラン: ${vars.planLabel}
登録メール: ${vars.email}
無料体験終了日: ${vars.trialEndDate}
初回お支払い (税込): ¥${vars.firstChargeAmount.toLocaleString("ja-JP")}

【アプリのダウンロード】
お手持ちのスマートフォンに SMAMO アプリをインストールし、
登録したメールアドレスとパスワードでログインしてご利用ください。
${APP_DOWNLOAD_LINK}

【サブスクリプションの管理】
お支払い方法の変更や解約はアプリ内の「設定 > ご解約について」から
いつでもセルフサービスで行えます。

何かご不明な点は support@smamo.jp までお気軽にお問い合わせください。

— SMAMO サポート
https://smamo.jp/
`.trim();

  const html = `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(subject)}</title>
</head>
<body style="margin:0;padding:0;background:#f5f6f8;font-family:-apple-system,BlinkMacSystemFont,'Hiragino Sans','Yu Gothic UI',sans-serif;color:#1f2937;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f5f6f8;padding:32px 0;">
    <tr><td align="center">
      <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.06);">
        <tr><td style="padding:32px 40px 16px;">
          <div style="font-size:14px;letter-spacing:0.06em;color:#0a84ff;font-weight:600;">SMAMO</div>
          <h1 style="margin:8px 0 0;font-size:22px;line-height:1.4;color:#111827;">SMAMO へようこそ</h1>
        </td></tr>
        <tr><td style="padding:8px 40px 24px;font-size:15px;line-height:1.7;color:#374151;">
          <p style="margin:0 0 16px;">${greeting}</p>
          <p style="margin:0 0 16px;">このたびは SMAMO へお申し込みいただきありがとうございます。<strong>3 日間の無料体験</strong>を開始しました。</p>
        </td></tr>
        <tr><td style="padding:0 40px 24px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;">
            <tr><td style="padding:16px 20px;font-size:14px;color:#374151;">
              <div style="font-weight:600;color:#111827;margin-bottom:8px;">お申し込み内容</div>
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                <tr><td style="padding:4px 0;color:#6b7280;width:40%;">プラン</td><td style="padding:4px 0;">${escape(vars.planLabel)}</td></tr>
                <tr><td style="padding:4px 0;color:#6b7280;">登録メール</td><td style="padding:4px 0;">${escape(vars.email)}</td></tr>
                <tr><td style="padding:4px 0;color:#6b7280;">無料体験終了日</td><td style="padding:4px 0;">${escape(vars.trialEndDate)}</td></tr>
                <tr><td style="padding:4px 0;color:#6b7280;">初回お支払い (税込)</td><td style="padding:4px 0;"><strong>¥${vars.firstChargeAmount.toLocaleString("ja-JP")}</strong></td></tr>
              </table>
            </td></tr>
          </table>
        </td></tr>
        <tr><td style="padding:0 40px 24px;font-size:15px;line-height:1.7;color:#374151;">
          <h2 style="margin:0 0 8px;font-size:16px;color:#111827;">アプリのダウンロード</h2>
          <p style="margin:0 0 12px;">お手持ちのスマートフォンに SMAMO アプリをインストールし、登録したメールアドレスとパスワードでログインしてご利用ください。</p>
          <p style="margin:0;"><a href="${APP_DOWNLOAD_LINK}" style="display:inline-block;background:#0a84ff;color:#ffffff;text-decoration:none;padding:12px 24px;border-radius:24px;font-weight:600;">アプリをダウンロード</a></p>
        </td></tr>
        <tr><td style="padding:0 40px 24px;font-size:14px;line-height:1.7;color:#6b7280;">
          <h2 style="margin:0 0 8px;font-size:16px;color:#111827;">サブスクリプションの管理</h2>
          <p style="margin:0;">お支払い方法の変更や解約はアプリ内の「設定 → ご解約について」からいつでもセルフサービスで行えます。</p>
        </td></tr>
        <tr><td style="padding:24px 40px 32px;border-top:1px solid #e5e7eb;font-size:12px;color:#9ca3af;line-height:1.7;">
          何かご不明な点は <a href="mailto:support@smamo.jp" style="color:#0a84ff;text-decoration:none;">support@smamo.jp</a> までお問い合わせください。<br>
          — SMAMO サポート<br>
          <a href="https://smamo.jp/" style="color:#9ca3af;">https://smamo.jp/</a>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

  return { subject, html, text };
}

export function waitlistRegisteredEmail(args: { name?: string | null; email: string }): {
  subject: string; html: string; text: string;
} {
  const greeting = args.name ? `${args.name} 様` : "お客様";
  const subject = "【SMAMO】順番待ちに登録しました（料金は発生しません）";
  const text = [
    `${greeting}`,
    "",
    "この度はお申し込みありがとうございます。",
    "現在ご利用枠が満員のため、順番待ちに登録いたしました。",
    "デバイスのご用意ができ次第、改めてご案内メールをお送りします。",
    "",
    "■ ご安心ください：割り当てが完了するまで料金は一切発生しません。",
    "（無料体験・ご請求はデバイスをご用意できた時点から開始します）",
    "",
    "SMAMO サポート",
  ].join("\n");
  const html = `<p>${greeting}</p>
<p>この度はお申し込みありがとうございます。<br>
現在ご利用枠が満員のため、<b>順番待ち</b>に登録いたしました。デバイスのご用意ができ次第、改めてご案内メールをお送りします。</p>
<p><b>ご安心ください：割り当てが完了するまで料金は一切発生しません。</b><br>
（無料体験・ご請求はデバイスをご用意できた時点から開始します）</p>
<p>SMAMO サポート</p>`;
  return { subject, html, text };
}

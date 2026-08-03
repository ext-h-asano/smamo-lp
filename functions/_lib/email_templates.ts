interface WelcomeEmailVars {
  name?: string | null;
  email: string;
  planLabel: string;
  trialEndDate: string;
  firstChargeAmount: number;
  portalUrl?: string;
}

const APP_DOWNLOAD_IOS = "https://apps.apple.com/jp/app/simple%E9%9B%BB%E5%8D%93/id6742208241";
const APP_DOWNLOAD_ANDROID = "https://play.google.com/store/apps/details?id=cx.ext.smamo";
const QR_IOS_IMG = "https://smamo.jp/img/qr-ios.png";
const QR_ANDROID_IMG = "https://smamo.jp/img/qr-android.png";
const LINE_SUPPORT_URL = "https://line.me/R/ti/p/@808icbev";
const LINE_SUPPORT_QR_IMG = "https://qr-official.line.me/gs/M_808icbev_GW.png?oat_content=qr";

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
（ストアでは「計算機」等の名称で表示されます）

iOS (App Store):
${APP_DOWNLOAD_IOS}

Android (Google Play):
${APP_DOWNLOAD_ANDROID}

【サブスクリプションの管理】
お支払い方法の変更や解約はアプリ内の「設定 > ご解約について」から
いつでもセルフサービスで行えます。

【お問い合わせ】
LINE公式アカウントでもサポートしています。
${LINE_SUPPORT_URL}

メール: support@smamo.jp

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
          <p style="margin:0 0 16px;">お手持ちのスマートフォンに SMAMO アプリをインストールし、登録したメールアドレスとパスワードでログインしてご利用ください。<br><span style="color:#6b7280;font-size:13px;">※ストアでは「計算機」等の名称で表示されます。</span></p>
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
            <tr>
              <td width="50%" valign="top" style="padding:0 8px 0 0;">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:10px;">
                  <tr><td align="center" style="padding:16px 12px 8px;font-size:13px;font-weight:700;color:#111827;">iOS / App Store</td></tr>
                  <tr><td align="center" style="padding:0 12px 12px;">
                    <img src="${QR_IOS_IMG}" width="120" height="120" alt="App Store QR" style="display:block;border:0;border-radius:8px;">
                  </td></tr>
                  <tr><td align="center" style="padding:0 12px 16px;">
                    <a href="${APP_DOWNLOAD_IOS}" style="display:inline-block;background:#0a84ff;color:#ffffff;text-decoration:none;padding:10px 16px;border-radius:20px;font-weight:600;font-size:13px;">App Store</a>
                  </td></tr>
                </table>
              </td>
              <td width="50%" valign="top" style="padding:0 0 0 8px;">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:10px;">
                  <tr><td align="center" style="padding:16px 12px 8px;font-size:13px;font-weight:700;color:#111827;">Android / Google Play</td></tr>
                  <tr><td align="center" style="padding:0 12px 12px;">
                    <img src="${QR_ANDROID_IMG}" width="120" height="120" alt="Google Play QR" style="display:block;border:0;border-radius:8px;">
                  </td></tr>
                  <tr><td align="center" style="padding:0 12px 16px;">
                    <a href="${APP_DOWNLOAD_ANDROID}" style="display:inline-block;background:#34a853;color:#ffffff;text-decoration:none;padding:10px 16px;border-radius:20px;font-weight:600;font-size:13px;">Google Play</a>
                  </td></tr>
                </table>
              </td>
            </tr>
          </table>
          <p style="margin:16px 0 0;font-size:13px;color:#6b7280;">パソコンから見ている場合は、上の QR コードをスマートフォンで読み取ってインストールできます。</p>
        </td></tr>
        <tr><td style="padding:0 40px 24px;font-size:14px;line-height:1.7;color:#6b7280;">
          <h2 style="margin:0 0 8px;font-size:16px;color:#111827;">サブスクリプションの管理</h2>
          <p style="margin:0;">お支払い方法の変更や解約はアプリ内の「設定 → ご解約について」からいつでもセルフサービスで行えます。</p>
        </td></tr>
        <tr><td style="padding:0 40px 24px;font-size:15px;line-height:1.7;color:#374151;">
          <h2 style="margin:0 0 8px;font-size:16px;color:#111827;">お問い合わせ</h2>
          <p style="margin:0 0 16px;">ご不明な点は LINE 公式アカウント、またはメールでお気軽にご連絡ください。</p>
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:10px;">
            <tr>
              <td align="center" style="padding:20px 16px;">
                <img src="${LINE_SUPPORT_QR_IMG}" width="120" height="120" alt="LINE公式アカウント QR" style="display:block;border:0;border-radius:8px;background:#ffffff;">
                <p style="margin:12px 0 14px;font-size:13px;color:#166534;">QRコードを読み取って友だち追加</p>
                <a href="${LINE_SUPPORT_URL}" style="display:inline-block;background:#06C755;color:#ffffff;text-decoration:none;padding:12px 22px;border-radius:24px;font-weight:700;font-size:14px;">LINEでお問い合わせ</a>
                <p style="margin:14px 0 0;font-size:13px;color:#6b7280;">メール: <a href="mailto:support@smamo.jp" style="color:#0a84ff;text-decoration:none;">support@smamo.jp</a></p>
              </td>
            </tr>
          </table>
        </td></tr>
        <tr><td style="padding:24px 40px 32px;border-top:1px solid #e5e7eb;font-size:12px;color:#9ca3af;line-height:1.7;">
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

// ================= 共通ヘルパー (課金ライフサイクル系メール用) =================

/** unix 秒 → "2026年7月9日 14:30" (JST) */
export function formatJstDateTime(tsSec: number): string {
  return new Date(tsSec * 1000).toLocaleString("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** unix 秒 → "2026年7月9日" (JST) */
export function formatJstDate(tsSec: number): string {
  return new Date(tsSec * 1000).toLocaleDateString("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

/** welcomeEmail と同一トーンの HTML 外枠。bodyHtml は呼び出し側で組み立てる */
function renderEmailShell(args: { subject: string; heading: string; bodyHtml: string }): string {
  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(args.subject)}</title>
</head>
<body style="margin:0;padding:0;background:#f5f6f8;font-family:-apple-system,BlinkMacSystemFont,'Hiragino Sans','Yu Gothic UI',sans-serif;color:#1f2937;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f5f6f8;padding:32px 0;">
    <tr><td align="center">
      <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.06);">
        <tr><td style="padding:32px 40px 16px;">
          <div style="font-size:14px;letter-spacing:0.06em;color:#0a84ff;font-weight:600;">SMAMO</div>
          <h1 style="margin:8px 0 0;font-size:22px;line-height:1.4;color:#111827;">${escape(args.heading)}</h1>
        </td></tr>
        <tr><td style="padding:8px 40px 24px;font-size:15px;line-height:1.7;color:#374151;">
          ${args.bodyHtml}
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
}

/** グレー枠の明細ボックス。values は呼び出し側で escape 済み HTML を渡す */
function infoBox(title: string, rows: Array<[string, string]>): string {
  const tr = rows
    .map(
      ([k, v]) =>
        `<tr><td style="padding:4px 0;color:#6b7280;width:40%;">${escape(k)}</td><td style="padding:4px 0;">${v}</td></tr>`,
    )
    .join("");
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;margin:0 0 16px;"><tr><td style="padding:16px 20px;font-size:14px;color:#374151;"><div style="font-weight:600;color:#111827;margin-bottom:8px;">${escape(title)}</div><table role="presentation" width="100%" cellpadding="0" cellspacing="0">${tr}</table></td></tr></table>`;
}

function greetingOf(name?: string | null): string {
  return name && name.trim() !== "" ? `${name} 様` : "お客様";
}

// ================= ① トライアル終了 24h 前リマインダー =================

interface TrialReminderVars {
  name?: string | null;
  deviceName?: string | null;
  planLabel: string;
  /** JST 整形済み。例 "2026年7月9日 14:30" */
  trialEndAt: string;
  /** 税込 JPY */
  amount: number;
}

export function trialReminderEmail(vars: TrialReminderVars): { subject: string; html: string; text: string } {
  const greeting = greetingOf(vars.name);
  const device = vars.deviceName && vars.deviceName.trim() !== "" ? vars.deviceName : "-";
  const amountStr = `¥${vars.amount.toLocaleString("ja-JP")}`;
  const subject = "【SMAMO】無料体験はまもなく終了します（初回お支払いのご案内）";

  const text = `
${greeting}

SMAMO をご利用いただきありがとうございます。
お客様の 3 日間無料体験は ${vars.trialEndAt} に終了します。

【初回のお支払い】
対象デバイス: ${device}
プラン: ${vars.planLabel}
初回お支払い (税込): ${amountStr}
お支払い日: ${vars.trialEndAt}（無料体験終了後、ご登録のカードに自動で請求されます）

このまま継続される場合、お手続きは不要です。

継続をご希望でない場合は、無料体験終了までにアプリ内の
「設定 > ご解約について」から解約のお手続きをお願いします。
解約後も無料体験の終了までは引き続きご利用いただけます。

ご不明な点は support@smamo.jp までお気軽にお問い合わせください。

— SMAMO サポート
https://smamo.jp/
`.trim();

  const bodyHtml = `
          <p style="margin:0 0 16px;">${escape(greeting)}</p>
          <p style="margin:0 0 16px;">SMAMO をご利用いただきありがとうございます。<br>お客様の 3 日間無料体験は <strong>${escape(vars.trialEndAt)}</strong> に終了します。</p>
          ${infoBox("初回のお支払い", [
            ["対象デバイス", escape(device)],
            ["プラン", escape(vars.planLabel)],
            ["初回お支払い (税込)", `<strong>${escape(amountStr)}</strong>`],
            ["お支払い日", escape(vars.trialEndAt)],
          ])}
          <p style="margin:0 0 16px;">無料体験終了後、ご登録のカードに自動で請求されます。<br><strong>このまま継続される場合、お手続きは不要です。</strong></p>
          <p style="margin:0;">継続をご希望でない場合は、無料体験終了までにアプリ内の「設定 → ご解約について」から解約のお手続きをお願いします。解約後も無料体験の終了までは引き続きご利用いただけます。</p>`;

  return { subject, html: renderEmailShell({ subject, heading: "無料体験はまもなく終了します", bodyHtml }), text };
}

// ================= ② 決済失敗 (dunning) =================

interface PaymentFailedVars {
  name?: string | null;
  deviceName?: string | null;
  planLabel: string;
  /** 税込 JPY (invoice.amount_due) */
  amount: number;
}

export function paymentFailedEmail(vars: PaymentFailedVars): { subject: string; html: string; text: string } {
  const greeting = greetingOf(vars.name);
  const device = vars.deviceName && vars.deviceName.trim() !== "" ? vars.deviceName : "-";
  const amountStr = `¥${vars.amount.toLocaleString("ja-JP")}`;
  const subject = "【SMAMO】お支払いに失敗しました — カード情報のご確認をお願いします";

  const text = `
${greeting}

SMAMO のご利用料金のお支払いに失敗しました。

対象デバイス: ${device}
プラン: ${vars.planLabel}
請求金額 (税込): ${amountStr}

ご登録のカードの有効期限・利用限度額などをご確認のうえ、
アプリ内の「設定 > ご解約について」（お支払い方法の変更も
こちらから行えます）からカード情報の更新をお願いします。

お支払いは数日以内に自動で再試行されます。
お支払いが確認できない状態が続いた場合、サービスのご利用を
停止させていただくことがあります。

ご不明な点は support@smamo.jp までお気軽にお問い合わせください。

— SMAMO サポート
https://smamo.jp/
`.trim();

  const bodyHtml = `
          <p style="margin:0 0 16px;">${escape(greeting)}</p>
          <p style="margin:0 0 16px;">SMAMO のご利用料金のお支払いに失敗しました。</p>
          ${infoBox("ご請求内容", [
            ["対象デバイス", escape(device)],
            ["プラン", escape(vars.planLabel)],
            ["請求金額 (税込)", `<strong>${escape(amountStr)}</strong>`],
          ])}
          <p style="margin:0 0 16px;">ご登録のカードの有効期限・利用限度額などをご確認のうえ、アプリ内の「設定 → ご解約について」（お支払い方法の変更もこちらから行えます）からカード情報の更新をお願いします。</p>
          <p style="margin:0;">お支払いは数日以内に自動で再試行されます。お支払いが確認できない状態が続いた場合、サービスのご利用を停止させていただくことがあります。</p>`;

  return { subject, html: renderEmailShell({ subject, heading: "お支払いに失敗しました", bodyHtml }), text };
}

// ================= ③ 解約受付確認 =================

interface CancelConfirmVars {
  name?: string | null;
  deviceName?: string | null;
  planLabel: string;
  /** JST 整形済み。例 "2026年8月8日" */
  periodEndDate: string;
}

export function cancelConfirmEmail(vars: CancelConfirmVars): { subject: string; html: string; text: string } {
  const greeting = greetingOf(vars.name);
  const device = vars.deviceName && vars.deviceName.trim() !== "" ? vars.deviceName : "-";
  const subject = "【SMAMO】解約を受け付けました";

  const text = `
${greeting}

SMAMO の解約のお手続きを受け付けました。

対象デバイス: ${device}
プラン: ${vars.planLabel}
ご利用期限: ${vars.periodEndDate}

${vars.periodEndDate} までは引き続きサービスをご利用いただけます。
それ以降のご請求はありません。

解約の取り消しをご希望の場合は、ご利用期限までにアプリ内の
「設定 > ご解約について」からお手続きいただくか、
support@smamo.jp までご連絡ください。

これまでのご利用ありがとうございました。
ご不明な点は support@smamo.jp までお気軽にお問い合わせください。

— SMAMO サポート
https://smamo.jp/
`.trim();

  const bodyHtml = `
          <p style="margin:0 0 16px;">${escape(greeting)}</p>
          <p style="margin:0 0 16px;">SMAMO の解約のお手続きを受け付けました。</p>
          ${infoBox("解約内容", [
            ["対象デバイス", escape(device)],
            ["プラン", escape(vars.planLabel)],
            ["ご利用期限", `<strong>${escape(vars.periodEndDate)}</strong>`],
          ])}
          <p style="margin:0 0 16px;"><strong>${escape(vars.periodEndDate)}</strong> までは引き続きサービスをご利用いただけます。それ以降のご請求はありません。</p>
          <p style="margin:0;">解約の取り消しをご希望の場合は、ご利用期限までにアプリ内の「設定 → ご解約について」からお手続きいただくか、<a href="mailto:support@smamo.jp" style="color:#0a84ff;">support@smamo.jp</a> までご連絡ください。これまでのご利用ありがとうございました。</p>`;

  return { subject, html: renderEmailShell({ subject, heading: "解約を受け付けました", bodyHtml }), text };
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

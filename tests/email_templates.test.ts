import { describe, it, expect } from "vitest";
import {
  trialReminderEmail,
  paymentFailedEmail,
  cancelConfirmEmail,
  formatJstDateTime,
  formatJstDate,
} from "../functions/_lib/email_templates";

describe("formatJst*", () => {
  // 1783522800 = 2026-07-08T15:00:00Z = 2026-07-09 00:00 JST
  it("formats unix seconds in JST (date crosses midnight)", () => {
    expect(formatJstDate(1783522800)).toContain("2026年7月9日");
    const dt = formatJstDateTime(1783522800);
    expect(dt).toContain("2026年7月9日");
    expect(dt).toMatch(/0?0:00/);
  });
});

describe("trialReminderEmail", () => {
  const tmpl = trialReminderEmail({
    name: "山田 太郎",
    deviceName: "device1",
    planLabel: "SMAMO 月額プラン",
    trialEndAt: "2026年7月9日 14:30",
    amount: 3278,
  });
  it("subject", () => {
    expect(tmpl.subject).toBe("【SMAMO】無料体験はまもなく終了します（初回お支払いのご案内）");
  });
  it("text contains key facts", () => {
    expect(tmpl.text).toContain("山田 太郎 様");
    expect(tmpl.text).toContain("2026年7月9日 14:30 に終了します");
    expect(tmpl.text).toContain("¥3,278");
    expect(tmpl.text).toContain("対象デバイス: device1");
    expect(tmpl.text).toContain("設定 > ご解約について");
    expect(tmpl.text).toContain("お手続きは不要です");
  });
  it("html contains facts", () => {
    expect(tmpl.html).toContain("¥3,278");
    expect(tmpl.html).toContain("山田 太郎 様");
    expect(tmpl.html).toContain("SMAMO 月額プラン");
  });
  it("falls back when name/device missing", () => {
    const t = trialReminderEmail({ name: null, deviceName: null, planLabel: "SMAMO 月額プラン", trialEndAt: "2026年7月9日 14:30", amount: 3278 });
    expect(t.text).toContain("お客様");
    expect(t.text).toContain("対象デバイス: -");
  });
  it("escapes html", () => {
    const t = trialReminderEmail({ name: "<b>x</b>", deviceName: "<script>", planLabel: "p", trialEndAt: "t", amount: 1 });
    expect(t.html).not.toContain("<script>");
    expect(t.html).toContain("&lt;script&gt;");
  });
});

describe("paymentFailedEmail", () => {
  const tmpl = paymentFailedEmail({
    name: "山田 太郎",
    deviceName: "device1",
    planLabel: "SMAMO 月額プラン",
    amount: 3278,
  });
  it("subject", () => {
    expect(tmpl.subject).toBe("【SMAMO】お支払いに失敗しました — カード情報のご確認をお願いします");
  });
  it("text contains key facts", () => {
    expect(tmpl.text).toContain("お支払いに失敗しました");
    expect(tmpl.text).toContain("¥3,278");
    expect(tmpl.text).toContain("自動で再試行されます");
    expect(tmpl.text).toContain("設定 > ご解約について");
    expect(tmpl.text).toContain("停止させていただくことがあります");
  });
});

describe("cancelConfirmEmail", () => {
  const tmpl = cancelConfirmEmail({
    name: "山田 太郎",
    deviceName: "device1",
    planLabel: "SMAMO 月額プラン",
    periodEndDate: "2026年8月8日",
  });
  it("subject", () => {
    expect(tmpl.subject).toBe("【SMAMO】解約を受け付けました");
  });
  it("text contains key facts", () => {
    expect(tmpl.text).toContain("解約のお手続きを受け付けました");
    expect(tmpl.text).toContain("ご利用期限: 2026年8月8日");
    expect(tmpl.text).toContain("それ以降のご請求はありません");
  });
});

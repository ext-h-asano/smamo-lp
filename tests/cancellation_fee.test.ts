import { describe, it, expect } from "vitest";
import { calculateCancellationFee } from "../functions/_lib/cancellation_fee";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 7, 10);
const inDays = (n: number) => new Date(NOW + n * DAY).toISOString();

describe("calculateCancellationFee", () => {
  it("2年プラン途中なら 残月数 × プラン月額 を請求する", () => {
    // 300日残 = ceil(300/30) = 10ヶ月
    const r = calculateCancellationFee({
      planKey: "two_year",
      committedUntilIso: inDays(300),
      unitAmounts: [6028],
      nowMs: NOW,
    });
    expect(r.remainingMonths).toBe(10);
    expect(r.amount).toBe(10 * 6028);
  });

  it("SMS オプションが併存しても最大額＝プラン本体を単価に使う", () => {
    const r = calculateCancellationFee({
      planKey: "two_year",
      committedUntilIso: inDays(300),
      unitAmounts: [550, 6028],
      nowMs: NOW,
    });
    expect(r.amount).toBe(10 * 6028);
  });

  it("単価が取れない場合は ¥5,478 にフォールバックする", () => {
    const r = calculateCancellationFee({
      planKey: "two_year",
      committedUntilIso: inDays(300),
      unitAmounts: [],
      nowMs: NOW,
    });
    expect(r.amount).toBe(10 * 5478);
  });

  it("端数は月単位で切り上げる", () => {
    const r = calculateCancellationFee({
      planKey: "two_year",
      committedUntilIso: inDays(1),
      unitAmounts: [6028],
      nowMs: NOW,
    });
    expect(r.remainingMonths).toBe(1);
    expect(r.amount).toBe(6028);
  });

  it("2年プラン以外は手数料なし", () => {
    for (const planKey of ["monthly", "yearly", null, undefined]) {
      const r = calculateCancellationFee({
        planKey,
        committedUntilIso: inDays(300),
        unitAmounts: [6028],
        nowMs: NOW,
      });
      expect(r.amount).toBe(0);
      expect(r.remainingMonths).toBe(0);
    }
  });

  it("拘束期間を過ぎていれば手数料なし", () => {
    const r = calculateCancellationFee({
      planKey: "two_year",
      committedUntilIso: inDays(-1),
      unitAmounts: [6028],
      nowMs: NOW,
    });
    expect(r.amount).toBe(0);
    expect(r.remainingMonths).toBe(0);
  });

  it("committed_until が無ければ手数料なし", () => {
    const r = calculateCancellationFee({
      planKey: "two_year",
      committedUntilIso: null,
      unitAmounts: [6028],
      nowMs: NOW,
    });
    expect(r.amount).toBe(0);
  });
});

import { describe, it, expect } from "vitest";
import {
  firstChargeAmountForSubscription,
  firstChargeAmountJpy,
  isInitialFeeWaiverCode,
  isSubscriptionInitialFeeWaived,
  parseWaiverCodes,
} from "../functions/_lib/initial_fee";

describe("parseWaiverCodes", () => {
  it("未設定・空文字なら空集合", () => {
    expect(parseWaiverCodes(undefined).size).toBe(0);
    expect(parseWaiverCodes(null).size).toBe(0);
    expect(parseWaiverCodes("").size).toBe(0);
    expect(parseWaiverCodes("   ").size).toBe(0);
  });

  it("カンマ区切りを trim + 大文字化して取り込む", () => {
    const codes = parseWaiverCodes(" p-9a22db44 , OTHER-CODE ");
    expect([...codes].sort()).toEqual(["OTHER-CODE", "P-9A22DB44"]);
  });

  it("空要素は無視する", () => {
    const codes = parseWaiverCodes("P-9A22DB44,,  ,");
    expect([...codes]).toEqual(["P-9A22DB44"]);
  });
});

describe("isInitialFeeWaiverCode", () => {
  const env = "P-9A22DB44";

  it("パビオ本体のコードは免除対象", () => {
    expect(isInitialFeeWaiverCode("P-9A22DB44", env)).toBe(true);
  });

  it("大文字小文字・前後空白を吸収する", () => {
    expect(isInitialFeeWaiverCode("  p-9a22db44 ", env)).toBe(true);
  });

  it("パビオ配下の子代理店コードは免除対象外", () => {
    expect(isInitialFeeWaiverCode("TESTKO", env)).toBe(false);
    expect(isInitialFeeWaiverCode("AAA", env)).toBe(false);
  });

  it("他代理店のコードは免除対象外", () => {
    expect(isInitialFeeWaiverCode("E2E-DEMO-A", env)).toBe(false);
    expect(isInitialFeeWaiverCode("TEST1234", env)).toBe(false);
  });

  it("コード未入力は免除対象外", () => {
    expect(isInitialFeeWaiverCode("", env)).toBe(false);
    expect(isInitialFeeWaiverCode("   ", env)).toBe(false);
  });

  it("環境変数が未設定なら誰も免除しない（安全側の既定値）", () => {
    expect(isInitialFeeWaiverCode("P-9A22DB44", undefined)).toBe(false);
    expect(isInitialFeeWaiverCode("P-9A22DB44", "")).toBe(false);
  });

  it("複数コードを設定すればいずれも免除対象", () => {
    const multi = "P-9A22DB44, P-OTHER";
    expect(isInitialFeeWaiverCode("P-OTHER", multi)).toBe(true);
    expect(isInitialFeeWaiverCode("P-9A22DB44", multi)).toBe(true);
    expect(isInitialFeeWaiverCode("TESTKO", multi)).toBe(false);
  });
});

describe("isSubscriptionInitialFeeWaived", () => {
  it("checkout が書き込む invitation_code を免除として扱う", () => {
    expect(isSubscriptionInitialFeeWaived({ initial_fee_waived: "invitation_code" })).toBe(true);
  });

  it("メタデータが無ければ免除しない", () => {
    expect(isSubscriptionInitialFeeWaived(undefined)).toBe(false);
    expect(isSubscriptionInitialFeeWaived(null)).toBe(false);
    expect(isSubscriptionInitialFeeWaived({})).toBe(false);
    expect(isSubscriptionInitialFeeWaived({ initial_fee_waived: "" })).toBe(false);
  });

  // 実際の課金は Stripe の invoice item の有無で決まり、それを記録するのが metadata。
  // 環境変数によるグローバル免除スイッチを信じるとメールの金額が請求と食い違う。
  it("metadata だけで判定する（グローバル免除スイッチは見ない）", () => {
    expect(isSubscriptionInitialFeeWaived({})).toBe(false);
    expect(isSubscriptionInitialFeeWaived({ initial_fee_waived: "invitation_code" })).toBe(true);
    // 旧グローバルスイッチを渡しても免除しない（引数自体を廃止済み）
    expect((isSubscriptionInitialFeeWaived as (m: unknown, e?: unknown) => boolean)({}, "true")).toBe(false);
  });
});

describe("firstChargeAmountJpy", () => {
  it("月額 + 初期費用", () => {
    expect(firstChargeAmountJpy("monthly", false, false)).toBe(3828 + 33000);
  });

  it("免除されると初期費用が乗らない", () => {
    expect(firstChargeAmountJpy("monthly", false, true)).toBe(3828);
  });

  it("SMS オプションを加算する", () => {
    expect(firstChargeAmountJpy("monthly", true, true)).toBe(3828 + 550);
  });

  it("2年プランは元から初期費用なし", () => {
    expect(firstChargeAmountJpy("two_year", false, false)).toBe(6028);
    expect(firstChargeAmountJpy("two_year", false, true)).toBe(6028);
  });

  it("年払い", () => {
    expect(firstChargeAmountJpy("yearly", false, false)).toBe(38280 + 33000);
    expect(firstChargeAmountJpy("yearly", true, true)).toBe(38280 + 550);
  });
});

describe("firstChargeAmountForSubscription", () => {
  it("招待コードで免除された subscription は初期費用を含めない", () => {
    const amount = firstChargeAmountForSubscription({
      plan_key: "monthly",
      with_sms: "false",
      initial_fee_waived: "invitation_code",
    });
    expect(amount).toBe(3828);
  });

  it("免除されていない subscription は初期費用を含める", () => {
    const amount = firstChargeAmountForSubscription({
      plan_key: "monthly",
      with_sms: "false",
    });
    expect(amount).toBe(3828 + 33000);
  });

  it("SMS オプションを metadata から読む", () => {
    const amount = firstChargeAmountForSubscription({
      plan_key: "yearly",
      with_sms: "true",
      initial_fee_waived: "invitation_code",
    });
    expect(amount).toBe(38280 + 550);
  });

  it("plan_key が無ければ月額として扱う", () => {
    expect(firstChargeAmountForSubscription({})).toBe(3828 + 33000);
    expect(firstChargeAmountForSubscription(null)).toBe(3828 + 33000);
  });

  it("グローバル免除スイッチ (INITIAL_FEE_WAIVED) では免除しない", () => {
    expect(firstChargeAmountForSubscription({ plan_key: "monthly" })).toBe(3828 + 33000);
  });
});

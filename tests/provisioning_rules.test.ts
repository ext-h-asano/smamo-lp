import { describe, it, expect } from "vitest";
import {
  shouldProvisionOnSubscriptionUpdate,
  matchSubscriptionForSetupIntent,
} from "../functions/_lib/provisioning_rules";

describe("shouldProvisionOnSubscriptionUpdate", () => {
  it("支払い方法が null -> 設定 の遷移で true", () => {
    expect(
      shouldProvisionOnSubscriptionUpdate(
        { default_payment_method: null },
        { default_payment_method: "pm_1" },
      ),
    ).toBe(true);
  });

  it("previous_attributes に当該フィールドが無ければ false", () => {
    expect(
      shouldProvisionOnSubscriptionUpdate({ status: "active" }, { default_payment_method: "pm_1" }),
    ).toBe(false);
  });

  it("既に設定済みからの差し替えでは false (再割当を誘発しない)", () => {
    expect(
      shouldProvisionOnSubscriptionUpdate(
        { default_payment_method: "pm_old" },
        { default_payment_method: "pm_new" },
      ),
    ).toBe(false);
  });

  it("支払い方法が外れた (設定 -> null) 場合は false", () => {
    expect(
      shouldProvisionOnSubscriptionUpdate(
        { default_payment_method: "pm_old" },
        { default_payment_method: null },
      ),
    ).toBe(false);
  });

  it("previous_attributes が undefined なら false", () => {
    expect(shouldProvisionOnSubscriptionUpdate(undefined, { default_payment_method: "pm_1" })).toBe(
      false,
    );
  });
});

describe("matchSubscriptionForSetupIntent", () => {
  const trialingA = { id: "sub_A", status: "trialing" };
  const trialingB = { id: "sub_B", status: "trialing" };

  it("metadata.subscription_id に一致する契約を返す", () => {
    expect(
      matchSubscriptionForSetupIntent({ metadata: { subscription_id: "sub_B" } }, [
        trialingA,
        trialingB,
      ]),
    ).toBe(trialingB);
  });

  it("trialing が2本あっても metadata と一致する方を返す (add_device 誤爆の回帰)", () => {
    expect(
      matchSubscriptionForSetupIntent({ metadata: { subscription_id: "sub_A" } }, [
        trialingB,
        trialingA,
      ]),
    ).toBe(trialingA);
  });

  it("metadata が無ければ trialing/active の先頭一致にフォールバックする", () => {
    expect(
      matchSubscriptionForSetupIntent({ metadata: null }, [
        { id: "sub_C", status: "canceled" },
        trialingA,
      ]),
    ).toBe(trialingA);
  });

  it("metadata が指す契約が一覧に無ければ null (推測で代用しない)", () => {
    expect(
      matchSubscriptionForSetupIntent({ metadata: { subscription_id: "sub_MISSING" } }, [trialingA]),
    ).toBeNull();
  });

  it("候補が空なら null", () => {
    expect(matchSubscriptionForSetupIntent({ metadata: null }, [])).toBeNull();
  });
});

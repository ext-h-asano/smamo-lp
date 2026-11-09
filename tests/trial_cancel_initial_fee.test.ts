import { describe, it, expect, vi } from "vitest";
import { isCancelRequested, isCancelUndone, selectTrialReminderTargets } from "../functions/_lib/billing_rules";
import {
  removeInitialFeeOnTrialCancel,
  restoreInitialFeeOnCancelUndone,
  type InitialFeeStripe,
} from "../functions/_lib/initial_fee";

const UPD = "customer.subscription.updated";

describe("解約予約の判定 (cancel_at 方式)", () => {
  it("cancel_at: null→日時 を解約予約として拾う（2026-10-28 のポータル実測の形）", () => {
    expect(
      isCancelRequested(UPD, { cancel_at: null, canceled_at: null }, { cancel_at_period_end: false, cancel_at: 1793428339 }),
    ).toBe(true);
  });
  it("cancel_at が付いたままの別の更新では拾わない", () => {
    expect(
      isCancelRequested(UPD, { default_payment_method: "pm_x" }, { cancel_at_period_end: false, cancel_at: 1793428339 }),
    ).toBe(false);
  });
  it("cancel_at: 日時→null を取り消しとして拾う", () => {
    expect(isCancelUndone(UPD, { cancel_at: 1793428339 }, { cancel_at_period_end: false, cancel_at: null })).toBe(true);
  });
  it("cancel_at_period_end: true→false を取り消しとして拾う", () => {
    expect(isCancelUndone(UPD, { cancel_at_period_end: true }, { cancel_at_period_end: false, cancel_at: null })).toBe(true);
  });
  it("予約が入った瞬間は取り消し扱いしない", () => {
    expect(isCancelUndone(UPD, { cancel_at: null }, { cancel_at_period_end: false, cancel_at: 1793428339 })).toBe(false);
  });
  it("cancel_at で解約予約済みの人にはお試し終了リマインダーを送らない", () => {
    const now = 1_000_000;
    const subs = [
      { id: "a", trial_end: now + 3600, cancel_at_period_end: false, cancel_at: now + 3600 },
      { id: "b", trial_end: now + 3600, cancel_at_period_end: false, cancel_at: null },
    ];
    expect(selectTrialReminderTargets(subs, now).map((s) => s.id)).toEqual(["b"]);
  });
});

function fakeStripe(items: Array<Record<string, unknown>>) {
  const store = [...items];
  const stripe = {
    invoiceItems: {
      list: vi.fn(async () => ({ data: store })),
      del: vi.fn(async (id: string) => {
        const i = store.findIndex((x) => x.id === id);
        if (i >= 0) store.splice(i, 1);
        return { id, deleted: true };
      }),
      create: vi.fn(async (p: Record<string, unknown>) => {
        store.push({ id: "ii_new", ...p });
        return p;
      }),
    },
  };
  return { stripe: stripe as unknown as InitialFeeStripe, raw: stripe, store };
}

const FEE = {
  id: "ii_fee",
  metadata: { kind: "initial_fee", plan_key: "monthly" },
  parent: { subscription_details: { subscription: "sub_1" } },
};
const SUB = { id: "sub_1", customer: "cus_1", status: "trialing", metadata: { plan_key: "monthly" } };

describe("お試し中の解約と初期費用", () => {
  it("お試し中の解約予約で、その契約の初期費用だけを消す", async () => {
    const other = { id: "ii_other", metadata: { kind: "initial_fee" }, parent: { subscription_details: { subscription: "sub_2" } } };
    const misc = { id: "ii_misc", metadata: {}, parent: { subscription_details: { subscription: "sub_1" } } };
    const { stripe, raw } = fakeStripe([FEE, other, misc]);
    expect(await removeInitialFeeOnTrialCancel(stripe, SUB)).toBe(1);
    expect(raw.invoiceItems.del).toHaveBeenCalledTimes(1);
    expect(raw.invoiceItems.del).toHaveBeenCalledWith("ii_fee");
  });
  it("お試しが終わった契約（初期費用は精算済み）では何もしない", async () => {
    const { stripe, raw } = fakeStripe([FEE]);
    expect(await removeInitialFeeOnTrialCancel(stripe, { ...SUB, status: "active" })).toBe(0);
    expect(raw.invoiceItems.list).not.toHaveBeenCalled();
  });
  it("旧 API 形状 (ii.subscription) でも見つける", async () => {
    const { stripe, raw } = fakeStripe([{ id: "ii_old", metadata: { kind: "initial_fee" }, subscription: "sub_1" }]);
    expect(await removeInitialFeeOnTrialCancel(stripe, SUB)).toBe(1);
    expect(raw.invoiceItems.del).toHaveBeenCalledWith("ii_old");
  });
  it("解約予約を取り消したら初期費用を付け直す", async () => {
    const { stripe, raw } = fakeStripe([]);
    expect(await restoreInitialFeeOnCancelUndone(stripe, SUB)).toBe(true);
    expect(raw.invoiceItems.create).toHaveBeenCalledWith(
      expect.objectContaining({ customer: "cus_1", subscription: "sub_1", amount: 33000, currency: "jpy" }),
    );
  });
  it("明細が残っていれば二重に作らない", async () => {
    const { stripe, raw } = fakeStripe([FEE]);
    expect(await restoreInitialFeeOnCancelUndone(stripe, SUB)).toBe(false);
    expect(raw.invoiceItems.create).not.toHaveBeenCalled();
  });
  it("初期費用免除の契約には付け直さない", async () => {
    const { stripe, raw } = fakeStripe([]);
    const waived = { ...SUB, metadata: { plan_key: "monthly", initial_fee_waived: "invitation_code" } };
    expect(await restoreInitialFeeOnCancelUndone(stripe, waived)).toBe(false);
    expect(raw.invoiceItems.create).not.toHaveBeenCalled();
  });
});

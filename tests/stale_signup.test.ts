import { describe, it, expect } from "vitest";
import {
  STALE_SIGNUP_MIN_AGE_SEC,
  invoiceItemSubscriptionId,
  isCardUnconfirmedSignup,
  selectAgedStaleSignupSubscriptions,
  selectPendingInvoiceItemsForSubscription,
  selectStaleSignupSubscriptions,
} from "../functions/_lib/stale_signup";

const NOW = 1_800_000_000;

function sub(over: Record<string, unknown> = {}) {
  return {
    id: "sub_ghost",
    status: "trialing",
    created: NOW - 7200,
    pending_setup_intent: "seti_1",
    default_payment_method: null,
    metadata: { supabase_user_id: "user_1" },
    ...over,
  };
}

describe("isCardUnconfirmedSignup", () => {
  it("trialing + pending_setup_intent あり + 支払い方法なし = 幽霊契約", () => {
    expect(isCardUnconfirmedSignup(sub())).toBe(true);
  });

  it("incomplete も対象", () => {
    expect(isCardUnconfirmedSignup(sub({ status: "incomplete" }))).toBe(true);
  });

  it("カード確定済み (default_payment_method あり) は対象外", () => {
    expect(isCardUnconfirmedSignup(sub({ pending_setup_intent: null, default_payment_method: "pm_1" }))).toBe(
      false,
    );
    // 片方だけ埋まっている中間状態も、支払い方法があるなら触らない
    expect(isCardUnconfirmedSignup(sub({ default_payment_method: "pm_1" }))).toBe(false);
  });

  it("pending_setup_intent が無ければ対象外", () => {
    expect(isCardUnconfirmedSignup(sub({ pending_setup_intent: null }))).toBe(false);
    expect(isCardUnconfirmedSignup(sub({ pending_setup_intent: undefined }))).toBe(false);
  });

  it("active / past_due / canceled など他ステータスは対象外", () => {
    for (const status of ["active", "past_due", "canceled", "incomplete_expired", "unpaid", "paused"]) {
      expect(isCardUnconfirmedSignup(sub({ status })), status).toBe(false);
    }
  });

  it("展開済みオブジェクト形式の pending_setup_intent も認識する", () => {
    expect(isCardUnconfirmedSignup(sub({ pending_setup_intent: { id: "seti_1" } }))).toBe(true);
  });
});

describe("selectStaleSignupSubscriptions (層1: 同一ユーザーの残骸)", () => {
  it("幽霊契約だけを選ぶ", () => {
    const list = [
      sub({ id: "sub_ghost" }),
      sub({ id: "sub_paid", pending_setup_intent: null, default_payment_method: "pm_1", status: "active" }),
    ];
    expect(selectStaleSignupSubscriptions(list, "user_1").map((s) => s.id)).toEqual(["sub_ghost"]);
  });

  it("他ユーザーの幽霊契約は絶対に選ばない", () => {
    const list = [
      sub({ id: "sub_mine" }),
      sub({ id: "sub_other", metadata: { supabase_user_id: "user_2" } }),
      sub({ id: "sub_nometa", metadata: {} }),
      sub({ id: "sub_nullmeta", metadata: null }),
    ];
    expect(selectStaleSignupSubscriptions(list, "user_1").map((s) => s.id)).toEqual(["sub_mine"]);
  });

  it("ユーザー ID が空なら何も選ばない（全消しの事故防止）", () => {
    expect(selectStaleSignupSubscriptions([sub()], "")).toEqual([]);
  });

  it("層1 は経過時間を見ない（再送信直後の残骸も対象）", () => {
    const fresh = sub({ id: "sub_fresh", created: NOW - 5 });
    expect(selectStaleSignupSubscriptions([fresh], "user_1").map((s) => s.id)).toEqual(["sub_fresh"]);
  });
});

describe("selectAgedStaleSignupSubscriptions (層2: 離脱ユーザーのスイープ)", () => {
  it("しきい値は 1 時間", () => {
    expect(STALE_SIGNUP_MIN_AGE_SEC).toBe(3600);
  });

  it("作成から 1 時間以上経った幽霊契約だけを選ぶ", () => {
    const list = [
      sub({ id: "sub_old", created: NOW - 3601 }),
      sub({ id: "sub_new", created: NOW - 3599 }),
      sub({ id: "sub_just", created: NOW - 3600 }),
    ];
    expect(selectAgedStaleSignupSubscriptions(list, NOW).map((s) => s.id)).toEqual(["sub_old", "sub_just"]);
  });

  it("1 時間未満の新しい契約はスイープされない（カード入力中の人を巻き込まない）", () => {
    const list = [sub({ id: "sub_typing", created: NOW - 60 })];
    expect(selectAgedStaleSignupSubscriptions(list, NOW)).toEqual([]);
  });

  it("カード確定済みは経過時間に関わらず対象外", () => {
    const list = [
      sub({
        id: "sub_paid",
        created: NOW - 86400,
        status: "active",
        pending_setup_intent: null,
        default_payment_method: "pm_1",
      }),
    ];
    expect(selectAgedStaleSignupSubscriptions(list, NOW)).toEqual([]);
  });

  it("supabase_user_id の有無は問わない（Customer 横断で回収する）", () => {
    const list = [
      sub({ id: "sub_a", created: NOW - 7200, metadata: { supabase_user_id: "user_9" } }),
      sub({ id: "sub_b", created: NOW - 7200, metadata: null }),
    ];
    expect(selectAgedStaleSignupSubscriptions(list, NOW).map((s) => s.id)).toEqual(["sub_a", "sub_b"]);
  });

  it("created が数値でなければ安全側で対象外", () => {
    expect(selectAgedStaleSignupSubscriptions([sub({ created: undefined })], NOW)).toEqual([]);
  });
});

describe("invoiceItemSubscriptionId", () => {
  it("新形状 parent.subscription_details.subscription を読む", () => {
    expect(
      invoiceItemSubscriptionId({ parent: { subscription_details: { subscription: "sub_1" } } }),
    ).toBe("sub_1");
  });

  it("旧形状 subscription も読む（文字列 / 展開済み）", () => {
    expect(invoiceItemSubscriptionId({ subscription: "sub_1" })).toBe("sub_1");
    expect(invoiceItemSubscriptionId({ subscription: { id: "sub_1" } })).toBe("sub_1");
  });

  it("紐付きが無ければ null", () => {
    expect(invoiceItemSubscriptionId({})).toBeNull();
    expect(invoiceItemSubscriptionId({ subscription: null })).toBeNull();
  });
});

describe("selectPendingInvoiceItemsForSubscription", () => {
  it("対象 subscription に紐づく未請求 invoice item だけを選ぶ", () => {
    const items = [
      { id: "ii_fee", invoice: null, metadata: { kind: "initial_fee" }, subscription: "sub_ghost" },
      { id: "ii_other_sub", invoice: null, metadata: { kind: "initial_fee" }, subscription: "sub_other" },
      { id: "ii_standalone", invoice: null, metadata: {} },
      { id: "ii_billed", invoice: "in_1", metadata: { kind: "initial_fee" }, subscription: "sub_ghost" },
    ];
    expect(selectPendingInvoiceItemsForSubscription(items, "sub_ghost").map((i) => i.id)).toEqual(["ii_fee"]);
  });
});

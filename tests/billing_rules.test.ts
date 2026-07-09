import { describe, it, expect } from "vitest";
import {
  selectTrialReminderTargets,
  isCancelRequested,
  extractSubscriptionId,
} from "../functions/_lib/billing_rules";

const NOW = 1_800_000_000;
const sub = (o: Partial<{ id: string; trial_end: number | null; cancel_at_period_end: boolean }>) => ({
  id: "sub_x",
  trial_end: null as number | null,
  cancel_at_period_end: false,
  ...o,
});

describe("selectTrialReminderTargets", () => {
  it("picks only trial_end within 24h, not cancelled", () => {
    const list = [
      sub({ id: "target", trial_end: NOW + 3600 }),
      sub({ id: "later", trial_end: NOW + 25 * 3600 }),
      sub({ id: "past", trial_end: NOW - 60 }),
      sub({ id: "cancelled", trial_end: NOW + 3600, cancel_at_period_end: true }),
      sub({ id: "frozen", trial_end: NOW + 300 * 86400 }), // 順番待ち凍結
      sub({ id: "no_trial", trial_end: null }),
    ];
    expect(selectTrialReminderTargets(list, NOW).map((s) => s.id)).toEqual(["target"]);
  });
  it("boundaries: now+24h included, now excluded", () => {
    expect(selectTrialReminderTargets([sub({ trial_end: NOW + 24 * 3600 })], NOW)).toHaveLength(1);
    expect(selectTrialReminderTargets([sub({ trial_end: NOW })], NOW)).toHaveLength(0);
  });
});

describe("isCancelRequested", () => {
  it("true only on false->true transition of updated event", () => {
    expect(
      isCancelRequested("customer.subscription.updated", { cancel_at_period_end: false }, { cancel_at_period_end: true }),
    ).toBe(true);
  });
  it("false when previous_attributes lacks the field", () => {
    expect(
      isCancelRequested("customer.subscription.updated", { status: "active" }, { cancel_at_period_end: true }),
    ).toBe(false);
  });
  it("false on un-cancel (true->false)", () => {
    expect(
      isCancelRequested("customer.subscription.updated", { cancel_at_period_end: true }, { cancel_at_period_end: false }),
    ).toBe(false);
  });
  it("false for other event types / undefined prev", () => {
    expect(
      isCancelRequested("customer.subscription.created", { cancel_at_period_end: false }, { cancel_at_period_end: true }),
    ).toBe(false);
    expect(isCancelRequested("customer.subscription.updated", undefined, { cancel_at_period_end: true })).toBe(false);
  });
});

describe("extractSubscriptionId", () => {
  it("new shape (parent.subscription_details)", () => {
    expect(
      extractSubscriptionId({ parent: { subscription_details: { subscription: "sub_1" } } } as never),
    ).toBe("sub_1");
  });
  it("legacy string field", () => {
    expect(extractSubscriptionId({ subscription: "sub_2" } as never)).toBe("sub_2");
  });
  it("legacy expanded object", () => {
    expect(extractSubscriptionId({ subscription: { id: "sub_3" } } as never)).toBe("sub_3");
  });
  it("null when absent", () => {
    expect(extractSubscriptionId({} as never)).toBe(null);
  });
});

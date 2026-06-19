export type PlanKey = "monthly" | "yearly" | "two_year";

export interface PlanConfig {
  priceId: string;
  hasInitialFee: boolean;
  commitMonths?: number;
}

export function getPlans(env: { STRIPE_PRICE_MONTHLY: string; STRIPE_PRICE_YEARLY: string; STRIPE_PRICE_TWO_YEAR: string }): Record<PlanKey, PlanConfig> {
  return {
    monthly: { priceId: env.STRIPE_PRICE_MONTHLY, hasInitialFee: true },
    yearly: { priceId: env.STRIPE_PRICE_YEARLY, hasInitialFee: true },
    two_year: { priceId: env.STRIPE_PRICE_TWO_YEAR, hasInitialFee: false, commitMonths: 24 },
  };
}

export const PLAN_DISPLAY_NAME: Record<PlanKey, string> = {
  monthly: "SMAMO 月額プラン",
  yearly: "SMAMO 年払いプラン",
  two_year: "SMAMO 2年プラン",
};

export const INITIAL_FEE_JPY = 33000;
export const TRIAL_DAYS = 3;

export const SMS_OPTION_FEE_JPY = 550;

export const PLAN_AMOUNTS_JPY: Record<PlanKey, number> = {
  monthly: 3278,
  yearly: 32780,
  two_year: 5478,
};

export const PLAN_HAS_INITIAL_FEE: Record<PlanKey, boolean> = {
  monthly: true,
  yearly: true,
  two_year: false,
};

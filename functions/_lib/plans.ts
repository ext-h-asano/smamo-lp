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

export const INITIAL_FEE_JPY = 33000;
export const TRIAL_DAYS = 3;

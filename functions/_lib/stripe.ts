import Stripe from "stripe";

export function makeStripe(secret: string): Stripe {
  return new Stripe(secret, {
    apiVersion: "2025-09-30.clover" as Stripe.LatestApiVersion,
    httpClient: Stripe.createFetchHttpClient(),
  });
}

export interface Env {
  STRIPE_SECRET_KEY: string;
  STRIPE_PUBLISHABLE_KEY: string;
  STRIPE_WEBHOOK_SECRET: string;
  STRIPE_PRICE_MONTHLY: string;
  STRIPE_PRICE_YEARLY: string;
  STRIPE_PRICE_TWO_YEAR: string;
  STRIPE_PRICE_SMS_OPTION: string;
  STRIPE_PRODUCT_INITIAL_FEE: string;
  PROVISION_URL?: string;
  PROVISION_SHARED_SECRET?: string;
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

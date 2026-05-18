import type Stripe from "stripe";
import { Env, jsonResponse, makeStripe } from "../_lib/stripe";
import { getPlans, INITIAL_FEE_JPY, PlanKey, TRIAL_DAYS } from "../_lib/plans";

interface CheckoutRequest {
  plan: PlanKey;
  with_sms: boolean;
  email: string;
  name?: string;
}

function isPlanKey(v: unknown): v is PlanKey {
  return v === "monthly" || v === "yearly" || v === "two_year";
}

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  let body: CheckoutRequest;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "invalid JSON body" }, 400);
  }

  if (!isPlanKey(body.plan)) return jsonResponse({ error: "invalid plan" }, 400);
  if (!body.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email)) {
    return jsonResponse({ error: "invalid email" }, 400);
  }

  const stripe = makeStripe(env.STRIPE_SECRET_KEY);
  const plans = getPlans(env);
  const plan = plans[body.plan];

  const existing = await stripe.customers.list({ email: body.email, limit: 1 });
  const customer = existing.data[0]
    ? existing.data[0]
    : await stripe.customers.create({
        email: body.email,
        name: body.name,
        metadata: { source: "smamo-lp" },
      });

  const items: Stripe.SubscriptionCreateParams.Item[] = [{ price: plan.priceId }];
  if (body.with_sms) items.push({ price: env.STRIPE_PRICE_SMS_OPTION });

  const metadata: Record<string, string> = {
    plan_key: body.plan,
    with_sms: String(body.with_sms),
  };
  if (plan.commitMonths) {
    const committedUntil = new Date();
    committedUntil.setMonth(committedUntil.getMonth() + plan.commitMonths);
    metadata.commit_months = String(plan.commitMonths);
    metadata.committed_until = committedUntil.toISOString();
  }

  const subscription = await stripe.subscriptions.create({
    customer: customer.id,
    items,
    trial_period_days: TRIAL_DAYS,
    payment_behavior: "default_incomplete",
    payment_settings: {
      save_default_payment_method: "on_subscription",
      payment_method_types: ["card"],
    },
    expand: ["pending_setup_intent"],
    metadata,
  });

  if (plan.hasInitialFee) {
    await stripe.invoiceItems.create({
      customer: customer.id,
      subscription: subscription.id,
      amount: INITIAL_FEE_JPY,
      currency: "jpy",
      description: "初期費用",
      metadata: { kind: "initial_fee", plan_key: body.plan },
    });
  }

  const setupIntent = subscription.pending_setup_intent as Stripe.SetupIntent | null;
  const clientSecret = setupIntent?.client_secret;
  if (!clientSecret) {
    return jsonResponse({ error: "no client secret returned from Stripe" }, 500);
  }

  return jsonResponse({
    client_secret: clientSecret,
    subscription_id: subscription.id,
    customer_id: customer.id,
    mode: "setup",
  });
};

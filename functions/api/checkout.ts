import type Stripe from "stripe";
import { Env, jsonResponse, makeStripe } from "../_lib/stripe";
import { getPlans, INITIAL_FEE_JPY, PLAN_DISPLAY_NAME, PlanKey, TRIAL_DAYS } from "../_lib/plans";
import { ensureUserExists } from "../_lib/supabase";

interface CheckoutRequest {
  plan: PlanKey;
  with_sms: boolean;
  email: string;
  name?: string;
  password: string;
  device_name?: string | null;
  mode?: "signup" | "add_device";
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
  if (!body.password || body.password.length < 8) {
    return jsonResponse({ error: "パスワードは 8 文字以上で入力してください。" }, 400);
  }

  let supabaseUser;
  try {
    supabaseUser = await ensureUserExists(
      { url: env.SUPABASE_URL, serviceRoleKey: env.SUPABASE_SECRET_KEY },
      body.email,
      body.password,
      body.name ?? "",
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[checkout] supabase user creation failed:", msg);
    return jsonResponse({ error: "アカウント作成に失敗しました。時間をおいて再度お試しください。" }, 500);
  }

  const stripe = makeStripe(env.STRIPE_SECRET_KEY);
  const plans = getPlans(env);
  const plan = plans[body.plan];

  // 初期費用無料キャンペーン: env トグルが "true" の間だけ初期費用の付与をスキップする
  const initialFeeWaived = (env.INITIAL_FEE_WAIVED ?? "").toLowerCase() === "true";

  const existing = await stripe.customers.list({ email: body.email, limit: 1 });
  let customer: Stripe.Customer;
  if (existing.data[0]) {
    customer = existing.data[0];
    // 既存 Customer に preferred_locales が無ければ日本語に設定し直す
    // (Stripe からの自動メールを日本語版で送らせるため)
    if (!customer.preferred_locales?.length) {
      customer = await stripe.customers.update(customer.id, {
        preferred_locales: ["ja"],
      });
    }
  } else {
    customer = await stripe.customers.create({
      email: body.email,
      name: body.name,
      preferred_locales: ["ja"],
      metadata: { source: "smamo-lp", supabase_user_id: supabaseUser.id },
    });
  }

  const items: Stripe.SubscriptionCreateParams.Item[] = [{ price: plan.priceId }];
  if (body.with_sms) items.push({ price: env.STRIPE_PRICE_SMS_OPTION });

  const metadata: Record<string, string> = {
    plan_key: body.plan,
    with_sms: String(body.with_sms),
    supabase_user_id: supabaseUser.id,
    flow_mode: body.mode === "add_device" ? "add_device" : "signup",
  };
  if (body.device_name && body.device_name.trim() !== "") {
    metadata.device_name = body.device_name.trim();
  }
  if (plan.commitMonths) {
    const committedUntil = new Date();
    committedUntil.setMonth(committedUntil.getMonth() + plan.commitMonths);
    metadata.commit_months = String(plan.commitMonths);
    metadata.committed_until = committedUntil.toISOString();
  }
  // キャンペーンで初期費用を無料化した場合、後からサポートで追えるよう記録を残す
  if (plan.hasInitialFee && initialFeeWaived) {
    metadata.initial_fee_waived = "true";
  }

  const deviceLabel = body.device_name?.trim()
    ? `${body.device_name.trim()} (${PLAN_DISPLAY_NAME[body.plan]})`
    : PLAN_DISPLAY_NAME[body.plan];

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
    description: deviceLabel,
  });

  if (plan.hasInitialFee && !initialFeeWaived) {
    await stripe.invoiceItems.create({
      customer: customer.id,
      subscription: subscription.id,
      amount: INITIAL_FEE_JPY,
      currency: "jpy",
      description: "初期費用",
      metadata: { kind: "initial_fee", plan_key: body.plan },
    });
  } else if (plan.hasInitialFee && initialFeeWaived) {
    console.log(`[checkout] 初期費用無料キャンペーン適用: sub=${subscription.id} plan=${body.plan}`);
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

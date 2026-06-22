import type Stripe from "stripe";
import { Env, jsonResponse, makeStripe } from "../_lib/stripe";
import { getCustomerIdForUser, getUserFromJwt } from "../_lib/supabase";

interface ToggleSmsRequest {
  subscription_id: string;
  enable: boolean;
}

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const auth = request.headers.get("authorization") ?? "";
  const m = /^Bearer\s+(.+)$/i.exec(auth);
  if (!m) return jsonResponse({ error: "missing bearer token" }, 401);

  const cfg = { url: env.SUPABASE_URL, serviceRoleKey: env.SUPABASE_SECRET_KEY };
  const user = await getUserFromJwt(cfg, m[1]);
  if (!user) return jsonResponse({ error: "invalid or expired token" }, 401);

  let body: ToggleSmsRequest;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "invalid JSON body" }, 400);
  }

  if (!body.subscription_id || typeof body.enable !== "boolean") {
    return jsonResponse({ error: "subscription_id and enable are required" }, 400);
  }

  const customerId = await getCustomerIdForUser(cfg, user.id);
  if (!customerId) {
    return jsonResponse({ error: "no Stripe customer found" }, 404);
  }

  const stripe = makeStripe(env.STRIPE_SECRET_KEY);

  let sub: Stripe.Subscription;
  try {
    sub = await stripe.subscriptions.retrieve(body.subscription_id);
  } catch {
    return jsonResponse({ error: "subscription not found" }, 404);
  }

  const subCustomerId =
    typeof sub.customer === "string" ? sub.customer : sub.customer.id;
  if (subCustomerId !== customerId) {
    return jsonResponse({ error: "subscription does not belong to this user" }, 403);
  }

  const liveStatuses = new Set(["active", "trialing", "past_due"]);
  if (!liveStatuses.has(sub.status)) {
    return jsonResponse({ error: "subscription is not active" }, 400);
  }

  const smsPriceId = env.STRIPE_PRICE_SMS_OPTION;
  const smsItem = sub.items.data.find((item) => item.price.id === smsPriceId);
  const alreadyHasSms = !!smsItem;

  if (body.enable && alreadyHasSms) {
    return jsonResponse({ ok: true, with_sms: true, message: "already enabled" });
  }
  if (!body.enable && !alreadyHasSms) {
    return jsonResponse({ ok: true, with_sms: false, message: "already disabled" });
  }

  if (body.enable) {
    await stripe.subscriptionItems.create({
      subscription: sub.id,
      price: smsPriceId,
      proration_behavior: "create_prorations",
    });
  } else {
    await stripe.subscriptionItems.del(smsItem!.id, {
      proration_behavior: "create_prorations",
    });
  }

  await stripe.subscriptions.update(sub.id, {
    metadata: { ...sub.metadata, with_sms: String(body.enable) },
  });

  return jsonResponse({ ok: true, with_sms: body.enable });
};

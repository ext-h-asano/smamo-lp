import type Stripe from "stripe";
import { Env, jsonResponse, makeStripe } from "../_lib/stripe";
import { getCustomerIdForUser, getUserFromJwt } from "../_lib/supabase";

interface PortalRequest {
  return_url?: string;
  /** Optional: open the portal directly on this subscription's cancel screen. */
  subscription_id?: string;
  /** 'cancel' = go to subscription_cancel flow. Otherwise general portal. */
  flow?: "cancel";
}

const DEFAULT_RETURN_URL = "https://smamo.jp/";

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const auth = request.headers.get("authorization") ?? "";
  const m = /^Bearer\s+(.+)$/i.exec(auth);
  if (!m) return jsonResponse({ error: "missing bearer token" }, 401);

  const cfg = { url: env.SUPABASE_URL, serviceRoleKey: env.SUPABASE_SECRET_KEY };
  const user = await getUserFromJwt(cfg, m[1]);
  if (!user) return jsonResponse({ error: "invalid or expired token" }, 401);

  const customerId = await getCustomerIdForUser(cfg, user.id);
  if (!customerId) {
    return jsonResponse({ error: "no Stripe customer found for this user" }, 404);
  }

  let body: PortalRequest = {};
  try {
    if (request.headers.get("content-type")?.includes("application/json")) {
      body = (await request.json()) as PortalRequest;
    }
  } catch {
    // empty body is fine
  }

  const stripe = makeStripe(env.STRIPE_SECRET_KEY);
  const params: Stripe.BillingPortal.SessionCreateParams = {
    customer: customerId,
    return_url: body.return_url ?? DEFAULT_RETURN_URL,
  };

  if (body.flow === "cancel" && body.subscription_id) {
    // 指定 subscription が当該 customer の所有か検証してから flow_data を組み立てる。
    try {
      const sub = await stripe.subscriptions.retrieve(body.subscription_id);
      const subCustomerId =
        typeof sub.customer === "string" ? sub.customer : sub.customer.id;
      if (subCustomerId !== customerId) {
        return jsonResponse({ error: "subscription does not belong to this customer" }, 403);
      }
    } catch {
      return jsonResponse({ error: "subscription not found" }, 404);
    }
    params.flow_data = {
      type: "subscription_cancel",
      subscription_cancel: { subscription: body.subscription_id },
    };
  }

  const session = await stripe.billingPortal.sessions.create(params);

  return jsonResponse({ url: session.url });
};

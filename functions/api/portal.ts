import { Env, jsonResponse, makeStripe } from "../_lib/stripe";
import { getCustomerIdForUser, getUserFromJwt } from "../_lib/supabase";

interface PortalRequest {
  return_url?: string;
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
  const session = await stripe.billingPortal.sessions.create({
    customer: customerId,
    return_url: body.return_url ?? DEFAULT_RETURN_URL,
  });

  return jsonResponse({ url: session.url });
};

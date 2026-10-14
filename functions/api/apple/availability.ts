/**
 * GET /api/apple/availability
 * iOS アプリの購入画面が購入前に呼ぶ。空きが無ければ購入させない（docs/ios_iap_design.md）。
 *
 * 認証: Authorization: Bearer <Supabase access token>
 * 応答: { available: boolean }
 */
import { Env, jsonResponse } from "../../_lib/stripe";
import { adminFetch, getUserFromJwt } from "../../_lib/supabase";
import { APPLE_PLAN_KEY } from "../../_lib/apple_subscription";

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const m = /^Bearer\s+(.+)$/i.exec(request.headers.get("authorization") ?? "");
  if (!m) return jsonResponse({ error: "missing bearer token" }, 401);

  const cfg = { url: env.SUPABASE_URL, serviceRoleKey: env.SUPABASE_SECRET_KEY };
  const user = await getUserFromJwt(cfg, m[1]);
  if (!user) return jsonResponse({ error: "invalid or expired token" }, 401);

  try {
    const resp = await adminFetch<unknown>(cfg, "/rest/v1/rpc/pool_available_count", {
      method: "POST",
      json: { p_plan_key: APPLE_PLAN_KEY },
    });
    if (resp.status < 200 || resp.status >= 300 || typeof resp.body !== "number") {
      console.error(`[apple/availability] rpc ${resp.status}: ${JSON.stringify(resp.body)}`);
      return jsonResponse({ error: "failed to check availability" }, 500);
    }
    return jsonResponse({ available: resp.body > 0 });
  } catch (e) {
    console.error("[apple/availability] rpc fetch failed", e);
    return jsonResponse({ error: "failed to check availability" }, 500);
  }
};

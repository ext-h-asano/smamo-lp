import { Env, jsonResponse } from "../_lib/stripe";
import { resolveAgencyNameByCode } from "../_lib/supabase";

// 紹介コードが「有効な子代理店」か軽く確認し、表示名を返す。
// 無効・該当なし・疎通エラーは全て { valid: false }（200）でフォールバックし、
// 申込フローを絶対に止めない。
export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const url = new URL(request.url);
  const code = (url.searchParams.get("code") ?? "").trim().toUpperCase();
  if (!code) return jsonResponse({ valid: false });

  const cfg = { url: env.SUPABASE_URL, serviceRoleKey: env.SUPABASE_SECRET_KEY };
  try {
    const agency = await resolveAgencyNameByCode(cfg, code);
    if (!agency) return jsonResponse({ valid: false });
    return jsonResponse({ valid: true, code, agency_name: agency.name });
  } catch (err) {
    console.error("[validate-ref] lookup failed:", err instanceof Error ? err.message : String(err));
    return jsonResponse({ valid: false });
  }
};

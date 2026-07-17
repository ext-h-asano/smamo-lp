import { Env, jsonResponse } from "../_lib/stripe";
import { resolveAgencyNameByCode, resolveParentAgencyByCode } from "../_lib/supabase";

// 紹介コードが有効か軽く確認し、表示名を返す。
// - 子代理店コード: kind=child（顧客紹介）
// - 親代理店コード: kind=parent_onboard（子代理店としての1契約オンボード）
// 無効・該当なし・疎通エラーは全て { valid: false }（200）でフォールバックし、
// 申込フローを絶対に止めない。
export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const url = new URL(request.url);
  const code = (url.searchParams.get("code") ?? "").trim().toUpperCase();
  if (!code) return jsonResponse({ valid: false });

  const cfg = { url: env.SUPABASE_URL, serviceRoleKey: env.SUPABASE_SECRET_KEY };
  try {
    const child = await resolveAgencyNameByCode(cfg, code);
    if (child) {
      return jsonResponse({ valid: true, code, agency_name: child.name, kind: "child" });
    }
    const parent = await resolveParentAgencyByCode(cfg, code);
    if (parent) {
      return jsonResponse({
        valid: true,
        code,
        agency_name: parent.name,
        kind: "parent_onboard",
      });
    }
    return jsonResponse({ valid: false });
  } catch (err) {
    console.error("[validate-ref] lookup failed:", err instanceof Error ? err.message : String(err));
    return jsonResponse({ valid: false });
  }
};

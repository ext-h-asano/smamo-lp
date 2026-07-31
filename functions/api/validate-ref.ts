import { Env, jsonResponse } from "../_lib/stripe";
import { isInitialFeeWaiverCode } from "../_lib/initial_fee";
import { resolveAgencyNameByCode, resolveParentAgencyByCode } from "../_lib/supabase";

// 紹介コードが有効か軽く確認し、表示名を返す。
// - 子代理店コード: kind=child（顧客紹介）
// - 親代理店コード: kind=parent_onboard（子代理店としての1契約オンボード）
// waives_initial_fee は初期費用 ¥33,000 が無料になるコードか（LP の表示専用。課金判定は checkout 側が正）。
// 無効・該当なし・疎通エラーは全て { valid: false }（200）でフォールバックし、
// 申込フローを絶対に止めない。
export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const url = new URL(request.url);
  const code = (url.searchParams.get("code") ?? "").trim().toUpperCase();
  if (!code) return jsonResponse({ valid: false });

  const cfg = { url: env.SUPABASE_URL, serviceRoleKey: env.SUPABASE_SECRET_KEY };
  const waivesInitialFee = isInitialFeeWaiverCode(code, env.INITIAL_FEE_WAIVER_CODES);
  try {
    const child = await resolveAgencyNameByCode(cfg, code);
    if (child) {
      return jsonResponse({
        valid: true,
        code,
        agency_name: child.name,
        kind: "child",
        waives_initial_fee: waivesInitialFee,
      });
    }
    const parent = await resolveParentAgencyByCode(cfg, code);
    if (parent) {
      return jsonResponse({
        valid: true,
        code,
        agency_name: parent.name,
        kind: "parent_onboard",
        waives_initial_fee: waivesInitialFee,
      });
    }
    return jsonResponse({ valid: false });
  } catch (err) {
    console.error("[validate-ref] lookup failed:", err instanceof Error ? err.message : String(err));
    // error: true = 「無効」ではなく「確認できなかった」。
    // LP はこれを見て Step 1 で足止めせず、最終判定を checkout に委ねる。
    return jsonResponse({ valid: false, error: true });
  }
};

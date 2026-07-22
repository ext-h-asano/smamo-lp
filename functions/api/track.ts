import { Env, jsonResponse } from "../_lib/stripe";
import { normalizeCampaignCode } from "../_lib/campaign";
import { insertLpVisit, resolveCampaignByCode } from "../_lib/supabase";

interface TrackBody {
  campaign_code?: string | null;
  session_id?: string;
  path?: string;
}

// LP 訪問ビーコン。失敗してもフロントを壊さないため、論理エラー以外は ok:false で 200 を返す。
export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  let body: TrackBody;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ ok: false, error: "invalid JSON" }, 400);
  }

  const sessionId = String(body.session_id ?? "").trim();
  if (!sessionId || sessionId.length > 80) {
    return jsonResponse({ ok: false, error: "invalid session_id" }, 400);
  }

  let path = String(body.path ?? "/").trim() || "/";
  if (path.length > 200) path = path.slice(0, 200);

  const code = normalizeCampaignCode(body.campaign_code ?? "");
  const cfg = { url: env.SUPABASE_URL, serviceRoleKey: env.SUPABASE_SECRET_KEY };

  let campaignId: string | null = null;
  if (code) {
    try {
      campaignId = await resolveCampaignByCode(cfg, code);
    } catch (err) {
      console.error("[track] campaign lookup failed:", err instanceof Error ? err.message : String(err));
      // 未知コード扱いで続行（campaign_id null + code を残す）
    }
  }

  try {
    await insertLpVisit(cfg, {
      campaign_id: campaignId,
      campaign_code: code || null,
      session_id: sessionId,
      path,
    });
  } catch (err) {
    console.error("[track] insert failed:", err instanceof Error ? err.message : String(err));
    return jsonResponse({ ok: false });
  }

  return jsonResponse({ ok: true });
};

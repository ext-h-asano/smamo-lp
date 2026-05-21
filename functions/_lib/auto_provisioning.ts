import type { Env } from "./stripe";
import { sendDiscord } from "./discord";
import { adminFetch } from "./supabase";

interface AutoAssignResult {
  container_name: string | null;
  scrcpy_port: number | null;
  remaining_pool: number | null;
  user_id_assigned: string | null;
  already_assigned: boolean | null;
}

interface AutoAssignArgs {
  env: Env;
  subscriptionId: string;
  customerEmail?: string | null;
  planKey?: string | null;
  deviceName?: string | null;
  setupIntentId: string;
}

/**
 * Postgres function auto_assign_pool_container を service_role RPC で呼び、
 * 結果に応じて Discord 通知を出し分ける。
 *
 * - 新規割当成功 → info 通知 + 残量 ≤ POOL_WARN_THRESHOLD なら warn 追加
 * - 既割当 (冪等性ヒット) → No-op (通知なし、log のみ)
 * - subscription 未登録 (subscription.created 未着) → warn
 * - プール枯渇 → critical
 * - RPC エラー → critical
 *
 * never throw: Stripe webhook の 200 返却を妨げない。
 */
export async function autoAssignContainer(args: AutoAssignArgs): Promise<void> {
  const { env, subscriptionId, customerEmail, planKey, deviceName, setupIntentId } = args;

  const cfg = { url: env.SUPABASE_URL, serviceRoleKey: env.SUPABASE_SECRET_KEY };

  let rpcResp: { status: number; body: unknown };
  try {
    rpcResp = await adminFetch<unknown>(
      cfg,
      "/rest/v1/rpc/auto_assign_pool_container",
      { method: "POST", json: { p_subscription_id: subscriptionId } },
    );
  } catch (e) {
    console.error("[auto-provision] rpc fetch failed", e);
    await sendDiscord(env, "critical", {
      title: "🚨 自動割当 RPC 通信エラー",
      fields: [
        { name: "subscription_id", value: subscriptionId },
        { name: "setup_intent_id", value: setupIntentId },
        { name: "error", value: e instanceof Error ? e.message : String(e) },
        { name: "action", value: "手動 /assign-user で復旧してください" },
      ],
    });
    return;
  }

  if (rpcResp.status < 200 || rpcResp.status >= 300) {
    const bodyStr = typeof rpcResp.body === "string"
      ? rpcResp.body
      : JSON.stringify(rpcResp.body);
    console.error(`[auto-provision] rpc ${rpcResp.status}: ${bodyStr}`);
    await sendDiscord(env, "critical", {
      title: "🚨 自動割当 RPC エラー",
      fields: [
        { name: "subscription_id", value: subscriptionId },
        { name: "setup_intent_id", value: setupIntentId },
        { name: "status", value: String(rpcResp.status) },
        { name: "body", value: bodyStr.slice(0, 500) },
        { name: "action", value: "手動 /assign-user で復旧してください" },
      ],
    });
    return;
  }

  // Postgres function は TABLE を返す → REST RPC では配列で返る
  const rows = (Array.isArray(rpcResp.body) ? rpcResp.body : []) as AutoAssignResult[];
  const data = rows[0];

  if (!data || data.container_name == null) {
    // function が row を返さなかった、または container_name が NULL。
    // subscription 未登録 / プール枯渇のどちらか判定するため stripe_subscriptions を独立クエリ。
    let subExists = false;
    try {
      const subResp = await adminFetch<{ user_id?: string }[]>(
        cfg,
        `/rest/v1/stripe_subscriptions?stripe_subscription_id=eq.${encodeURIComponent(subscriptionId)}&select=user_id&limit=1`,
        { method: "GET" },
      );
      if (subResp.status >= 200 && subResp.status < 300 && Array.isArray(subResp.body)) {
        subExists = !!subResp.body[0]?.user_id;
      }
    } catch (e) {
      console.error("[auto-provision] stripe_subscriptions lookup failed", e);
    }

    if (!subExists) {
      await sendDiscord(env, "warn", {
        title: "⚠️ subscription 未登録で割当 skip",
        fields: [
          { name: "subscription_id", value: subscriptionId },
          { name: "setup_intent_id", value: setupIntentId },
          { name: "note", value: "次の subscription.* webhook 再配信を待つ" },
        ],
      });
      return;
    }

    // プール枯渇
    await sendDiscord(env, "critical", {
      title: "🚨 プール枯渇 - 割当失敗",
      fields: [
        { name: "subscription_id", value: subscriptionId },
        { name: "email", value: customerEmail ?? "(unknown)" },
        { name: "plan_key", value: planKey ?? "(unknown)" },
        {
          name: "action",
          value: "1) ssh で `/fill-container` 実行 / 2) `/admin/users` で手動 assign",
        },
      ],
    });
    return;
  }

  if (data.already_assigned) {
    console.log(
      `[auto-provision] already_assigned: sub=${subscriptionId} container=${data.container_name}`,
    );
    return; // No-op
  }

  // 新規割当成功
  const remaining = data.remaining_pool ?? -1;
  await sendDiscord(env, "info", {
    title: "✅ コンテナ自動割当 完了",
    fields: [
      { name: "container_name", value: data.container_name, inline: true },
      { name: "remaining_pool", value: String(remaining), inline: true },
      { name: "email", value: customerEmail ?? "(unknown)" },
      { name: "plan_key", value: planKey ?? "(unknown)" },
      { name: "device_name", value: deviceName ?? "(unset)" },
    ],
  });

  const thresholdRaw = env.POOL_WARN_THRESHOLD ?? "3";
  const threshold = Number.isFinite(Number(thresholdRaw)) ? Number(thresholdRaw) : 3;
  if (remaining >= 0 && remaining <= threshold) {
    await sendDiscord(env, "warn", {
      title: `⚠️ プール残量 ${remaining} 台 (閾値 ${threshold})`,
      fields: [{ name: "action", value: "`/fill-container` で補充推奨" }],
    });
  }
}

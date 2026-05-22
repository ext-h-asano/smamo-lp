import type { Env } from "./stripe";
import { sendDiscord } from "./discord";
import { adminFetch } from "./supabase";

type AutoAssignReason = "ok" | "already" | "not_found" | "exhausted";

interface AutoAssignResult {
  reason: AutoAssignReason;
  container_name: string | null;
  scrcpy_port: number | null;
  remaining_pool: number | null;
  user_id_assigned: string | null;
}

interface AutoAssignArgs {
  env: Env;
  subscriptionId: string;
  customerEmail?: string | null;
  planKey?: string | null;
  deviceName?: string | null;
  // 呼出元 webhook の event id 等。エラー通知で追跡できるよう必須にしている。
  triggerId: string;
}

/**
 * Postgres function auto_assign_pool_container を service_role RPC で呼び、
 * 戻り値の reason に応じて Discord 通知を出し分ける。
 *
 * - reason='ok'         → info 通知 + 残量 ≤ POOL_WARN_THRESHOLD なら warn 追加
 * - reason='already'    → No-op (通知なし、log のみ)
 * - reason='not_found'  → log のみ (subscription.created webhook 側で再試行されるので通知不要)
 * - reason='exhausted'  → critical
 * - RPC エラー          → critical
 *
 * never throw: Stripe webhook の 200 返却を妨げない。
 */
export async function autoAssignContainer(args: AutoAssignArgs): Promise<void> {
  const { env, subscriptionId, customerEmail, planKey, deviceName, triggerId } = args;

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
        { name: "trigger_id", value: triggerId },
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
        { name: "trigger_id", value: triggerId },
        { name: "status", value: String(rpcResp.status) },
        { name: "body", value: bodyStr.slice(0, 500) },
        { name: "action", value: "手動 /assign-user で復旧してください" },
      ],
    });
    return;
  }

  const rows = (Array.isArray(rpcResp.body) ? rpcResp.body : []) as AutoAssignResult[];
  const data = rows[0];

  if (!data || !data.reason) {
    // 関数仕様上は常に 1 行返るはずなので、ここに来る場合は DB の関数定義が古い等の構成不整合。
    console.error("[auto-provision] rpc returned no usable row", rpcResp.body);
    await sendDiscord(env, "critical", {
      title: "🚨 自動割当 RPC 異常レスポンス",
      fields: [
        { name: "subscription_id", value: subscriptionId },
        { name: "trigger_id", value: triggerId },
        { name: "body", value: JSON.stringify(rpcResp.body).slice(0, 500) },
        { name: "action", value: "DB 側 function 定義を確認してください" },
      ],
    });
    return;
  }

  switch (data.reason) {
    case "not_found":
      // subscription.created webhook 未着 (race)。subscription.created 側で
      // 再度 autoAssign が呼ばれるので、ここでは log のみ。
      console.log(
        `[auto-provision] sub not in DB yet (race with subscription.created): sub=${subscriptionId} trigger=${triggerId}`,
      );
      return;

    case "exhausted":
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

    case "already":
      console.log(
        `[auto-provision] already_assigned: sub=${subscriptionId} container=${data.container_name}`,
      );
      return;

    case "ok": {
      const remaining = data.remaining_pool ?? -1;
      await sendDiscord(env, "info", {
        title: "✅ コンテナ自動割当 完了",
        fields: [
          { name: "container_name", value: data.container_name ?? "(unknown)", inline: true },
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
      return;
    }

    default: {
      const _exhaustive: never = data.reason;
      console.error(`[auto-provision] unknown reason: ${_exhaustive}`);
      await sendDiscord(env, "critical", {
        title: "🚨 自動割当 RPC 不明な reason",
        fields: [
          { name: "subscription_id", value: subscriptionId },
          { name: "trigger_id", value: triggerId },
          { name: "reason", value: String(data.reason) },
          { name: "action", value: "DB function 定義を確認してください" },
        ],
      });
      return;
    }
  }
}

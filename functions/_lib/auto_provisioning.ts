import type Stripe from "stripe";
import type { Env } from "./stripe";
import { sendDiscord } from "./discord";
import { adminFetch } from "./supabase";
import { syncSubscription } from "./subscription_sync";
import { sendProvisioningEmail } from "./provisioning_email";

export type AutoAssignReason = "ok" | "already" | "not_found" | "exhausted";

interface AutoAssignResult {
  reason: AutoAssignReason;
  container_name: string | null;
  scrcpy_port: number | null;
  remaining_pool: number | null;
  user_id_assigned: string | null;
}

interface AutoAssignArgs {
  env: Env;
  stripe: Stripe;            // trial_end 凍結に使う
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
 * - reason='not_found'  → log のみ (呼出元 provisionSubscription が同期して再試行するので通知不要)
 * - reason='exhausted'  → trial_end 凍結 + mark_waitlisted + warn 通知（mark 失敗時は critical）
 * - RPC エラー          → critical
 *
 * never throw: Stripe webhook の 200 返却を妨げない。
 */
export async function autoAssignContainer(args: AutoAssignArgs): Promise<AutoAssignReason> {
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
    return "not_found";
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
    return "not_found";
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
    return "not_found";
  }

  switch (data.reason) {
    case "not_found":
      // 契約行がまだ DB に無い (webhook の到着順は保証されない)。呼出元の
      // provisionSubscription が syncSubscription してから再試行するので、ここでは log のみ。
      console.log(
        `[auto-provision] sub not in DB yet (will self-heal via syncSubscription): sub=${subscriptionId} trigger=${triggerId}`,
      );
      return "not_found";

    case "exhausted": {
      // 課金時計を凍結（trial_end を遠い未来へ）。
      const freezeDays = Number(env.WAITLIST_FREEZE_DAYS ?? "365");
      const days = Number.isFinite(freezeDays) && freezeDays > 0 ? freezeDays : 365;
      const frozenTrialEnd = Math.floor(Date.now() / 1000) + days * 86400;
      try {
        await args.stripe.subscriptions.update(subscriptionId, {
          trial_end: frozenTrialEnd,
          proration_behavior: "none",
        });
      } catch (e) {
        console.error(`[waitlist] trial_end 凍結失敗 sub=${subscriptionId}: ${e}`);
        await sendDiscord(env, "critical", {
          title: "🚨 順番待ち凍結失敗（trial_end 更新エラー）",
          fields: [
            { name: "subscription_id", value: subscriptionId },
            { name: "error", value: e instanceof Error ? e.message : String(e) },
            { name: "action", value: "手動で trial_end を延長 / コンテナ手動割当" },
          ],
        });
        return "exhausted";
      }

      // DB に待ち登録（FIFO キー）
      try {
        await adminFetch<unknown>(cfg, "/rest/v1/rpc/mark_waitlisted", {
          method: "POST",
          json: { p_subscription_id: subscriptionId },
        });
      } catch (e) {
        console.error(`[waitlist] mark_waitlisted 失敗 sub=${subscriptionId}: ${e}`);
        await sendDiscord(env, "critical", {
          title: "🚨 順番待ち DB 記録失敗（凍結済・未エンキュー）",
          fields: [
            { name: "subscription_id", value: subscriptionId },
            { name: "error", value: e instanceof Error ? e.message : String(e) },
            { name: "action", value: "trial_end は凍結済だが waitlist 未登録 → 手動で mark_waitlisted RPC 実行 or 手動割当。放置すると顧客が永久に未割当のまま" },
          ],
        });
      }

      await sendDiscord(env, "warn", {
        title: "🕒 順番待ち登録（プール枯渇）",
        fields: [
          { name: "subscription_id", value: subscriptionId },
          { name: "email", value: customerEmail ?? "(unknown)" },
          { name: "plan_key", value: planKey ?? "(unknown)" },
          { name: "action", value: "`/fill-container` で補充すれば自動で割当されます" },
        ],
      });
      return "exhausted";
    }

    case "already":
      console.log(
        `[auto-provision] already_assigned: sub=${subscriptionId} container=${data.container_name}`,
      );
      return "already";

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
      return "ok";
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
      return "not_found";
    }
  }
}

/**
 * 払い出しの唯一の窓口。カード確定 (setup_intent.succeeded) と、その安全網である
 * 支払い方法の遷移 (customer.subscription.updated) の両方からここを呼ぶ。
 * 契約作成 (customer.subscription.created) からは呼ばない ── カード入力前に発火するため。
 *
 * R1 (自己修復): Stripe の webhook は到着順が保証されないため、契約行がまだ DB に無い
 * (reason='not_found') ことがある。その場合は自分で syncSubscription して 1 度だけ再試行する。
 * これで他イベントの到着順に依存しなくなる。
 *
 * opts.emailOnAlready=false のとき、既に割当済み (reason='already') ではメールを送らない。
 * 安全網 (updated) は通常運用でも発火しうるため、Resend の冪等ウィンドウ切れによる
 * Welcome メール再送を防ぐ。
 *
 * never throw: webhook の 200 返却を妨げない。
 */
export async function provisionSubscription(
  stripe: Stripe,
  env: Env,
  sub: Stripe.Subscription,
  triggerId: string,
  opts: { emailOnAlready: boolean },
): Promise<AutoAssignReason> {
  let email: string | null = null;
  try {
    const customerId = typeof sub.customer === "string" ? sub.customer : sub.customer.id;
    const customer = await stripe.customers.retrieve(customerId);
    if (!customer.deleted) email = (customer as Stripe.Customer).email ?? null;
  } catch (e) {
    console.warn(`[auto-provision] customer lookup failed: ${e}`);
  }

  const assign = () =>
    autoAssignContainer({
      env,
      stripe,
      subscriptionId: sub.id,
      customerEmail: email,
      planKey: (sub.metadata?.plan_key as string | undefined) ?? null,
      deviceName: (sub.metadata?.device_name as string | undefined) ?? null,
      triggerId,
    });

  let reason = await assign();

  if (reason === "not_found") {
    // 契約行がまだ DB に無いだけ。自分で同期してから 1 度だけ再試行する。
    try {
      await syncSubscription(stripe, env, sub.id);
    } catch (e) {
      console.error(`[auto-provision] self-heal sync failed sub=${sub.id}: ${e}`);
    }
    reason = await assign();
    if (reason === "not_found") {
      // ここに来る経路は5通りあるが、うち4通り(Supabase 到達不能・RPC 非2xx・
      // 空/不正レスポンス・未知 reason)は autoAssignContainer 側で既に critical が
      // 鳴っている。それらの場合、断定的に「手動 /assign-user」と指示すると
      // Supabase 障害を見落として無駄な手動操作を誘発するので、切り分けを促す
      // 文言にする。supabase_user_id が unset なら subscription_sync.ts が
      // upsert を skip しているのが最頻の原因なので一次切り分け用に載せる。
      await sendDiscord(env, "critical", {
        title: "🚨 自動割当: DB 同期後も subscription が見つからない",
        fields: [
          { name: "subscription_id", value: sub.id },
          { name: "trigger_id", value: triggerId },
          {
            name: "supabase_user_id(metadata)",
            value: sub.metadata?.supabase_user_id ?? "(unset — これが原因なら DB 同期自体が skip されている)",
          },
          {
            name: "action",
            value:
              "直前に別の critical (RPC エラー/通信エラー) が出ていないか確認すること。出ていれば Supabase 障害側の対処が先。出ていなければ手動 /assign-user で復旧",
          },
        ],
      });
      return reason;
    }
  }

  if (reason === "already" && !opts.emailOnAlready) return reason;

  // メール送信の失敗で webhook を落とさない (never-throw 契約)。
  // Resend の一時障害や不正レスポンスでも割当自体は成功しているので、
  // ここで throw させて Stripe に再送させると 'already' で握り潰され
  // Welcome メールが恒久的に届かなくなる。
  try {
    await sendProvisioningEmail(stripe, env, sub, reason);
  } catch (e) {
    console.error(`[auto-provision] provisioning email failed sub=${sub.id} reason=${reason}: ${e}`);
  }
  return reason;
}
